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
              await Bun.sleep(50);
              controller.error(new Error('the test server drops the connection'));
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

  const download = (target: string) => harness.core.speech.local['download'](spec, target, new AbortController().signal);

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

test('installing again after a failed model download does not fetch the runtime it already has', async () => {
  const local = harness.core.speech.local;
  if (!local.canInstallRuntime) return;
  mkdirSync(join(local.root, 'runtime'), { recursive: true });
  writeFileSync(join(local.root, 'runtime', 'whisper-cli.exe'), 'fixture');
  const urls: string[] = [];
  fetchSpy = stubFetch(async (url) => { urls.push(String(url)); return new Response('gone', { status: 404 }); });
  local.start();
  await waitFor(() => !local.installing);
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain('ggml-small');
});
