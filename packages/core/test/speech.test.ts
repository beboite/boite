import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { connect } from '../src/client.ts';
import { DEFAULT_SPEECH, decodeSpeechAudio, SpeechStore } from '../src/speech.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore;
const stubFetch = (callback: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) => spyOn(globalThis, 'fetch').mockImplementation(callback as typeof fetch);
let fetchSpy: ReturnType<typeof spyOn> | undefined;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { fetchSpy?.mockRestore(); fetchSpy = undefined; await harness.stop(); });

export function testWav(): string {
  const bytes = Buffer.alloc(32044);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(32000, 40);
  return bytes.toString('base64');
}

test('speech accepts bounded PCM and refuses malformed headers, base64 and oversized recordings', () => {
  expect(decodeSpeechAudio(testWav()).length).toBe(32044);
  for (const value of ['', 'broken!', 'AAAA', null, 'a'.repeat(5_200_000)]) expect(() => decodeSpeechAudio(value)).toThrow();
  const corrupt = Buffer.from(testWav(), 'base64'); corrupt.writeUInt32LE(48000, 24);
  expect(() => decodeSpeechAudio(corrupt.toString('base64'))).toThrow('16 kHz');
});

test('configuration never returns keys or journals them, preserves and removes keys explicitly', async () => {
  const client = await harness.connect();
  const config = { ...DEFAULT_SPEECH, engine: 'api' as const };
  const status = await client.call('speech.configure', { ...config, groqKey: 'fixture-secret' });
  expect(status.ready).toBe(true);
  expect(JSON.stringify(status)).not.toContain('fixture-secret');
  expect(await client.call('speech.config', {})).toEqual(config);
  expect((await client.call('speech.configure', config)).groqKeySet).toBe(true);
  expect(JSON.stringify(await client.call('settings.get', {}))).not.toContain('fixture-secret');
  expect(harness.core.journal.getSetting('speech')).toBeUndefined();
  expect((await client.call('speech.configure', { ...config, groqKey: '' })).ready).toBe(false);
  expect(readFileSync(join(harness.dataDir, 'speech.json'), 'utf8')).not.toContain('fixture-secret');
  await expect(client.call('speech.configure', { ...config, executable: 'relative.exe' })).rejects.toThrow('absolute path');
});

test('paired phone transcribes on the core but cannot read config, change keys or install a runtime', async () => {
  const owner = await harness.connect();
  await owner.call('speech.configure', { ...DEFAULT_SPEECH, engine: 'api', groqKey: 'fixture-key' });
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant });
  fetchSpy = stubFetch(async (_url, init) => {
    expect(init?.headers).toEqual({ Authorization: 'Bearer fixture-key' });
    const body = init?.body as FormData;
    expect(body.get('model')).toBe('whisper-large-v3-turbo');
    expect((body.get('file') as Blob).size).toBe(32044);
    return Response.json({ text: 'Bonjour depuis le téléphone.' });
  });
  try {
    expect((await phone.call('speech.status', {})).ready).toBe(true);
    await expect(phone.call('speech.config', {})).rejects.toThrow('owner only');
    await expect(phone.call('speech.configure', DEFAULT_SPEECH)).rejects.toThrow('owner only');
    await expect(phone.call('speech.install', {})).rejects.toThrow('owner only');
    await expect(phone.call('speech.uninstall', {})).rejects.toThrow('owner only');
    expect(await phone.call('speech.warm', {})).toEqual({ ok: true });
    expect(await phone.call('speech.transcribe', { revision: harness.core.speech.status().revision, requestId: 'phone', audio: testWav() })).toEqual({ text: 'Bonjour depuis le téléphone.' });
    expect(existsSync(join(harness.dataDir, 'speech'))).toBe(false);
  } finally { phone.close(); }
});

