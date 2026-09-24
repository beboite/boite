import { readFileSync } from 'node:fs';

// The control file belongs to one local benchmark service. Its ephemeral token
// stays inside this process and is never included in command-line arguments.
const path = process.env.BOITE_BENCH_CONTROL;
if (!path) throw new Error('Set BOITE_BENCH_CONTROL to the service control.json file.');
const control = JSON.parse(readFileSync(path, 'utf8')) as { url: string; token: string };
const url = new URL(control.url);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('control.url must name the local HTTP benchmark service.');
const endpoint = process.argv[2] ?? 'status';
if (!['start', 'command', 'finish', 'status', 'shutdown'].includes(endpoint)) throw new Error('Expected start, command, finish, status or shutdown.');
const argument = process.argv[3];
const body: unknown = argument ? JSON.parse(argument.startsWith('@') ? readFileSync(argument.slice(1), 'utf8') : argument) : {};
const response = await fetch(`${control.url}/${endpoint}`, {
  method: 'POST', headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(150_000),
});
console.log(JSON.stringify(await response.json()));
if (!response.ok) process.exitCode = 1;
