import { afterEach, expect, test } from 'bun:test';
import { AGENT_ENV } from '@boite/contracts';
import { AGENT_METHODS } from '../src/access.ts';
import { boundedMcpResult, dispatchMcpTool, MCP_MAX_RESULT_BYTES, MCP_TOOLS, requestWithCancellation } from '../src/mcp/tools.ts';
import type { CoreClient } from '../src/client.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
afterEach(async () => { await h?.stop(); });

test('bounded structured MCP output announces truncation and cancellation leaves submitted work running', async () => {
  expect(Object.values(MCP_TOOLS).every(tool => AGENT_METHODS.has(tool.method))).toBe(true);
  const result = boundedMcpResult({ text: 'é'.repeat(500_000) });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_MAX_RESULT_BYTES);
  expect(result.structuredContent).toMatchObject({ truncated: true, maxBytes: MCP_MAX_RESULT_BYTES });
  expect(result.content[0]?.type).toBe('text');
  const abort = new AbortController();
  const pending = Promise.withResolvers<number>();
  const waiting = requestWithCancellation(pending.promise, abort.signal);
  abort.abort();
  await expect(waiting).rejects.toThrow('submitted work may continue');
  pending.resolve(42);
  expect(await pending.promise).toBe(42);
  const client = { principal: 'agent', threadId: 'own', call: () => { throw new Error('must not dispatch'); } } as unknown as CoreClient;
  await expect(dispatchMcpTool(client, 'other', 'boite_where', {})).rejects.toThrow('thread-bound');
  await expect(dispatchMcpTool(client, 'own', 'arbitrary.rpc', {})).rejects.toThrow('unknown');
  await expect(dispatchMcpTool(client, 'own', 'boite_where', { threadId: 'other' })).rejects.toThrow();
  await expect(dispatchMcpTool(client, 'own', 'boite_delegate_spawn', { profileId: 'p', task: 'x', requestId: 'bad' })).rejects.toThrow();
});

test('MCP wait cancellation closes only its dedicated RPC connection and preserves result paging offsets', async () => {
  let primaryCalls = 0, closed = 0;
  const primary = { principal: 'agent', threadId: 'own', call: async (method: string, params: unknown) => {
    primaryCalls++;
    expect(method).toBe('delegation.result');
    expect(params).toMatchObject({ threadId: 'own', agentId: 'child', turnId: 'turn', offset: 100, limit: 10 });
    return { resultRef: { agentId: 'child', turnId: 'turn' }, text: 'page', offset: 100, nextOffset: 104, total: 200 };
  }, close: () => { throw new Error('primary connection closed'); } } as unknown as CoreClient;
  const page = await dispatchMcpTool(primary, 'own', 'boite_delegate_result', { agentId: 'child', turnId: 'turn', offset: 100, limit: 10 });
  expect(page.structuredContent.result).toMatchObject({ nextOffset: 104 });
  const pending = Promise.withResolvers<never>();
  const dedicated = { principal: 'agent', threadId: 'own', call: () => pending.promise, close: () => { closed++; pending.reject(new Error('wait socket closed')); } } as unknown as CoreClient;
  const abort = new AbortController();
  const waiting = dispatchMcpTool(primary, 'own', 'boite_delegate_wait', { agentId: 'child' }, abort.signal, async () => dedicated);
  await Bun.sleep(0);
  abort.abort();
  await expect(waiting).rejects.toThrow('cancelled');
  expect(closed).toBe(1);
  expect(primaryCalls).toBe(1);
  const acquisition = Promise.withResolvers<CoreClient>();
  const lateAbort = new AbortController();
  let lateClosed = 0;
  const late = dispatchMcpTool(primary, 'own', 'boite_delegate_wait', {}, lateAbort.signal, () => acquisition.promise);
  lateAbort.abort();
  await expect(late).rejects.toThrow('cancelled');
  acquisition.resolve({ principal: 'owner', threadId: 'other', close: () => { lateClosed++; }, call: () => { throw new Error('late request dispatched'); } } as unknown as CoreClient);
  await Bun.sleep(0);
  expect(lateClosed).toBe(1);
});

async function child(env: Record<string, string | undefined>) {
  const entry = process.env['BOITE_MCP_TEST_ENTRY'] ?? new URL('../src/cli.ts', import.meta.url).pathname;
  const script = `import { runCli, processIo } from ${JSON.stringify(entry)}; process.exitCode = await runCli(['mcp'], processIo());`;
  const spawned = h.core.procs.spawnPiped('mcp-test-child', process.execPath, ['-e', script], { cwd: h.dataDir, env: { ...process.env, ...env } });
  const replies = new Map<number, Record<string, any>>();
  const frames: Record<string, unknown>[] = [];
  let stdout = '', stderr = '';
  const output = (async () => {
    const reader = spawned.proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stdout += decoder.decode(chunk.value, { stream: true });
      let at: number;
      while ((at = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, at); stdout = stdout.slice(at + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        frames.push(frame);
        if (typeof frame.id === 'number') replies.set(frame.id, frame);
      }
    }
  })();
  const errors = new Response(spawned.proc.stderr).text().then(text => { stderr = text; });
  let id = 0;
  return { spawned, frames, output, errors, stderr: () => stderr,
    async rpc(method: string, params: unknown) {
      const request = ++id;
      spawned.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: request, method, params }) + '\n');
      await waitFor(() => replies.has(request), 5000);
      return replies.get(request)!;
    },
    lastId: () => id,
    notify(method: string, params?: unknown) { spawned.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n'); },
    async close() {
      spawned.proc.stdin.end();
      let exited = false;
      void spawned.exited.then(() => { exited = true; });
      try { await waitFor(() => exited, 5000); }
      catch (error) { spawned.proc.kill(); await spawned.exited; throw error; }
      await Promise.all([output, errors]);
    },
  };
}

