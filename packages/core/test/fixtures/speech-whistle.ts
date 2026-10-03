import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const input = process.argv[process.argv.indexOf('--audio') + 1]!;
const audio = new Uint8Array(await Bun.file(input).arrayBuffer());
appendFileSync(join(process.cwd(), '..', 'whistle-windows.jsonl'), `${JSON.stringify({ bytes: audio.length, final: audio.at(-1) })}\n`);
console.log(JSON.stringify({ text: audio.length > 800_000 ? 'Voici une phrase avec des mots communs.' : 'des mots communs et la fin.', language: 'fr' }));
