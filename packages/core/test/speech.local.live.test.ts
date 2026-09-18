import { expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { startTestCore, waitFor } from './harness.ts';

test.skipIf(process.env.BOITE_E2E_SPEECH_LOCAL !== '1')('Whisper downloads verified artifacts, transcribes speech and removes its files', async () => {
  const harness = await startTestCore();
  try {
    harness.core.speech.install();
    await waitFor(() => !harness.core.speech.status().installing, 600_000);
    expect(harness.core.speech.status().error).toBeNull();
    expect(harness.core.speech.status().ready).toBe(true);
    const response = await fetch('https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.2/samples/jfk.wav');
    expect(response.ok).toBe(true);
    const source = Buffer.from(await response.arrayBuffer());
    // Strip the upstream fixture's metadata chunks to match the browser's canonical WAV.
    let offset = 12, pcm: Buffer | null = null;
    while (offset + 8 <= source.length) {
      const length = source.readUInt32LE(offset + 4);
      if (source.toString('ascii', offset, offset + 4) === 'data') pcm = source.subarray(offset + 8, offset + 8 + length);
      offset += 8 + length + length % 2;
    }
    if (!pcm) throw new Error('upstream fixture has no PCM data');
    const audio = Buffer.alloc(44 + pcm.length);
    audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24);
    audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(pcm.length, 40); pcm.copy(audio, 44);
    const result = await harness.core.speech.transcribe('live-test', { revision: harness.core.speech.status().revision, requestId: 'fixture', audio: audio.toString('base64') });
    expect(result.text.toLowerCase()).toContain('ask not');
    expect(readdirSync(harness.core.speech.local.root).some(name => name.startsWith('speech-'))).toBe(false);
    await harness.core.speech.uninstall();
    expect(existsSync(harness.core.speech.local.model)).toBe(false);
  } finally { await harness.stop(); }
}, 660_000);
