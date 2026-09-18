import { expect, test, vi } from 'vitest';
import type { Client } from './client';
import { SpeechPreview } from './speech-preview';

const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const snapshot = () => Promise.resolve(new Uint8Array([1, 2]));

test('slow previews skip ticks, preserve the recording revision and publish only current text', async () => {
  let resolve!: (result: { text: string }) => void;
  const call = vi.fn(() => new Promise<{ text: string }>(done => { resolve = done; }));
  const ontext = vi.fn(), onerror = vi.fn();
  const preview = new SpeechPreview({ call } as unknown as Client, 'recording-revision', ontext, onerror);
  const take = vi.fn(snapshot);
  preview.update(take); preview.update(take); await tick();
  expect(take).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith('speech.transcribe', expect.objectContaining({ revision: 'recording-revision', audio: 'AQI=' }));
  resolve({ text: ' first words ' }); await tick();
  expect(ontext).toHaveBeenCalledWith('first words');
  preview.update(take); await tick();
  expect(call).toHaveBeenCalledTimes(2);
  resolve({ text: 'first words revised' }); await tick(); await preview.stop();
  expect(ontext).toHaveBeenLastCalledWith('first words revised');
  expect(onerror).not.toHaveBeenCalled();
});

test('stop cancels its own request and drains it before final transcription can start', async () => {
  let resolve!: (result: { text: string }) => void;
  const call = vi.fn((method: string) => method === 'speech.cancel' ? Promise.resolve({ ok: true }) : new Promise(done => { resolve = done; }));
  const ontext = vi.fn(), onerror = vi.fn();
  const preview = new SpeechPreview({ call } as unknown as Client, 'revision', ontext, onerror);
  preview.update(snapshot); await tick();
  const requestId = (call.mock.calls[0] as unknown as [string, { requestId: string }])[1].requestId;
  let drained = false;
  const stopped = preview.stop().then(() => { drained = true; }); await tick();
  expect(call).toHaveBeenLastCalledWith('speech.cancel', { requestId });
  expect(drained).toBe(false);
  resolve({ text: 'late result' }); await stopped;
  expect(ontext).not.toHaveBeenCalled();
  preview.update(snapshot); await tick(); expect(call).toHaveBeenCalledTimes(2);
  expect(onerror).not.toHaveBeenCalled();
});

test('cancellation during resampling never starts an RPC', async () => {
  let resolve!: (value: Uint8Array) => void;
  const call = vi.fn(), ontext = vi.fn();
  const preview = new SpeechPreview({ call } as unknown as Client, 'revision', ontext, vi.fn());
  preview.update(() => new Promise(done => { resolve = done; }));
  const stopped = preview.stop(); resolve(new Uint8Array([1])); await stopped;
  expect(call).not.toHaveBeenCalled(); expect(ontext).not.toHaveBeenCalled();
});

test('silence skips network work and a provider error pauses previews without repeated calls', async () => {
  const call = vi.fn().mockRejectedValue(new Error('rate limited'));
  const onerror = vi.fn();
  const preview = new SpeechPreview({ call } as unknown as Client, 'revision', vi.fn(), onerror);
  preview.update(() => Promise.resolve(null)); await tick(); expect(call).not.toHaveBeenCalled();
  preview.update(snapshot); await tick(); expect(onerror).toHaveBeenCalledOnce();
  preview.update(snapshot); await tick(); expect(call).toHaveBeenCalledOnce();
  await preview.stop();
});
