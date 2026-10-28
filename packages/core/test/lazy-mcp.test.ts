import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fingerprintOf, LAZY_MCP_ROUTE, userStdioServers, type StdioServer } from '../src/mcp/lazy.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { await harness.stop(); });

const FIXTURE = resolve(import.meta.dir, 'fixtures', 'stdio-mcp.ts');
const INIT = { protocolVersion: '2025-11-25', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'test', version: '1' } };

interface Answer { status: number; session: string | null; messages: Record<string, any>[] }

/** Every message of an answer, JSON or a whole event stream. */
async function post(url: string, token: string, body: unknown, session: string | null = null): Promise<Answer> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const type = response.headers.get('content-type') ?? '';
  const messages = type.includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    : type.includes('application/json') ? [JSON.parse(text)].flat() : [];
  return { status: response.status, session: response.headers.get('mcp-session-id'), messages };
}

/** The client's GET stream: the messages it has received so far. */
function listen(url: string, token: string, session: string): { messages: Record<string, any>[]; close(): void } {
  const controller = new AbortController();
  const messages: Record<string, any>[] = [];
  void fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'mcp-session-id': session }, signal: controller.signal }).then(async (response) => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const event = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        for (const line of event.split('\n')) if (line.startsWith('data: ')) messages.push(JSON.parse(line.slice(6)));
      }
    }
  }).catch(() => undefined);
  return { messages, close: () => controller.abort() };
}

function starts(file: string): number {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
}

test('a session gets its servers from what they answered before, and starts one on its first call', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const token = harness.core.agents.tokenFor(threadId as never);
  const cwd = join(harness.dataDir, 'work');
  mkdirSync(cwd, { recursive: true });
  const startsFile = join(harness.dataDir, 'starts.txt');
  const server: StdioServer = { command: process.execPath, args: [FIXTURE], env: { LAZY_MCP_STARTS: startsFile, LAZY_MCP_OWN: 'own', LAZY_MCP_INIT_DELAY_MS: '1000' } };
  const servers = new Map([['fixture', server]]);
  const lazy = harness.core.lazyMcp;

  // Never seen: the real server answers the handshake and stays for the session.
  const first = lazy.register(threadId as never, cwd, { ...process.env }, servers);
  const entry = first.entries.fixture!;
  expect(entry).toEqual({ type: 'http', url: `${harness.core.baseUrl()}${LAZY_MCP_ROUTE}${first.id}/fixture`, headers: { Authorization: 'Bearer ${BOITE_AGENT_TOKEN}' } });
  // The 2026 handshake is refused as unknown, so the client falls back to `initialize`.
  expect((await post(entry.url, token, { jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: {} })).messages[0]!.error.code).toBe(-32601);
  const opened = await post(entry.url, token, { jsonrpc: '2.0', id: 0, method: 'initialize', params: INIT });
  expect(opened.messages[0]!.result.instructions).toBe('Fixture instructions.');
  expect(starts(startsFile)).toBe(1);
  expect((await post(entry.url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, opened.session)).status).toBe(202);
  const listed = await post(entry.url, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, opened.session);
  expect(listed.messages[0]!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['echo', 'roots']);
  // What it answered is kept for the next sessions.
  await waitFor(() => harness.core.journal.getSetting(`mcp-manifest:${fingerprintOf(server)}`) !== undefined, 5000);
  lazy.release(first.id);
  await waitFor(() => lazy.running() === 0, 5000);

  // Known: handshake, lists and pings cost no process.
  const second = lazy.register(threadId as never, cwd, { ...process.env }, servers);
  const url = second.entries.fixture!.url;
  const again = await post(url, token, { jsonrpc: '2.0', id: 0, method: 'initialize', params: INIT });
  expect(again.messages[0]!.result).toMatchObject({ instructions: 'Fixture instructions.', serverInfo: { name: 'fixture' } });
  const session = again.session;
  expect((await post(url, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, session)).messages[0]!.result.tools).toHaveLength(2);
  expect((await post(url, token, { jsonrpc: '2.0', id: 2, method: 'ping' }, session)).messages[0]!.result).toEqual({});
  expect(starts(startsFile)).toBe(1);
  expect(lazy.running()).toBe(0);

  // The first call starts it under the thread, in the session's folder, with its own variables.
  const calling = post(url, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { said: 'hi' } } }, session);
  // A call that comes during the server's handshake waits for its end, and the server is not started twice.
  await waitFor(() => starts(startsFile) === 2, 5000);
  const during = post(url, token, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'echo', arguments: { said: 'during' } } }, session);
  let handshakeEnded = false;
  void during.then(() => { handshakeEnded = true; });
  // One cancelled meanwhile gets no answer and never reaches the server. The handshake takes a second: both calls are in by then.
  const dropped = post(url, token, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo', arguments: { said: 'dropped' } } }, session);
  await Bun.sleep(200);
  expect((await post(url, token, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }, session)).status).toBe(202);
  expect(handshakeEnded).toBe(false);
  const answered = (await during).messages[0]!;
  expect(answered.error).toBeUndefined();
  expect(JSON.parse(answered.result.content[0].text).arguments).toEqual({ said: 'during' });
  expect((await dropped).messages).toEqual([]);
  const called = await calling;
  expect(called.messages).toHaveLength(1);
  expect(called.messages[0]!.id).toBe(3);
  // The server reads its folder resolved: a temporary folder on macOS is under /private/var.
  expect(JSON.parse(called.messages[0]!.result.content[0].text)).toEqual({ arguments: { said: 'hi' }, cwd: realpathSync(cwd), thread: threadId, own: 'own' });
  expect(starts(startsFile)).toBe(2);
  expect(harness.core.procs.liveOf(threadId as never).length).toBeGreaterThan(0);

  // A server's own request reaches the client's stream, and the client's answer reaches the server.
  const stream = listen(url, token, session!);
  const asking = post(url, token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'roots', arguments: {} } }, session);
  await waitFor(() => stream.messages.some(message => message.method === 'roots/list'), 5000);
  const ask = stream.messages.find(message => message.method === 'roots/list')!;
  expect((await post(url, token, { jsonrpc: '2.0', id: ask.id, result: { roots: [{ uri: 'file:///work' }] } }, session)).status).toBe(202);
  expect(JSON.parse((await asking).messages[0]!.result.content[0].text)).toEqual({ roots: [{ uri: 'file:///work' }] });
  stream.close();

  // Only this thread's token opens its servers.
  expect((await post(url, 'wrong', { jsonrpc: '2.0', id: 5, method: 'ping' }, session)).status).toBe(401);
  const other = await echoThread(harness, client, 'other');
  expect((await post(url, harness.core.agents.tokenFor(other.threadId as never), { jsonrpc: '2.0', id: 6, method: 'ping' }, session)).status).toBe(404);

  // The session's end stops what it started.
  lazy.release(second.id);
  await waitFor(() => lazy.running() === 0, 5000);
  expect((await post(url, token, { jsonrpc: '2.0', id: 7, method: 'ping' }, session)).status).toBe(404);
});