test('API fallback uses the other key and OpenRouter JSON format, without leaking provider error bodies', async () => {
  harness.core.speech.configure({ ...DEFAULT_SPEECH, engine: 'api', language: 'fr', fallback: true, groqKey: 'groq-fixture', openrouterKey: 'router-fixture' });
  let calls = 0;
  fetchSpy = stubFetch(async (url, init) => {
    calls++;
    if (String(url).includes('groq')) return new Response('private provider details', { status: 429 });
    expect(init?.headers).toEqual({ Authorization: 'Bearer router-fixture', 'Content-Type': 'application/json' });
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe('openai/whisper-large-v3-turbo'); expect(body.language).toBe('fr'); expect(body.input_audio.format).toBe('wav');
    return Response.json({ text: 'Repli réussi.' });
  });
  expect((await harness.core.speech.transcribe('one', { revision: harness.core.speech.status().revision, requestId: 'a', audio: testWav() })).text).toBe('Repli réussi.');
  expect(calls).toBe(2);
  harness.core.speech.configure({ ...DEFAULT_SPEECH, engine: 'api' });
  await expect(harness.core.speech.transcribe('one', { revision: harness.core.speech.status().revision, requestId: 'b', audio: testWav() })).rejects.toThrow('HTTP 429');
  expect(calls).toBe(3);
});

test('cancel is scoped to the connection and request; disconnect aborts in-flight work', async () => {
  harness.core.speech.configure({ ...DEFAULT_SPEECH, engine: 'api', groqKey: 'fixture' });
  let aborted = false, started = false;
  fetchSpy = stubFetch((_url, init) => new Promise((_resolve, reject) => {
    started = true;
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }));
  const result = harness.core.speech.transcribe('one', { revision: harness.core.speech.status().revision, requestId: 'a', audio: testWav() });
  const checked = result.catch(error => error);
  harness.core.speech.cancel('other', 'a'); harness.core.speech.cancel('one', 'old');
  expect(aborted).toBe(false);
  await expect(harness.core.speech.transcribe('one', { revision: harness.core.speech.status().revision, requestId: 'b', audio: testWav() })).rejects.toThrow('another transcription');
  harness.core.speech.cancel('one', 'a'); expect((await checked).message).toContain('cancelled');
  started = false; aborted = false;
  const client = await harness.connect();
  const request = client.call('speech.transcribe', { revision: harness.core.speech.status().revision, requestId: 'wire', audio: testWav() }).catch(() => {});
  await waitFor(() => started); client.close(); await waitFor(() => aborted); await request;
});

