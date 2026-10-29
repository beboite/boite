/*
 * A stdio MCP server for the lazy MCP tests. Each start appends a line to
 * `LAZY_MCP_STARTS`. `echo` answers with its arguments, its working directory
 * and the thread it was started for; `roots` asks the client for its roots
 * and answers with what it got; `chunked` answers a few bytes at a time and
 * `flood` writes `LAZY_MCP_FLOOD` characters with no newline. Like a strict server, it refuses other
 * requests until the client says it is initialized, and answers `initialize`
 * after `LAZY_MCP_INIT_DELAY_MS`.
 */
import { appendFileSync } from 'node:fs';

const starts = process.env.LAZY_MCP_STARTS;
if (starts) appendFileSync(starts, `${process.pid}\n`);

let initialized = false;
let next = 1000;
const waiting = new Map<number, (result: unknown) => void>();
const send = (message: unknown): void => { process.stdout.write(`${JSON.stringify(message)}\n`); };

function handle(message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }): void {
  if (message.method === undefined) {
    if (typeof message.id === 'number') waiting.get(message.id)?.(message.result);
    return;
  }
  if (message.id === undefined) {
    if (message.method === 'notifications/initialized') initialized = true;
    return;
  }
  const id = message.id;
  if (!initialized && message.method !== 'initialize' && message.method !== 'ping') {
    send({ jsonrpc: '2.0', id, error: { code: -32002, message: `${message.method} before initialized` } });
    return;
  }
  switch (message.method) {
    case 'initialize':
      setTimeout(() => send({ jsonrpc: '2.0', id, result: {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fixture', version: '1.0.0' },
        instructions: 'Fixture instructions.',
      } }), Number(process.env.LAZY_MCP_INIT_DELAY_MS ?? 0));
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: [
        { name: process.env.LAZY_MCP_TOOL ?? 'echo', inputSchema: { type: 'object' } },
        { name: 'roots', inputSchema: { type: 'object' } },
      ] } });
      return;
    case 'tools/call': {
      const params = message.params ?? {};
      if (params.name === 'roots') {
        const asked = next++;
        waiting.set(asked, (result) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }));
        send({ jsonrpc: '2.0', id: asked, method: 'roots/list' });
        return;
      }
      if (params.name === 'chunked') {
        // A log line on stdout, then an answer written a few bytes at a time, characters cut in half.
        const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'h\u00e9 \u{1f600} '.repeat(50) }] } })}\n`);
        process.stdout.write('a log line, not JSON\n');
        void (async () => {
          for (let at = 0; at < bytes.length; at += 5) {
            process.stdout.write(bytes.subarray(at, at + 5));
            await Bun.sleep(1);
          }
        })();
        return;
      }
      if (params.name === 'flood') {
        // A line that never ends, and a server that stays.
        process.stdout.write('x'.repeat(Number(process.env.LAZY_MCP_FLOOD ?? 0)));
        return;
      }
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ arguments: params.arguments, cwd: process.cwd(), thread: process.env.BOITE_THREAD_ID, own: process.env.LAZY_MCP_OWN }) }] } });
      return;
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
}

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffered += chunk;
  let newline: number;
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
