import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Core } from './core.ts';
import type { SpeechLocal } from './speech-local.ts';
import { refused } from './errors.ts';
import { speechThreads } from './speech-server.ts';

export const WHISTLE_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl'];

/** Join overlapping audio windows without repeating their shared words. */
function append(before: string, after: string): string {
  const left = before.split(/\s+/), right = after.split(/\s+/);
  const normalize = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  for (let count = Math.min(20, left.length, right.length); count >= 2; count--) {
    if (left.slice(-count).every((word, i) => normalize(word) === normalize(right[i]!))) return [...left.slice(0, -count), ...right].join(' ').trim();
  }
  return `${before} ${after}`.trim();
}

/** Whistle accepts at most 30 seconds. Long dictation uses 25-second windows with one second of overlap. */
export async function transcribeWhistle(core: Core, local: SpeechLocal, audio: Uint8Array, language: string, signal: AbortSignal): Promise<{ text: string; language?: string }> {
  if (language && !WHISTLE_LANGUAGES.includes(language)) throw refused(`speech: Whistle supports ${WHISTLE_LANGUAGES.join(', ')}; choose one of these languages or automatic detection`);
  const id = `speech:${crypto.randomUUID()}`;
  const directory = join(local.root, id.replace(':', '-'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let text = '', heard = language;
  let child: ReturnType<Core['procs']['spawn']> | undefined;
  const abort = () => core.procs.killTree(id);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const pcm = audio.subarray(44), windowBytes = 25 * 32000;
    for (let start = 0; start < pcm.length;) {
      signal.throwIfAborted();
      const end = Math.min(pcm.length, start + windowBytes);
      const wav = new Uint8Array(44 + end - start);
      wav.set(audio.subarray(0, 44)); wav.set(pcm.subarray(start, end), 44);
      const header = new DataView(wav.buffer); header.setUint32(4, wav.length - 8, true); header.setUint32(40, wav.length - 44, true);
      const input = join(directory, 'input.wav');
      await Bun.write(input, wav);
      signal.throwIfAborted();
      child = core.procs.spawn(id, local.needle, ['--model', local.models.file('whistle'), '--audio', input, '--threads', String(Math.min(4, speechThreads())), ...(heard ? ['--audio-language', heard] : [])], { cwd: directory });
      const [code, output] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), (async () => { for await (const _chunk of child!.proc.stderr) {} })()]);
      signal.throwIfAborted();
      if (code !== 0) throw refused(`speech: Whistle exited with code ${code}; reinstall the model and runtime in Voice settings`);
      let result: { text: string; language: string };
      try { result = JSON.parse(output); if (typeof result.text !== 'string' || typeof result.language !== 'string') throw new Error(); }
      catch { throw refused('speech: Whistle returned an invalid transcript'); }
      text = append(text, result.text.trim());
      if (result.language && WHISTLE_LANGUAGES.includes(result.language)) heard ||= result.language;
      if (end === pcm.length) break;
      start = end - 32000;
    }
    return { text, ...(heard ? { language: heard } : {}) };
  } finally {
    signal.removeEventListener('abort', abort);
    if (child) { abort(); await child.exited; }
    rmSync(directory, { recursive: true, force: true });
  }
}