test('local mode never falls back to an API when unconfigured', async () => {
  harness.core.speech.configure({ ...DEFAULT_SPEECH, fallback: true, groqKey: 'fixture', openrouterKey: 'fixture' });
  fetchSpy = spyOn(globalThis, 'fetch');
  await expect(harness.core.speech.transcribe('one', { revision: harness.core.speech.status().revision, requestId: 'a', audio: testWav() })).rejects.toThrow('configure');
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('changing engines invalidates recordings made under the previous privacy choice', async () => {
  const revision = harness.core.speech.status().revision;
  harness.core.speech.configure({ ...DEFAULT_SPEECH, engine: 'api', groqKey: 'fixture' });
  fetchSpy = spyOn(globalThis, 'fetch');
  await expect(harness.core.speech.transcribe('one', { revision, requestId: 'old-recording', audio: testWav() })).rejects.toThrow('settings changed');
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('a failed download rename removes the partial file and preserves the destination', async () => {
  const target = join(harness.dataDir, 'blocked-model');
  mkdirSync(target);
  const bytes = Buffer.from('verified model fixture');
  fetchSpy = stubFetch(async () => new Response(bytes));
  const spec = { url: 'https://fixture.invalid/model', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await expect(harness.core.speech.local['download'](spec, target, new AbortController().signal)).rejects.toThrow();
  expect(existsSync(target)).toBe(true);
  expect(existsSync(`${target}.part`)).toBe(false);
});

test.each(['{"groqKey":"private-fixture",', '{"engine":"invalid","groqKey":"private-fixture"}'])('invalid persisted speech config stays repairable without leaking or overwriting it: %s', async raw => {
  const file = join(harness.dataDir, 'speech.json');
  writeFileSync(file, raw);
  const loaded = new SpeechStore(harness.core);
  try {
    expect(loaded.get()).toEqual(DEFAULT_SPEECH);
    expect(loaded.status().ready).toBe(false);
    expect(loaded.status().error).toContain('speech.json');
    expect(JSON.stringify(loaded.status())).not.toContain('private-fixture');
    expect(readFileSync(file, 'utf8')).toBe(raw);
    expect(loaded.configure({ ...DEFAULT_SPEECH, engine: 'api', groqKey: 'repaired-fixture' }).ready).toBe(true);
    expect(loaded.status().error).toBeNull();
  } finally { await loaded.close(); }
});

describe('a local speech download on a bad connection', () => {
  const body = new Uint8Array(256 * 1024).map((_, index) => (index * 7) % 253);
  const half = body.byteLength / 2;
  const spec = { url: '', bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') };
  let server: ReturnType<typeof Bun.serve>;
  let ranges: (string | null)[] = [];
  let ifRanges: (string | null)[] = [];
  let next: 'resume' | 'whole' = 'resume';
  let first: 'drop' | 'stall' = 'drop';

  beforeEach(() => {
    ranges = [];
    ifRanges = [];
    next = 'resume';
    first = 'drop';
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const range = request.headers.get('range');
        ranges.push(range);
        ifRanges.push(request.headers.get('if-range'));
        if (ranges.length === 1) {
          const end = first;
          return new Response(new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(body.slice(0, half));
              if (end === 'stall') return;
              // The drop waits for the half on disk: a body that errors discards
              // what its reader has not taken yet, and a slow runner would keep less.
              await waitFor(() => existsSync(part) && statSync(part).size >= half).catch(() => {});
              // No reason: the socket drops all the same, with nothing for Bun to log.
              controller.error(undefined);
            },
          }), { headers: { 'content-length': String(body.byteLength), etag: '"model-1"' } });
        }
        const from = Number(/^bytes=(\d+)-$/.exec(range ?? '')?.[1] ?? Number.NaN);
        if (next === 'whole' || Number.isNaN(from)) return new Response(body);
        return new Response(body.slice(from), {
          status: 206,
          headers: { 'content-range': `bytes ${from}-${body.byteLength - 1}/${body.byteLength}` },
        });
      },
    });
    spec.url = `http://127.0.0.1:${server.port}/model.bin`;
  });
  afterEach(() => { server.stop(true); });

  let part = '';
  const download = (target: string) => {
    part = `${target}.part`;
    return harness.core.speech.local['download'](spec, target, new AbortController().signal);
  };

  test('a dropped connection keeps what it got, and the next download resumes from there', async () => {
    const target = join(harness.dataDir, 'model.bin');
    const failed = await download(target).then(() => null, (error: Error) => error);
    expect(failed?.message).toContain('install again to resume');
    expect(failed?.message).not.toContain('verbose');
    expect(statSync(`${target}.part`).size).toBe(half);

    await download(target);
    expect(ranges).toEqual([null, `bytes=${half}-`]);
    // The file the bytes came from is named, so a changed one would come whole.
    expect(ifRanges).toEqual([null, '"model-1"']);
    expect(existsSync(`${target}.part.json`)).toBe(false);
    expect(new Uint8Array(readFileSync(target))).toEqual(body);
    expect(existsSync(`${target}.part`)).toBe(false);
  });

  test('a server that ignores the range sends the whole file, and the download starts over cleanly', async () => {
    const target = join(harness.dataDir, 'model.bin');
    await download(target).catch(() => {});
    next = 'whole';
    await download(target);
    expect(ranges[1]).toBe(`bytes=${half}-`);
    expect(new Uint8Array(readFileSync(target))).toEqual(body);
  });

  test('a part kept for another file is never resumed: a build that pins another model downloads it whole', async () => {
    const target = join(harness.dataDir, 'model.bin');
    await download(target).catch(() => {});
    expect(statSync(`${target}.part`).size).toBe(half);
    const other = { ...spec, url: `${spec.url}?release=2` };
    await harness.core.speech.local['download'](other, target, new AbortController().signal);
    expect(ranges).toEqual([null, null]);
    expect(new Uint8Array(readFileSync(target))).toEqual(body);
  });

  test('a part with no record of where it came from is not resumed either', async () => {
    const target = join(harness.dataDir, 'model.bin');
    await download(target).catch(() => {});
    rmSync(`${target}.part.json`);
    await download(target);
    expect(ranges).toEqual([null, null]);
    expect(new Uint8Array(readFileSync(target))).toEqual(body);
  });

  test('a stalled download fails after the idle wait instead of a total deadline, and keeps its bytes', async () => {
    const target = join(harness.dataDir, 'model.bin');
    first = 'stall';
    harness.core.speech.local.stallMs = 300;
    const started = Date.now();
    const failed = await download(target).then(() => null, (error: Error) => error);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(failed?.message).toContain('no data');
    expect(statSync(`${target}.part`).size).toBe(half);
  });
});

