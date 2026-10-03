import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEMOTRON_FILES } from '../src/speech-artifacts.ts';
import { DEFAULT_SPEECH, decodeSpeechAudio } from '../src/speech.ts';
import { transcribeWhistle } from '../src/speech-whistle.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
let harness: TestCore;
let restore: (() => void) | undefined;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { restore?.(); restore = undefined; await harness.stop(); });

test('a partial multi-file model stays unavailable until retry completes all components, and removal deletes every file', async () => {
  const speech = harness.core.speech, local = speech.local;
  if (!local.canInstallModel('nemotron-streaming')) return;
  mkdirSync(local.nativeRuntime, { recursive: true });
  writeFileSync(join(local.nativeRuntime, 'ready.json'), '{}');
  const urls: string[] = [];
  let fail = true;
  const download = spyOn(local, 'download' as any).mockImplementation(async (spec: any, target: string) => {
    urls.push(spec.url);
    if (fail && spec.file === 'decoder.int8.onnx') throw new Error('fixture disconnect');
    writeFileSync(target, 'fixture');
  });
  restore = () => download.mockRestore();
  speech.install({ model: 'nemotron-streaming' });
  await waitFor(() => !local.installing);
  expect(speech.status().ready).toBe(false);
  expect(speech.status().models.find(model => model.id === 'nemotron-streaming')?.installed).toBe(false);
  fail = false;
  speech.install({ model: 'nemotron-streaming' });
  await waitFor(() => !local.installing);
  expect(urls.filter(url => url.endsWith('/encoder.int8.onnx'))).toHaveLength(1);
  expect(speech.status().ready).toBe(true);
  expect(speech.status().streaming).toBe(true);
  for (const file of NEMOTRON_FILES) expect(existsSync(join(local.root, 'nemotron', file.file))).toBe(true);
  await speech.uninstall({ model: 'nemotron-streaming' });
  expect(existsSync(join(local.root, 'nemotron'))).toBe(false);
  for (const file of ['bindings.tgz', 'native.tgz.part', 'native.tgz.part.json']) writeFileSync(join(local.root, file), 'fixture');
  await speech.uninstall({});
  for (const file of ['bindings.tgz', 'native.tgz.part', 'native.tgz.part.json']) expect(existsSync(join(local.root, file))).toBe(false);
});

test('Whistle splits long audio, keeps the final samples, joins overlapping words and closes its processes', async () => {
  const local = harness.core.speech.local;
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const injected = spyOn(harness.core.procs, 'spawn').mockImplementation((id, _exe, args, options) => spawn(id, process.execPath, [join(import.meta.dir, 'fixtures/speech-whistle.ts'), ...args], options));
  restore = () => injected.mockRestore();
  const audio = Buffer.alloc(44 + 31 * 32000);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40); audio[audio.length - 1] = 71;
  const canonical = decodeSpeechAudio(audio.toString('base64'));
  expect(await transcribeWhistle(harness.core, local, canonical, 'fr', new AbortController().signal)).toEqual({ text: 'Voici une phrase avec des mots communs et la fin.', language: 'fr' });
  const windows = readFileSync(join(local.root, 'whistle-windows.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(windows.map(window => window.bytes)).toEqual([44 + 25 * 32000, 44 + 7 * 32000]);
  expect(windows[1].final).toBe(71);
  expect(harness.core.procs.liveThreads().some(id => id.startsWith('speech:'))).toBe(false);
  await expect(transcribeWhistle(harness.core, local, canonical, 'ja', new AbortController().signal)).rejects.toThrow('Whistle supports');
});

test('new configuration defaults to streaming while explicitly selected Whisper stays selected', () => {
  expect(harness.core.speech.get().model).toBe('nemotron-streaming');
  harness.core.speech.configure({ ...DEFAULT_SPEECH, model: 'small-q5_1' });
  expect(harness.core.speech.get().model).toBe('small-q5_1');
});
