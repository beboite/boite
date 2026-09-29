/**
 * A fake whisper.cpp `whisper-server`, run as `bun <this file> <its flags>`:
 * it takes `-m`, `-t`, `--host`, `--port` and `--request-path` like the real
 * one, reads the model file before it listens, answers `/health` and
 * `/inference` only under the request path, and appends one JSON line per
 * inference to `<model>.log` with its pid and the form fields it received.
 * A model file that starts with `broken` makes it fail to load, as a wrong
 * file makes the real server exit.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const flags = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index]!;
  if (flag.startsWith('-') && process.argv[index + 1] !== undefined && !process.argv[index + 1]!.startsWith('-')) flags.set(flag, process.argv[++index]!);
  else flags.set(flag, '');
}
const model = flags.get('-m') ?? '';
const path = flags.get('--request-path') ?? '';

await Bun.sleep(80); // the model loads before the port opens
if (readFileSync(model, 'utf8').startsWith('broken')) {
  console.error('whisper_init_from_file_with_params_no_state: failed to load model');
  process.exit(1);
}

Bun.serve({
  hostname: flags.get('--host') ?? '127.0.0.1',
  port: Number(flags.get('--port')),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === `${path}/health`) return Response.json({ status: 'ok' });
    if (url.pathname !== `${path}/inference` || request.method !== 'POST') return new Response('Not Found', { status: 404 });
    const form = await request.formData();
    const file = form.get('file');
    const fields: Record<string, unknown> = { pid: process.pid, threads: flags.get('-t'), bytes: file instanceof Blob ? file.size : 0 };
    for (const key of ['language', 'audio_ctx', 'response_format', 'no_timestamps', 'no_language_probabilities']) fields[key] = form.get(key);
    appendFileSync(`${model}.log`, `${JSON.stringify(fields)}\n`);
    const language = form.get('language');
    return Response.json({ text: ' Bonjour\n tout le monde.', language: language === 'auto' ? 'french' : language });
  },
});
