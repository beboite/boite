import { afterEach, expect, test, vi } from 'vitest';
import type { Client } from './client';
import { SpeechStream } from './speech-stream';
import { pcmWav } from './speech-recorder';

afterEach(() => vi.restoreAllMocks());
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const wav = (count: number, value = 0.1) => pcmWav(new Float32Array(count).fill(value));

test('stream uploads each sample once and finishes with the unsent tail, without a full transcription', async () => {
  const call = vi.fn(async (method: string) => method === 'speech.streamStart' ? { ok: true } : { text: 'Bonjour le monde.' });
  const text = vi.fn();
  const stream = new SpeechStream({ call } as unknown as Client, 'revision', text, vi.fn());
  stream.update(async () => wav(6400)); await tick();
  expect(text).toHaveBeenCalledWith('Bonjour le monde.');
  const result = await stream.finish(wav(8000));
  expect(result).toBe('Bonjour le monde.');
  expect(call.mock.calls.map(call => call[0])).toEqual(['speech.streamStart', 'speech.streamChunk', 'speech.streamFinish']);
  const chunk = (call.mock.calls[1] as unknown as [string, { sequence: number; audio: string; revision: string }])[1];
  const final = (call.mock.calls[2] as unknown as [string, { sequence: number; audio: string }])[1];
  expect(chunk.sequence).toBe(0); expect(final.sequence).toBe(1); expect(chunk.revision).toBe('revision');
  expect(atob(chunk.audio).length + atob(final.audio).length - 88).toBe(16000);
  expect(new DataView(Uint8Array.from(atob(final.audio), char => char.charCodeAt(0)).buffer).getUint32(40, true)).toBe(3200);
});

test('slow decode drops ticks and finish drains the acknowledged upload before sending remaining audio', async () => {
  let resolve!: (value: { text: string }) => void;
  const call = vi.fn((method: string) => method === 'speech.streamChunk' ? new Promise(done => { resolve = done; }) : Promise.resolve({ text: 'final' }));
  const text = vi.fn();
  const stream = new SpeechStream({ call } as unknown as Client, 'revision', text, vi.fn());
  const take = vi.fn(async () => wav(6400));
  stream.update(take); stream.update(take); await tick();
  expect(take).toHaveBeenCalledOnce();
  const finished = stream.finish(wav(12800)); await tick();
  expect(call.mock.calls.map(call => call[0])).toEqual(['speech.streamStart', 'speech.streamChunk']);
  resolve({ text: 'late preview' }); await finished;
  expect(text).not.toHaveBeenCalled();
  expect(call).toHaveBeenLastCalledWith('speech.streamFinish', expect.objectContaining({ sequence: 1 }));
});

test('cancel during resampling suppresses late audio and a rejected start stays handled', async () => {
  let resolve!: (value: Uint8Array) => void;
  const call = vi.fn(async (_method: string) => ({ ok: true }));
  const stream = new SpeechStream({ call } as unknown as Client, 'revision', vi.fn(), vi.fn());
  stream.update(() => new Promise(done => { resolve = done; })); await tick();
  const stopped = stream.stop(); resolve(wav(6400)); await stopped;
  expect(call.mock.calls.map(call => call[0])).toEqual(['speech.streamStart', 'speech.cancel']);
  const error = vi.fn();
  const broken = new SpeechStream({ call: vi.fn().mockRejectedValue(new Error('load failed')) } as unknown as Client, 'revision', vi.fn(), error);
  await tick();
  expect(error).toHaveBeenCalledOnce();
  await expect(broken.finish(wav(6400))).rejects.toThrow('load failed');
});
