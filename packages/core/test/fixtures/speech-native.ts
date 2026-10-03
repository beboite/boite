import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

let chunks = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(join(process.cwd(), 'native-requests.jsonl'), `${JSON.stringify({ operation: request.operation, audioBytes: request.audio ? Buffer.from(request.audio, 'base64').length : 0 })}\n`);
  if (request.operation === 'init' && process.argv.includes('--slow-load')) await Bun.sleep(200);
  if (request.operation === 'chunk' && process.argv.includes('--slow-decode')) await Bun.sleep(200);
  if (request.operation === 'start') chunks = 0;
  if (request.operation === 'chunk') chunks++;
  const result = request.operation === 'init' || request.operation === 'start' ? { ok: true }
    : { text: request.operation === 'chunk' && chunks === 1 ? 'Bonjour' : 'Bonjour le monde.' };
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
}