/** A runtime that holds both programs, so an install fetches only the model. */
function fakeRuntime(): void {
  const runtime = join(harness.core.speech.local.root, 'runtime');
  mkdirSync(runtime, { recursive: true });
  for (const file of ['whisper-cli.exe', 'whisper-server.exe']) writeFileSync(join(runtime, file), 'fixture');
}

test('installing again after a failed model download does not fetch the runtime it already has', async () => {
  const local = harness.core.speech.local;
  if (!local.canInstallRuntime) return;
  fakeRuntime();
  const urls: string[] = [];
  fetchSpy = stubFetch(async (url) => { urls.push(String(url)); return new Response('gone', { status: 404 }); });
  harness.core.speech.install();
  await waitFor(() => !local.installing);
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain('ggml-small');
});

test('a runtime without whisper-server still transcribes and is offered again for the resident engine', () => {
  const local = harness.core.speech.local;
  if (!local.canInstallRuntime) return;
  mkdirSync(join(local.root, 'runtime'), { recursive: true });
  writeFileSync(join(local.root, 'runtime', 'whisper-cli.exe'), 'fixture');
  expect(harness.core.speech.status().runtimeOutdated).toBe(true);
  expect(local.serverCommand('')).toBeNull();
  writeFileSync(join(local.root, 'runtime', 'whisper-server.exe'), 'fixture');
  expect(harness.core.speech.status().runtimeOutdated).toBe(false);
  expect(local.serverCommand('')).toEqual([join(local.root, 'runtime', 'whisper-server.exe')]);
});

