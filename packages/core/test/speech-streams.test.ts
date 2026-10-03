import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../src/client.ts';
import { DEFAULT_SPEECH } from '../src/speech.ts';
import { NEMOTRON_FILES } from '../src/speech-artifacts.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

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
    await expect(owner.call('speech.streamChunk', { revision, requestId: 'phone', sequence: 0, audio: wav() })).rejects.toThrow('on this connection');
    await expect(owner.call('speech.streamStart', { revision, requestId: 'other' })).rejects.toThrow('another transcription');
    await owner.call('speech.cancel', { requestId: 'phone' });
    expect(await phone.call('speech.streamChunk', { revision, requestId: 'phone', sequence: 0, audio: wav() })).toEqual({ text: 'Bonjour' });
    await expect(phone.call('speech.streamChunk', { revision, requestId: 'phone', sequence: 0, audio: wav() })).rejects.toThrow('sequence must be 1');
    expect(await phone.call('speech.streamFinish', { revision, requestId: 'phone', sequence: 1, audio: wav(0.02) })).toEqual({ text: 'Bonjour le monde.' });
    await phone.call('speech.streamStart', { revision, requestId: 'second' });
    await phone.call('speech.streamFinish', { revision, requestId: 'second', sequence: 0, audio: wav() });
    expect(requests().filter(request => request.operation === 'init')).toHaveLength(1);
    expect(requests().filter(request => request.operation === 'transcribe')).toHaveLength(0);
    await expect(phone.call('speech.configure', DEFAULT_SPEECH)).rejects.toThrow('owner only');
  } finally { phone.close(); }
});

test('stream rejects malformed, oversized and accumulated audio without consuming sequence numbers', async () => {
  const client = await harness.connect();
  const params = { requestId: 'bounds', revision: harness.core.speech.status().revision };
  await client.call('speech.streamStart', params);
  await expect(client.call('speech.streamChunk', { ...params, sequence: 0, audio: 'AAAA' })).rejects.toThrow('PCM WAV');
  await expect(client.call('speech.streamChunk', { ...params, sequence: 0, audio: wav(2.1) })).rejects.toThrow('two seconds');
  await expect(client.call('speech.streamChunk', { ...params, sequence: -1, audio: wav() })).rejects.toThrow('sequence must be 0');
  await client.call('speech.streamChunk', { ...params, sequence: 0, audio: wav(1) });
  await expect(client.call('speech.streamFinish', { ...params, sequence: 1, audio: wav(120) })).rejects.toThrow('120 seconds in total');
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
  await expect(next.call('speech.streamChunk', { revision, requestId: 'config', sequence: 0, audio: wav() })).rejects.toThrow('settings changed');
  revision = harness.core.speech.status().revision;
  await harness.core.speech.local.native.ensure(harness.core.speech.local.nativeRuntime, join(harness.core.speech.local.root, 'nemotron'));
  harness.core.speech.streams.expiresMs = 50;
  await next.call('speech.streamStart', { revision, requestId: 'expiry' });
  await Bun.sleep(100);
  await expect(next.call('speech.streamFinish', { revision, requestId: 'expiry', sequence: 0 })).rejects.toThrow('no active stream');
  harness.core.speech.streams.expiresMs = 180_000;
  await next.call('speech.streamStart', { revision, requestId: 'again' });
  await next.call('speech.streamFinish', { revision, requestId: 'again', sequence: 0 });
});

test('cancelling model load rejects the start and never delivers a late stream', async () => {
  harness.core.speech.local.native.commandOverride!.push('--slow-load');
  const client = await harness.connect();
  const revision = harness.core.speech.status().revision;
  const started = client.call('speech.streamStart', { revision, requestId: 'slow' }).catch(error => error);
  await waitFor(() => existsSync(join(harness.core.speech.local.root, 'native-requests.jsonl')));
  await client.call('speech.cancel', { requestId: 'slow' });
  expect((await started).message).toContain('cancelled');
  expect(requests().map(request => request.operation)).toEqual(['init']);
  harness.core.speech.local.native.commandOverride!.pop();
  await client.call('speech.streamStart', { revision, requestId: 'retry' });
  await client.call('speech.streamFinish', { revision, requestId: 'retry', sequence: 0 });
});
