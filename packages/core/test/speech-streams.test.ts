import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../src/client.ts';
import { DEFAULT_SPEECH } from '../src/speech.ts';
import { NEMOTRON_FILES } from '../src/speech-artifacts.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore;
function wav(seconds = 0.4): string {
  const audio = Buffer.alloc(44 + Math.floor(seconds * 16000) * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio.toString('base64');
}
beforeEach(async () => {
  harness = await startTestCore();
  const local = harness.core.speech.local;
  mkdirSync(join(local.root, 'nemotron'), { recursive: true }); mkdirSync(local.nativeRuntime, { recursive: true });
  for (const file of NEMOTRON_FILES) writeFileSync(join(local.root, 'nemotron', file.file), 'fixture');
  writeFileSync(join(local.nativeRuntime, 'ready.json'), '{}');
  local.native.commandOverride = [process.execPath, join(import.meta.dir, 'fixtures/speech-native.ts')];
  harness.core.speech.configure({ ...DEFAULT_SPEECH, model: 'nemotron-streaming', language: 'fr' });
});
afterEach(async () => { await harness.stop(); });
const requests = () => readFileSync(join(harness.core.speech.local.root, 'native-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('phone streams ordered audio, sees text before finish and reuses the loaded model for another dictation', async () => {
  const owner = await harness.connect();
  const grant = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant: grant.grant });
  try {
    const revision = (await phone.call('speech.status', {})).revision;
    expect(existsSync(join(harness.core.speech.local.root, 'native-requests.jsonl'))).toBe(false);
    expect(await phone.call('speech.streamStart', { revision, requestId: 'phone' })).toEqual({ ok: true });
    expect(await thrown(owner.call('speech.streamChunk', { revision, requestId: 'phone', sequence: 0, audio: wav() }))).toThrow('on this connection');
    expect(await thrown(owner.call('speech.streamStart', { revision, requestId: 'other' }))).toThrow('another transcription');
    await owner.call('speech.cancel', { requestId: 'phone' });
    expect(await phone.call('speech.streamChunk', { revision, requestId: 'phone', sequence: 0, audio: wav() })).toEqual({ text: 'Bonjour' });
    expect(await thrown(phone.call('speech.streamChunk', { revision, requestId: 'phone', sequence: 0, audio: wav() }))).toThrow('sequence must be 1');
    expect(await phone.call('speech.streamFinish', { revision, requestId: 'phone', sequence: 1, audio: wav(0.02) })).toEqual({ text: 'Bonjour le monde.' });
    await phone.call('speech.streamStart', { revision, requestId: 'second' });
    await phone.call('speech.streamFinish', { revision, requestId: 'second', sequence: 0, audio: wav() });
    expect(requests().filter(request => request.operation === 'init')).toHaveLength(1);
    expect(requests().filter(request => request.operation === 'transcribe')).toHaveLength(0);
    expect(await thrown(phone.call('speech.configure', DEFAULT_SPEECH))).toThrow('owner only');
  } finally { phone.close(); }
});

test('stream rejects malformed, oversized and accumulated audio without consuming sequence numbers', async () => {
  const client = await harness.connect();
  const params = { requestId: 'bounds', revision: harness.core.speech.status().revision };
  await client.call('speech.streamStart', params);
  expect(await thrown(client.call('speech.streamChunk', { ...params, sequence: 0, audio: 'AAAA' }))).toThrow('PCM WAV');
  expect(await thrown(client.call('speech.streamChunk', { ...params, sequence: 0, audio: wav(2.1) }))).toThrow('two seconds');
  expect(await thrown(client.call('speech.streamChunk', { ...params, sequence: -1, audio: wav() }))).toThrow('sequence must be 0');
  await client.call('speech.streamChunk', { ...params, sequence: 0, audio: wav(1) });
  expect(await thrown(client.call('speech.streamFinish', { ...params, sequence: 1, audio: wav(120) }))).toThrow('120 seconds in total');
  await client.call('speech.streamFinish', { ...params, sequence: 1 });
});

test('disconnect, configuration changes and session expiry release the decoder reservation', async () => {
  const client = await harness.connect();
  let revision = harness.core.speech.status().revision;
  await client.call('speech.streamStart', { revision, requestId: 'disconnect' });
  client.close();
  const next = await harness.connect();
  await waitFor(() => !harness.core.procs.liveThreads().some(id => id.startsWith('speech:')));
  await next.call('speech.streamStart', { revision, requestId: 'config' });
  harness.core.speech.configure({ ...harness.core.speech.get(), language: 'en' });
  expect(await thrown(next.call('speech.streamChunk', { revision, requestId: 'config', sequence: 0, audio: wav() }))).toThrow('settings changed');
  revision = harness.core.speech.status().revision;
  await harness.core.speech.local.native.ensure(harness.core.speech.local.nativeRuntime, join(harness.core.speech.local.root, 'nemotron'));
  harness.core.speech.streams.expiresMs = 50;
  await next.call('speech.streamStart', { revision, requestId: 'expiry' });
  await Bun.sleep(100);
  expect(await thrown(next.call('speech.streamFinish', { revision, requestId: 'expiry', sequence: 0 }))).toThrow('no active stream');
  harness.core.speech.streams.expiresMs = 180_000;
  await next.call('speech.streamStart', { revision, requestId: 'again' });
  await next.call('speech.streamFinish', { revision, requestId: 'again', sequence: 0 });
});

test('a request for one model never runs on the engine a request for another model loaded meanwhile', async () => {
  const { native, nativeRuntime } = harness.core.speech.local;
  native.commandOverride!.push('--echo-model');
  await native.ensure(nativeRuntime, 'old');
  const ask = async (model: string) => {
    const engine = await native.ensure(nativeRuntime, model);
    return native.request('transcribe', {}, AbortSignal.timeout(5000), engine);
  };
  const [a, b] = await Promise.allSettled([ask('model-A'), ask('model-B')]);
  // B's start stopped A's engine while it loaded: A is refused, never answered by B.
  expect(a.status === 'rejected' ? String(a.reason) : a.value.text).toContain('cancelled');
  expect(b).toMatchObject({ status: 'fulfilled', value: { text: 'model-B' } });
}, 15_000);

test('a stream whose engine another model replaced is refused, never finished by the replacement', async () => {
  const { native, nativeRuntime } = harness.core.speech.local;
  native.commandOverride!.push('--echo-model');
  const client = await harness.connect();
  const revision = harness.core.speech.status().revision;
  await client.call('speech.streamStart', { revision, requestId: 'replaced' });
  await native.ensure(nativeRuntime, 'model-B');
  expect(await thrown(client.call('speech.streamFinish', { revision, requestId: 'replaced', sequence: 0, audio: wav() }))).toThrow('the voice model changed');
}, 15_000);

test('cancelling model load rejects the start and never delivers a late stream', async () => {
  harness.core.speech.local.native.commandOverride!.push('--slow-load');
  const client = await harness.connect();
  const revision = harness.core.speech.status().revision;
  const started = client.call('speech.streamStart', { revision, requestId: 'slow' }).catch(error => error);
  // The fixture's append creates the file before it writes the line: wait for the line.
  const log = join(harness.core.speech.local.root, 'native-requests.jsonl');
  await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('\n'));
  await client.call('speech.cancel', { requestId: 'slow' });
  expect((await started).message).toContain('cancelled');
  expect(requests().map(request => request.operation)).toEqual(['init']);
  harness.core.speech.local.native.commandOverride!.pop();
  await client.call('speech.streamStart', { revision, requestId: 'retry' });
  await client.call('speech.streamFinish', { revision, requestId: 'retry', sequence: 0 });
});
