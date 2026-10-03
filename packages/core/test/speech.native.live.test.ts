import { expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { startTestCore, waitFor } from './harness.ts';

function canonical(source: Buffer): Buffer {
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= source.length;) {
    const bytes = source.readUInt32LE(offset + 4);
    if (source.toString('ascii', offset, offset + 4) === 'data') pcm = source.subarray(offset + 8, offset + 8 + bytes);
    offset += 8 + bytes + bytes % 2;
  }
  if (!pcm) throw new Error('speech fixture has no PCM data');
  const audio = Buffer.alloc(44 + pcm.length);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(pcm.length, 40); pcm.copy(audio, 44);
  return audio;
}

test.skipIf(process.env.BOITE_E2E_SPEECH_NATIVE !== '1')('real local engines download verified artifacts, stream French and clean up', async () => {
  const harness = await startTestCore();
  try {
    const speech = harness.core.speech;
    speech.configure({ ...speech.get(), model: 'nemotron-streaming', language: 'fr' });
    speech.install();
    await waitFor(() => !speech.status().installing, 600_000);
    expect(speech.status().error).toBeNull(); expect(speech.status().ready).toBe(true);
    const response = await fetch('https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11/resolve/ab43d895f5985b1bbab8b6eac8607fcdc05343f3/test_wavs/fr.wav');
    expect(response.ok).toBe(true);
    const audio = canonical(Buffer.from(await response.arrayBuffer()));
    const client = await harness.connect();
    const params = { requestId: 'live', revision: speech.status().revision };
    await client.call('speech.streamStart', params);
    const started = performance.now();
    let sequence = 0, firstText = 0, bytes = 0;
    for (let offset = 44; offset < audio.length; offset += 12800) {
      const pcm = audio.subarray(offset, offset + 12800);
      const chunk = Buffer.concat([audio.subarray(0, 44), pcm]);
      chunk.writeUInt32LE(chunk.length - 8, 4); chunk.writeUInt32LE(pcm.length, 40);
      const due = (offset - 44 + pcm.length) / 32;
      await Bun.sleep(Math.max(0, due - (performance.now() - started)));
      const partial = await client.call('speech.streamChunk', { ...params, sequence: sequence++, audio: chunk.toString('base64') });
      if (partial.text && !firstText) firstText = performance.now() - started;
      bytes += pcm.length;
    }
    expect(firstText).toBeGreaterThan(0); expect(firstText).toBeLessThan((audio.length - 44) / 32);
    const stop = performance.now();
    const final = await client.call('speech.streamFinish', { ...params, sequence });
    const finishMs = performance.now() - stop;
    expect(final.text.toLowerCase()).toContain('ne vous demandez pas'); expect(final.text.toLowerCase()).toContain('pour lui');
    expect(bytes).toBe(audio.length - 44);
    console.log(`NATIVE_SPEECH_MEASURED ${JSON.stringify({ model: 'Nemotron 3.5 560 ms int8', audioSeconds: bytes / 32000, firstTextMs: Math.round(firstText), finishMs: Math.round(finishMs), pcmBytesUploaded: bytes })}`);
    speech.install({ model: 'whistle' });
    await waitFor(() => !speech.status().installing, 600_000);
    expect(speech.status().error).toBeNull(); expect(speech.status().ready).toBe(true);
    const result = await client.call('speech.transcribe', { requestId: 'whistle', revision: speech.status().revision, audio: audio.toString('base64') });
    expect(result.language).toBe('fr'); expect(result.text.toLowerCase()).toContain('pour lui');
    expect(readdirSync(speech.local.root).some(name => name.startsWith('speech-'))).toBe(false);
    await speech.uninstall();
    expect(existsSync(speech.local.models.file('whistle'))).toBe(false);
    expect(existsSync(speech.local.models.file('nemotron-streaming'))).toBe(false);
  } finally { await harness.stop(); }
}, 660_000);