test('a session released while a request body comes starts no server', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const token = harness.core.agents.tokenFor(threadId as never);
  const startsFile = join(harness.dataDir, 'starts.txt');
  const lazy = harness.core.lazyMcp;
  const { id, entries } = lazy.register(threadId as never, harness.dataDir, { ...process.env }, new Map([['fixture', { command: process.execPath, args: [FIXTURE], env: { LAZY_MCP_STARTS: startsFile } }]]));
  // A never seen server: its `initialize` would start it. The release comes between the two halves of the body.
  const text = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: INIT });
  let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text.slice(0, 10)));
      finish = () => { controller.enqueue(new TextEncoder().encode(text.slice(10))); controller.close(); };
    },
  });
  const response = fetch(entries.fixture!.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body, duplex: 'half' } as RequestInit);
  await Bun.sleep(200);
  lazy.release(id);
  finish();
  expect((await response).status).toBe(404);
  expect(starts(startsFile)).toBe(0);
  expect(lazy.running()).toBe(0);
});

test('a server\'s stdout is read as whole lines, and a line past the bound fails the waiting calls once and stops the server', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const token = harness.core.agents.tokenFor(threadId as never);
  const startsFile = join(harness.dataDir, 'starts.txt');
  const lazy = harness.core.lazyMcp;
  lazy.lineMax = 64 * 1024;
  const server: StdioServer = { command: process.execPath, args: [FIXTURE], env: { LAZY_MCP_STARTS: startsFile, LAZY_MCP_FLOOD: String(1024 * 1024) } };
  const { entries } = lazy.register(threadId as never, harness.dataDir, { ...process.env }, new Map([['fixture', server]]));
  const url = entries.fixture!.url;
  const opened = await post(url, token, { jsonrpc: '2.0', id: 0, method: 'initialize', params: INIT });
  const session = opened.session;
  await post(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, session);

  // A log line, then an answer in five-byte writes that cut its characters in half.
  const chunked = await post(url, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chunked', arguments: {} } }, session);
  expect(chunked.messages).toHaveLength(1);
  expect(chunked.messages[0]!.result.content[0].text).toBe('h\u00e9 \u{1f600} '.repeat(50));

  // `roots` waits on the client; a line with no end comes while it does.
  const asking = post(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'roots', arguments: {} } }, session);
  await Bun.sleep(200);
  const flooded = await post(url, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'flood', arguments: {} } }, session);
  expect(flooded.messages).toHaveLength(1);
  expect(flooded.messages[0]!.error.message).toContain('past 65536 characters');
  const waited = (await asking).messages.filter(message => message.id === 2);
  expect(waited).toHaveLength(1);
  expect(waited[0]!.error.message).toContain('past 65536 characters');
  const pid = Number(readFileSync(startsFile, 'utf8').trim());
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
  expect(lazy.running()).toBe(0);
}, 15000);

test('only the stdio servers of the user config are taken, without the ones the project turned off or the CLI expands', () => {
  const dir = join(harness.dataDir, 'claude-config');
  mkdirSync(dir, { recursive: true });
  const cwd = join(harness.dataDir, 'project');
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: {
      search: { type: 'stdio', command: 'search.exe', args: ['--quiet'], env: { KEY: 'v', BAD: 3 } },
      bare: { command: 'bare' },
      remote: { type: 'http', url: 'https://example.com/mcp' },
      off: { command: 'off' },
      broken: { type: 'stdio' },
      expanded: { command: 'tool', args: ['--key', '${KEY}'] },
      expandedEnv: { command: 'tool', env: { TOKEN: '${TOKEN:-none}' } },
    },
    projects: { [resolve(cwd)]: { disabledMcpServers: ['off'] } },
  }));
  expect([...userStdioServers(dir, cwd)]).toEqual([
    ['search', { command: 'search.exe', args: ['--quiet'], env: { KEY: 'v' } }],
    ['bare', { command: 'bare', args: [], env: {} }],
  ]);
  expect(userStdioServers(join(harness.dataDir, 'missing'), cwd).size).toBe(0);
});
