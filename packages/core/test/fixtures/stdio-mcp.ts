/*
 * A stdio MCP server for the lazy MCP tests. Each start appends a line to
 * `LAZY_MCP_STARTS`. `echo` answers with its arguments, its working directory
 * and the thread it was started for; `roots` asks the client for its roots
 * and answers with what it got.
 */
import { appendFileSync } from 'node:fs';

const starts = process.env.LAZY_MCP_STARTS;
if (starts) appendFileSync(starts, `${process.pid}\n`);

let next = 1000;
const waiting = new Map<number, (result: unknown) => void>();
const send = (message: unknown): void => { process.stdout.write(`${JSON.stringify(message)}\n`); };

function handle(message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }): void {
  if (message.method === undefined) {
    if (typeof message.id === 'number') waiting.get(message.id)?.(message.result);
    return;
  }
  if (message.id === undefined) return;
  const id = message.id;
  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fixture', version: '1.0.0' },
        instructions: 'Fixture instructions.',
      } });
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