test('actual CLI stdio negotiates, lists schemas, reads scoped tools and rejects invalid calls', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  owner.close();
  const transport = await child({ [AGENT_ENV.coreUrl]: h.url, [AGENT_ENV.token]: h.core.agents.tokenFor(threadId), [AGENT_ENV.threadId]: threadId });
  try {
    const initialized = await transport.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'boite-test', version: '1' } });
    expect(initialized.result.serverInfo.name).toBe('boite');
    transport.notify('notifications/initialized');
    const listed = await transport.rpc('tools/list', {});
    expect(listed.result.tools.length).toBe(17);
    expect(listed.result.tools.find((tool: any) => tool.name === 'boite_where').inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    const where = await transport.rpc('tools/call', { name: 'boite_where', arguments: {} });
    expect(where.result.structuredContent.result.threadId).toBe(threadId);
    const capabilities = await transport.rpc('tools/call', { name: 'boite_capabilities', arguments: {} });
    expect(capabilities.result.structuredContent.result.threadId).toBe(threadId);
    const projects = await transport.rpc('tools/call', { name: 'boite_projects', arguments: { limit: 1 } });
    expect(projects.result.structuredContent.result.items).toHaveLength(1);
    const settled = await transport.rpc('tools/call', { name: 'boite_delegate_wait', arguments: { timeoutMs: 0 } });
    expect(settled.result.structuredContent.result.state).toBe('settled');
    for (const [name, args] of [
      ['boite_delegate_result', { agentId: 'unrelated', turnId: 'unknown', offset: 2, limit: 1 }],
      ['boite_merge_back', { summary: 'Explicit result', requestId: 'merge-once' }],
    ] as const) {
      const denied = await transport.rpc('tools/call', { name, arguments: args });
      expect(denied.result?.isError === true || denied.error !== undefined).toBe(true);
    }
    for (const [name, args] of [['boite_where', { threadId: 'other' }], ['boite_contact_read', { target: { coreId: 'c', threadId: 't' }, limit: 1000 }], ['boite_delegate_spawn', { profileId: 'p', task: 'x', requestId: 'bad' }]] as const) {
      const invalid = await transport.rpc('tools/call', { name, arguments: args });
      expect(invalid.result?.isError === true || invalid.error !== undefined).toBe(true);
    }
    const unknown = await transport.rpc('tools/call', { name: 'run_command', arguments: { command: 'pwd' } });
    expect(unknown.result?.isError === true || unknown.error !== undefined).toBe(true);
    h.core.router.register('agent.where', () => ({ ...where.result.structuredContent.result, cwd: 'é'.repeat(500_000) }));
    const oversized = await transport.rpc('tools/call', { name: 'boite_where', arguments: {} });
    expect(oversized.result.structuredContent.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(oversized.result))).toBeLessThanOrEqual(MCP_MAX_RESULT_BYTES);
    let entered = false, completed = false;
    const finished = Promise.withResolvers<void>();
    const originalWhere = where.result.structuredContent.result;
    h.core.router.register('agent.where', async () => { entered = true; await finished.promise; completed = true; return originalWhere; });
    transport.spawned.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'boite_where', arguments: {} } }) + '\n');
    await waitFor(() => entered);
    transport.notify('notifications/cancelled', { requestId: 999, reason: 'test cancellation' });
    const afterCancel = await transport.rpc('tools/call', { name: 'boite_capabilities', arguments: {} });
    expect(afterCancel.result.structuredContent.result.threadId).toBe(threadId);
    // Cancelling only abandons the MCP wait; the core's submitted request still completes.
    finished.resolve();
    await waitFor(() => completed);
    expect(transport.frames.every(frame => frame.jsonrpc === '2.0')).toBe(true);
  } finally { await transport.close(); }
  expect(await transport.spawned.exited).toBe(0);
  expect(transport.stderr()).toBe('');
});

test('stdio refuses absent identity and refuses an owner token before offering tools', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  owner.close();
  for (const token of ['', h.token]) {
    const transport = await child({ [AGENT_ENV.coreUrl]: h.url, [AGENT_ENV.token]: token, [AGENT_ENV.threadId]: threadId, BOITE_DATA_DIR: h.dataDir });
    try { await transport.close(); }
    finally { if (transport.spawned.proc.exitCode === null) transport.spawned.proc.kill(); }
    expect(await transport.spawned.exited).toBe(1);
    expect(transport.frames).toHaveLength(0);
    expect(transport.stderr()).not.toContain(h.token);
  }
});