describe('the model choice', () => {
  /** The 48 bytes whisper.cpp reads first, then some weights. */
  function ggml(options: { magic?: number; audioCtx?: number; mels?: number } = {}): Uint8Array {
    const bytes = new Uint8Array(4096);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, options.magic ?? 0x67676d6c, true);
    const header = [51865, options.audioCtx ?? 1500, 384, 6, 4, 448, 384, 6, 4, options.mels ?? 80, 1];
    header.forEach((value, index) => view.setInt32(4 + index * 4, value, true));
    return bytes;
  }
  const files: Record<string, () => Response> = {
    '/ggml-tiny-fixture.bin': () => new Response(ggml(), { headers: { 'content-length': '4096' } }),
    '/ggerganov/whisper.cpp/blob/main/ggml-tiny.bin': () => new Response(`<!doctype html><html><head><title>ggml-tiny.bin</title></head>${' '.repeat(4000)}</html>`),
    '/model.gguf': () => new Response(ggml({ magic: 0x46554747 })),
    '/ggml-silero-vad.bin': () => new Response(ggml({ audioCtx: 512 })),
  };
  let urls: string[] = [];
  beforeEach(() => {
    urls = [];
    fakeRuntime();
    fetchSpy = stubFetch(async (url) => {
      urls.push(String(url));
      const file = files[new URL(String(url)).pathname];
      return file ? file() : new Response('gone', { status: 404 });
    });
  });

  test('a link downloads a checked Whisper file, becomes the model in use, and removing it goes back to the default', async () => {
    const speech = harness.core.speech;
    await expect(Promise.resolve().then(() => speech.install({ url: 'http://models.example/ggml-tiny-fixture.bin' }))).rejects.toThrow('https://');
    await expect(Promise.resolve().then(() => speech.install({ url: 'https://user:pass@models.example/ggml-tiny-fixture.bin' }))).rejects.toThrow('without a user name');
    expect(urls).toHaveLength(0);
    const url = 'https://models.example/ggml-tiny-fixture.bin';
    const started = speech.install({ url });
    expect(started.downloading).toMatch(/^custom-[a-f0-9]{12}$/);
    expect(started.models.at(-1)).toMatchObject({ kind: 'custom', name: 'ggml-tiny-fixture.bin', host: 'models.example' });
    await waitFor(() => !speech.local.installing);
    const status = speech.status();
    expect(status.error).toBeNull();
    const custom = status.models.find(model => model.kind === 'custom')!;
    expect(custom).toEqual({ id: started.downloading!, kind: 'custom', name: 'ggml-tiny-fixture.bin', bytes: 4096, host: 'models.example', installed: true });
    expect(speech.get().model).toBe(custom.id);
    // The link stays on the core; a status carries only its host.
    expect(JSON.stringify(status)).not.toContain(url);
    const removed = await speech.uninstall({ model: custom.id });
    expect(removed.models.some(model => model.kind === 'custom')).toBe(false);
    expect(speech.get().model).toBe('small-q5_1');
    expect(existsSync(join(speech.local.models.customDir, `${custom.id}.bin`))).toBe(false);
  });

  test.each([
    ['https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-tiny.bin', 'web page'],
    ['https://models.example/model.gguf', 'GGUF'],
    ['https://models.example/ggml-silero-vad.bin', 'not a Whisper model'],
    ['https://models.example/missing.bin', 'HTTP 404'],
  ])('a link that is not a Whisper model is refused and leaves no row: %s', async (url, reason) => {
    const speech = harness.core.speech;
    speech.install({ url });
    await waitFor(() => !speech.local.installing);
    expect(speech.status().error).toContain(reason);
    expect(speech.status().models.some(model => model.kind === 'custom')).toBe(false);
    expect(speech.get().model).toBe('small-q5_1');
  });

  test('a catalogue model downloads from its pinned file; an unknown one is refused with the choices', async () => {
    const speech = harness.core.speech;
    expect(() => speech.install({ model: 'ggml-small' })).toThrow('speech.model must be one of base-q5_1, small-q5_1, large-v3-turbo-q5_0');
    expect(() => speech.install({ model: 'custom-000000000000' })).toThrow('not a model on this core');
    expect(() => speech.install({ model: 'base-q5_1', url: 'https://models.example/ggml-tiny-fixture.bin' })).toThrow('either model or url');
    speech.install({ model: 'base-q5_1' });
    expect(speech.status().totalBytes).toBe(59707625);
    await waitFor(() => !speech.local.installing);
    expect(urls).toEqual(['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin']);
    expect(speech.get().model).toBe('small-q5_1');
  });

  test('removing the model in use hands over to another one already here', async () => {
    const speech = harness.core.speech;
    const { root } = speech.local;
    for (const file of ['ggml-base-q5_1.bin', 'ggml-small-q5_1.bin']) writeFileSync(join(root, file), 'fixture');
    speech.configure({ ...DEFAULT_SPEECH, model: 'small-q5_1' });
    const revision = speech.status().revision;
    const status = await speech.uninstall({ model: 'small-q5_1' });
    expect(existsSync(join(root, 'ggml-small-q5_1.bin'))).toBe(false);
    expect(existsSync(join(root, 'ggml-base-q5_1.bin'))).toBe(true);
    expect(speech.get().model).toBe('base-q5_1');
    expect(status.revision).not.toBe(revision);
    expect(status.models.filter(model => model.installed).map(model => model.id)).toEqual(['base-q5_1']);
    // Choosing a model already here needs no download.
    expect(speech.install({ model: 'base-q5_1' }).installing).toBe(false);
    expect(urls).toHaveLength(0);
  });

  test('a speech.json from before the model choice keeps Whisper Small', async () => {
    const saved = { engine: 'local', language: '', apiProvider: 'groq', fallback: false, executable: '', modelPath: '' };
    writeFileSync(join(harness.dataDir, 'speech.json'), JSON.stringify(saved));
    const loaded = new SpeechStore(harness.core);
    try {
      expect(loaded.get()).toEqual({ ...saved, model: 'small-q5_1' } as typeof DEFAULT_SPEECH);
      expect(loaded.status().error).toBeNull();
    } finally { await loaded.close(); }
  });
});

describe('the resident whisper-server', () => {
  let model: string;
  const log = () => readFileSync(`${model}.log`, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, string | number | null>);
  const request = (id: string, extra: { preview?: boolean; language?: string } = {}) =>
    harness.core.speech.transcribe('one', { revision: harness.core.speech.status().revision, requestId: id, audio: testWav(), ...extra });

  beforeEach(() => {
    model = join(harness.dataDir, 'fixture-model.bin');
    writeFileSync(model, 'fixture model');
    harness.core.speech.local.serverOverride = [process.execPath, join(import.meta.dir, 'fixtures', 'whisper-server.ts')];
    harness.core.speech.configure({ ...DEFAULT_SPEECH, executable: process.execPath, modelPath: model });
  });

  test('a warm loads the model once; previews and the final request reuse it, the final one with the language a preview heard', async () => {
    const { server } = harness.core.speech.local;
    const client = await harness.connect();
    expect(await client.call('speech.warm', {})).toEqual({ ok: true });
    client.close();
    await waitFor(() => server.running);
    expect(await request('preview', { preview: true })).toEqual({ text: 'Bonjour tout le monde.', language: 'french' });
    expect(await request('final', { language: 'french' })).toEqual({ text: 'Bonjour tout le monde.', language: 'french' });
    const [preview, final] = log();
    expect(preview).toMatchObject({ language: 'auto', audio_ctx: String(Math.ceil(1 * 50) + 64), response_format: 'verbose_json', no_language_probabilities: 'true', bytes: 32044 });
    expect(final).toMatchObject({ language: 'french', audio_ctx: null });
    expect(final!.pid).toBe(preview!.pid);
    expect(Number(preview!.threads)).toBeGreaterThanOrEqual(1);
    await expect(request('bad', { language: 'fr-FR' })).rejects.toThrow('speech.language');
  });

  test('a configured language wins over what a preview heard', async () => {
    harness.core.speech.configure({ ...DEFAULT_SPEECH, language: 'en', executable: process.execPath, modelPath: model });
    await request('final', { language: 'french' });
    expect(log()[0]).toMatchObject({ language: 'en' });
  });

  test('the server stops when the model changes, after its idle wait, and on close; a bad model says so', async () => {
    const speech = harness.core.speech;
    const { server } = speech.local;
    await request('one');
    expect(server.running).toBe(true);
    const other = join(harness.dataDir, 'other-model.bin');
    writeFileSync(other, 'fixture model');
    speech.configure({ ...DEFAULT_SPEECH, executable: process.execPath, modelPath: other });
    await waitFor(() => !server.running);
    // Shorter than the fixture's own load: the wait counts from the loaded model,
    // or a slow start would be stopped halfway through it.
    server.idleMs = 40;
    model = other;
    await request('two');
    expect(server.running).toBe(true);
    await waitFor(() => !server.running, 5_000);
    const broken = join(harness.dataDir, 'broken-model.bin');
    writeFileSync(broken, 'broken fixture');
    speech.configure({ ...DEFAULT_SPEECH, executable: process.execPath, modelPath: broken });
    await expect(request('three')).rejects.toThrow('could not load broken-model.bin');
    expect(server.running).toBe(false);
  });
});
