import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ATTACHMENT_MAX_BYTES, DEFAULT_DELEGATION_CONFIG, PROTOCOL_VERSION, RPC_MAX_FRAME_BYTES, RPC_PATH, RpcCloseCode, RpcErrorCode, type Thread, type Turn } from '@boite/contracts';
import { connect, type CoreClient } from '../src/client.ts';
import { refused, type RpcFailure } from '../src/errors.ts';
import { Core } from '../src/core.ts';
import { newToken } from '../src/ids.ts';
import { pair, readPreviousRun } from '../src/main.ts';
import { isAllowedOrigin, PLACEHOLDER_HTML, PREFERRED_PORTS, preauthPeer, preauthRefusal, ServerConnection, startServer, startServerOnStickyPort, UI_DIST } from '../src/server.ts';
import { lanAddress } from '../src/server/lan.ts';
import { echoThread, removeDir, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const HELLO_TIMEOUT_MS = 200;

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore({ helloTimeoutMs: HELLO_TIMEOUT_MS });
});

afterEach(async () => {
  await harness.stop();
});

function rawSocket(): WebSocket {
  return new WebSocket(harness.url.replace('http', 'ws') + RPC_PATH);
}

function closeCode(socket: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the socket never closed')), timeoutMs);
    socket.addEventListener('close', (event: CloseEvent) => {
      clearTimeout(timer);
      resolve(event.code);
    });
  });
}

function firstFrame(socket: WebSocket, timeoutMs = 3000, matches?: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const received = (event: MessageEvent): void => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (matches && !matches(frame)) return;
      clearTimeout(timer);
      socket.removeEventListener('message', received);
      resolve(frame);
    };
    const timer = setTimeout(() => { socket.removeEventListener('message', received); reject(new Error('no frame arrived')); }, timeoutMs);
    socket.addEventListener('message', received);
  });
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('the socket failed to open')));
  });
}

describe('server', () => {
  test('complete RPC response budgets include envelopes and metadata while legal attachment pages keep progressing', async () => {
    const setup = await harness.connect();
    const { threadId } = await echoThread(harness, setup);
    const baseline = harness.core.threads.get(threadId);
    const message = { id: 'msg_response_budget', threadId, turnId: 'trn_response_budget', role: 'user' as const, state: 'complete' as const, createdAt: 1, parts: [{ type: 'text' as const, text: '' }] };
    let reply: Thread = { ...baseline, messages: [message], turns: [], memoryEvents: [] };
    let serialized = 0, oversizedError = false;
    harness.core.router.register('threads.get', () => {
      if (oversizedError) throw refused('Synthetic oversized error', { details: 'x'.repeat(RPC_MAX_FRAME_BYTES) });
      return { toJSON() { serialized++; return reply; } } as unknown as Thread;
    });
    const frameSizes: number[] = [];
    const { WsClient } = await import(new URL('../../ui/src/lib/client.ts', import.meta.url).href);
    const ownerWsClient: Pick<CoreClient, 'call' | 'close'> & { connect(): Promise<unknown>; readonly state: string } = new WsClient({ url: harness.url, token: harness.token, reconnect: false, socketFactory(url: string) {
      const socket = new WebSocket(url);
      socket.addEventListener('message', event => frameSizes.push(Buffer.byteLength(String(event.data))));
      return socket;
    } });
    const responseFailure = async (): Promise<unknown> => {
      let settled = false, failure: unknown;
      void ownerWsClient.call('threads.get', { threadId }).then(() => { settled = true; }, error => { failure = error; settled = true; });
      await waitFor(() => settled, 2000);
      return failure;
    };
    try {
      await ownerWsClient.connect();
      const attachment = Buffer.alloc(ATTACHMENT_MAX_BYTES).toString('base64');
      reply = { ...baseline, turns: [], messages: [{ ...message, parts: [
        { type: 'file', mimeType: 'application/octet-stream', data: attachment, name: 'one.bin' },
        { type: 'file', mimeType: 'application/octet-stream', data: attachment, name: 'two.bin' },
      ] }] };
      const legal = await ownerWsClient.call('threads.get', { threadId });
      expect(legal.messages).toHaveLength(1);
      expect(legal.messages[0]!.parts.map(part => part.type === 'file' ? part.data.length : 0)).toEqual([attachment.length, attachment.length]);
      expect(serialized).toBe(1);

      // The result fits by itself; only the final JSON-RPC envelope pushes it over.
      reply = { ...baseline, messages: [message], turns: [], memoryEvents: [] };
      const overhead = Buffer.byteLength(JSON.stringify(reply));
      reply.messages[0] = { ...message, parts: [{ type: 'text', text: 'x'.repeat(RPC_MAX_FRAME_BYTES - overhead - 24) }] };
      expect(Buffer.byteLength(JSON.stringify(reply))).toBe(RPC_MAX_FRAME_BYTES - 24);
      expect(await responseFailure()).toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'response', max: RPC_MAX_FRAME_BYTES } });
      expect(serialized).toBe(2);
      expect(ownerWsClient.state).toBe('ready');
      expect(await ownerWsClient.call('projects.list', {})).toBeInstanceOf(Array);

      // UTF-8 turn and memory metadata exceed the frame despite legal message bytes.
      reply = { ...baseline, messages: [message], memoryEvents: [{ kind: 'pressure', threadId, state: 'critical', at: 1, exe: 'é'.repeat(1024) }],
        turns: [{ id: message.turnId, threadId, status: 'done', queuedAt: 1, startedAt: 1, finishedAt: 1, usage: null, error: 'é'.repeat(1024) }] };
      reply.messages[0] = { ...message, parts: [{ type: 'text', text: 'x'.repeat(RPC_MAX_FRAME_BYTES - JSON.stringify(reply).length - 1000) }] };
      expect(JSON.stringify(reply).length).toBeLessThan(RPC_MAX_FRAME_BYTES);
      expect(Buffer.byteLength(JSON.stringify(reply.messages))).toBeLessThan(RPC_MAX_FRAME_BYTES);
      const failure = await responseFailure();
      expect(failure).toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'response', max: RPC_MAX_FRAME_BYTES } });
      expect((failure as { data: { bytes: number } }).data.bytes).toBeGreaterThan(RPC_MAX_FRAME_BYTES);
      expect(serialized).toBe(3);

      oversizedError = true;
      expect(await responseFailure()).toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'response', max: RPC_MAX_FRAME_BYTES } });
      expect(frameSizes.every(bytes => bytes <= RPC_MAX_FRAME_BYTES)).toBe(true);
      expect(await ownerWsClient.call('projects.list', {})).toBeInstanceOf(Array);
      expect(ownerWsClient.state).toBe('ready');
    } finally { ownerWsClient.close(); }
  });

  test('large caller IDs retain matched bounded RPC refusals or a finite close fallback', async () => {
    const socket = rawSocket();
    await opened(socket);
    try {
      const hello = firstFrame(socket);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { token: harness.token, protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' } } }));
      expect((await hello).result).toBeDefined();
      harness.core.router.register('settings.get', () => ({ payload: 'x'.repeat(1024) }) as never);
      const id = 'x'.repeat(RPC_MAX_FRAME_BYTES - 200);
      const answer = firstFrame(socket, 3000, frame => frame.id === id);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'settings.get', params: {} }));
      const frame = await answer;
      expect(frame.id === id).toBe(true);
      expect(frame.error).toMatchObject({ code: RpcErrorCode.Refused });
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(RPC_MAX_FRAME_BYTES);
      const next = firstFrame(socket, 3000, frame => frame.id === 'small');
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'small', method: 'projects.list', params: {} }));
      expect((await next).id).toBe('small');

      const request = { jsonrpc: '2.0', id: '', method: 'settings.get', params: {} };
      request.id = 'x'.repeat(RPC_MAX_FRAME_BYTES - Buffer.byteLength(JSON.stringify(request)));
      expect(Buffer.byteLength(JSON.stringify(request))).toBe(RPC_MAX_FRAME_BYTES);
      const closed = closeCode(socket);
      socket.send(JSON.stringify(request));
      expect(await closed).toBe(1009);
    } finally { socket.close(); }
  });

  test('a rolled-back prompt sends no message or status notifications', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });
    harness.core.activity.set({ threadId, goal: { objective: 'Keep the finished overlay' } });
    harness.core.activity.control({ threadId, kind: 'goal', action: 'complete' });
    harness.core.activity.tasks(threadId, [{ id: 'done', text: 'Completed task', status: 'completed' }]);
    const activity = harness.core.activity.get(threadId);
    harness.core.threads.deferred.pendingWakes.set(threadId, 'Retain background output');
    const seen: string[] = [];
    client.on('message.started', event => { if (event.threadId === threadId) seen.push('message.started'); });
    client.on('message.completed', event => { if (event.threadId === threadId) seen.push('message.completed'); });
    client.on('thread.updated', event => { if (event.id === threadId) seen.push(event.status); });
    harness.core.journal.db.exec(`CREATE TRIGGER refuse_queue BEFORE INSERT ON threads
      WHEN NEW.status = 'queued' BEGIN SELECT RAISE(ABORT, 'forced queue rollback'); END;`);
    await expect(client.call('turns.start', { threadId, prompt: 'must roll back' })).rejects.toBeInstanceOf(Error);
    // The response to this read follows any premature notification on the same socket.
    const thread = await client.call('threads.get', { threadId });
    expect(thread?.status).toBe('idle');
    expect(harness.core.journal.listTurns(threadId)).toEqual([]);
    expect(harness.core.journal.listMessages(threadId)).toEqual([]);
    expect(seen).toEqual([]);
    expect({ activity: harness.core.activity.get(threadId), stored: harness.core.journal.getSetting(`activity:${threadId}`),
      wake: harness.core.threads.deferred.pendingWakes.get(threadId) })
      .toEqual({ activity, stored: activity, wake: 'Retain background output' });
  });

  test('a rolled-back child prompt preserves its stopped admission and team usage', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const parent = harness.core.threads.require(threadId);
    const profile = { id: 'worker', name: 'Worker', providerId: 'echo', accountId: parent.accountId, model: parent.model!, effort: null };
    harness.core.delegation.configure(threadId, { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [profile] });
    const childId = harness.core.delegation.createChild(parent, profile, 'Stopped child', () => undefined);
    harness.core.delegation.stop(childId);
    const admission = { id: 'turn_probe', threadId: childId } as Turn;
    expect(harness.core.delegation.prepareTurn(admission)).toBe(false);
    harness.core.journal.db.exec(`CREATE TRIGGER refuse_child_queue BEFORE INSERT ON threads
      WHEN NEW.status = 'queued' BEGIN SELECT RAISE(ABORT, 'forced child rollback'); END;`);
    await expect(client.call('turns.start', { threadId: childId, prompt: 'must keep stop' })).rejects.toBeInstanceOf(Error);
    expect(harness.core.journal.listTurns(childId)).toEqual([]);
    expect(harness.core.delegation.get(threadId).turnsUsed).toBe(0);
    expect(harness.core.delegation.prepareTurn(admission)).toBe(false);
  });

  test('an RPC burst lets another client read before the burst ends', async () => {
    const sender = await harness.connect();
    const reader = await harness.connect();
    let processed = 0, observed = -1, healthObserved = -1;
    let health: Promise<void> | undefined;
    harness.core.router.register('projects.list', () => {
      const deadline = performance.now() + 3;
      while (performance.now() < deadline) { /* bounded synchronous work */ }
      processed++;
      if (processed === 1) health = fetch(`${harness.server.url}/health`).then(response => {
        healthObserved = processed;
        expect(response.ok).toBe(true);
      });
      return [];
    });
    harness.core.router.register('settings.get', () => {
      observed = processed;
      return harness.core.settings.get();
    });
    const burst = Promise.all(Array.from({ length: 64 }, () => sender.call('projects.list', {})));
    void burst.catch(() => undefined);
    await reader.call('settings.get', {});
    await burst;
    await health;
    expect(processed).toBe(64);
    expect(observed).toBeLessThan(processed);
    expect(healthObserved).toBeLessThan(processed);
  });

  test('a socket that never drains bounds subsequent responses and isolates the healthy client', () => {
    const closed: number[] = [], frames: string[] = [];
    let buffered = 0;
    const slow = new ServerConnection(harness.core);
    slow.attach({ getBufferedAmount: () => buffered,
      send: (frame: string) => { frames.push(frame); buffered += Buffer.byteLength(frame); return -1; },
      close: (code: number) => closed.push(code) } as unknown as Parameters<ServerConnection['attach']>[0]);
    const result = 'x'.repeat(1024 * 1024);
    for (let id = 0; id < 50; id++) {
      if (id % 2) slow.sendEvent('message.part', { threadId: 't', messageId: 'm', partIndex: 0, part: { type: 'text', text: result } });
      else slow.sendResponse({ jsonrpc: '2.0', id, result });
    }
    expect(closed).toEqual([1013]);
    expect(buffered).toBeLessThanOrEqual(32 * 1024 * 1024);
    const count = frames.length;
    slow.sendEvent('message.delta', { threadId: 't', messageId: 'm', partIndex: 0, text: 'late' });
    slow.drain();
    slow.close(1013);
    expect(frames).toHaveLength(count);
    expect(closed).toEqual([1013]);
    const healthy: string[] = [];
    const connection = new ServerConnection(harness.core);
    connection.attach({ getBufferedAmount: () => 0, send: (frame: string) => { healthy.push(frame); return frame.length; },
      close: () => undefined } as unknown as Parameters<ServerConnection['attach']>[0]);
    connection.sendResponse({ jsonrpc: '2.0', id: 1, result: 'ok' });
    expect(JSON.parse(healthy[0]!).result).toBe('ok');
    connection.close(1000);
  });

  test('congestion expiry closes once, while draining clears its deadline', async () => {
    const expired: number[] = [], recovered: number[] = [];
    let buffered = 1;
    const slow = new ServerConnection(harness.core, false, 20);
    slow.attach({ getBufferedAmount: () => buffered, send: () => -1, close: (code: number) => expired.push(code) } as unknown as Parameters<ServerConnection['attach']>[0]);
    slow.sendResponse({ jsonrpc: '2.0', id: 1, result: 'held' });
    // A spurious drain with bytes still queued cannot extend the deadline.
    slow.drain();
    const healthy = new ServerConnection(harness.core, false, 20);
    healthy.attach({ getBufferedAmount: () => buffered, send: () => -1, close: (code: number) => recovered.push(code) } as unknown as Parameters<ServerConnection['attach']>[0]);
    healthy.sendResponse({ jsonrpc: '2.0', id: 1, result: 'held' });
    buffered = 0;
    healthy.drain();
    await Bun.sleep(50);
    expect(expired).toEqual([1013]);
    expect(recovered).toEqual([]);
    slow.close(1013);
    expect(expired).toEqual([1013]);
    healthy.close(1000);
  });

  test('catch-up parts are bounded and a fresh connection reads the authoritative journal', async () => {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const messageId = 'msg_outbound_snapshot';
    harness.core.journal.putMessage({ id: messageId, threadId, turnId: 'trn_snapshot', role: 'assistant', state: 'streaming', createdAt: Date.now(), parts: [] });
    const closed: number[] = [];
    let writes = 0;
    const slow = new ServerConnection(harness.core);
    slow.attach({ getBufferedAmount: () => 1, send: () => { writes++; return -1; }, close: (code: number) => closed.push(code) } as unknown as Parameters<ServerConnection['attach']>[0]);
    for (let partIndex = 0; partIndex <= 1024; partIndex++) {
      slow.sendEvent('message.delta', { threadId, messageId, partIndex, text: 'text' });
    }
    expect(closed).toEqual([1013]);
    expect(writes).toBe(1);
    harness.core.journal.appendDelta(threadId, messageId, 0, 'continued after disconnect');
    harness.core.journal.flushDeltas();
    const fresh = await harness.connect();
    const snapshot = await fresh.call('threads.get', { threadId });
    expect(snapshot.messages.find(message => message.id === messageId)?.parts[0]).toMatchObject({ type: 'text', text: 'continued after disconnect' });
    fresh.close();
    owner.close();
  });

  test('oversized events close without queueing an invalid UTF-8 frame', () => {
    const closed: number[] = [];
    let writes = 0;
    const connection = new ServerConnection(harness.core, true);
    connection.attach({ getBufferedAmount: () => 0, send: () => { writes++; return 1; }, close: (code: number) => closed.push(code) } as unknown as Parameters<ServerConnection['attach']>[0]);
    connection.sendEvent('message.delta', { threadId: 't', messageId: 'm', partIndex: 0, text: 'é'.repeat(RPC_MAX_FRAME_BYTES / 2) });
    expect(closed).toEqual([1009]);
    expect(writes).toBe(0);
  });

  test('drain sends the journal including deltas still inside the coalescing window', () => {
    const journal = harness.core.journal;
    journal.putMessage({ id: 'msg_drain', threadId: 'thr_drain', turnId: 'turn_drain', role: 'assistant',
      state: 'streaming', createdAt: Date.now(), parts: [] });
    const writes: string[] = [];
    const closed: number[] = [];
    let result = -1;
    const connection = new ServerConnection(harness.core);
    connection.attach({ getBufferedAmount: () => 0, send: (frame: string) => { writes.push(frame); return result; },
      close: (code: number) => { closed.push(code); } } as unknown as Parameters<ServerConnection['attach']>[0]);
    const delta = { threadId: 'thr_drain', messageId: 'msg_drain', partIndex: 0, text: 'first' };
    journal.appendDelta(delta.threadId, delta.messageId, 0, delta.text);
    connection.sendEvent('message.delta', delta);
    journal.appendDelta(delta.threadId, delta.messageId, 0, ' second');
    connection.sendEvent('message.delta', { ...delta, text: ' second' });
    expect(writes).toHaveLength(1);
    result = 20;
    connection.drain();
    expect(JSON.parse(writes[1] ?? '{}').params.part.text).toBe('first second');
    expect(closed).toEqual([]);
    result = 0;
    connection.sendEvent('message.delta', delta);
    expect(closed).toEqual([1013]);
  });
  test('catch-up resends only the part whose deltas were dropped, and only once', () => {
    const journal = harness.core.journal;
    const tool = { type: 'tool' as const, toolId: 'tool_big', name: 'Read', input: {}, output: 'x'.repeat(200_000), status: 'done' as const };
    journal.putMessage({ id: 'msg_parts', threadId: 'thr_parts', turnId: 'turn_parts', role: 'assistant',
      state: 'streaming', createdAt: Date.now(), parts: [tool, { type: 'text', text: '' }] });
    const writes: { method: string; params: { partIndex?: number; part?: { text?: string } } }[] = [];
    let result = -1;
    const connection = new ServerConnection(harness.core);
    connection.attach({ getBufferedAmount: () => 0, send: (frame: string) => { writes.push(JSON.parse(frame)); return result; },
      close: () => undefined } as unknown as Parameters<ServerConnection['attach']>[0]);
    const delta = { threadId: 'thr_parts', messageId: 'msg_parts', partIndex: 1, text: 'one' };
    journal.appendDelta(delta.threadId, delta.messageId, 1, delta.text);
    connection.sendEvent('message.delta', delta);
    journal.appendDelta(delta.threadId, delta.messageId, 1, ' two');
    connection.sendEvent('message.delta', { ...delta, text: ' two' });
    expect(writes).toHaveLength(1);

    // Still congested: the part goes out queued, and a later drain has nothing new to resend.
    connection.drain();
    expect(writes.slice(1).map((frame) => [frame.method, frame.params.partIndex])).toEqual([['message.part', 1]]);
    connection.drain();
    expect(writes).toHaveLength(2);

    // Congested again, a dropped delta brings the part back once, never the tool output before it.
    journal.appendDelta(delta.threadId, delta.messageId, 1, ' three');
    connection.sendEvent('message.delta', { ...delta, text: ' three' });
    journal.appendDelta(delta.threadId, delta.messageId, 1, ' four');
    connection.sendEvent('message.delta', { ...delta, text: ' four' });
    expect(writes).toHaveLength(3);
    result = 20;
    connection.drain();
    expect(writes.slice(3).map((frame) => [frame.method, frame.params.partIndex])).toEqual([['message.part', 1]]);
    expect(writes[3]?.params.part?.text).toBe('one two three four');
    connection.drain();
    expect(writes).toHaveLength(4);
  });
  test('recovering from backpressure never sends a delta the resent part already holds', () => {
    const journal = harness.core.journal;
    const bus = harness.core.bus;
    journal.putMessage({ id: 'msg_dup', threadId: 'thr_dup', turnId: 'turn_dup', role: 'assistant',
      state: 'streaming', createdAt: Date.now(), parts: [] });
    const frames: { method: string; params: { partIndex: number; text?: string; part?: { text: string } } }[] = [];
    let result = -1;
    const connection = new ServerConnection(harness.core);
    connection.attach({ getBufferedAmount: () => 0, send: (frame: string) => { frames.push(JSON.parse(frame)); return result; },
      close: () => undefined } as unknown as Parameters<ServerConnection['attach']>[0]);
    const off = bus.onAny((name, payload) => connection.sendEvent(name, payload));
    // The same two buffers threads/turn-context.ts feeds for every delta.
    const stream = (text: string) => {
      journal.appendDelta('thr_dup', 'msg_dup', 0, text);
      bus.emit('message.delta', { threadId: 'thr_dup', messageId: 'msg_dup', partIndex: 0, text });
    };
    try {
      stream('alpha ');
      bus.flush();
      stream('beta ');
      bus.flush();
      // Still inside the bus window when the socket drains.
      stream('gamma ');
      result = 20;
      connection.drain();
      bus.flush();
    } finally {
      off();
    }
    let shown = '';
    for (const frame of frames) {
      if (frame.method === 'message.delta') shown += frame.params.text ?? '';
      if (frame.method === 'message.part') shown = frame.params.part?.text ?? '';
    }
    const stored = journal.getMessage('msg_dup')?.parts[0];
    expect(stored?.type === 'text' ? stored.text : null).toBe('alpha beta gamma ');
    expect(shown).toBe('alpha beta gamma ');
  });
  test('a valid token with an incompatible protocol closes 4010', async () => {
    const socket = rawSocket();
    await opened(socket);
    const closed = closeCode(socket);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: {
      token: harness.token, protocolVersion: PROTOCOL_VERSION - 1, client: { name: 'test', version: '0' },
    } }));
    expect(await closed).toBe(RpcCloseCode.ProtocolMismatch);
  });
  test('LAN origin checks reject foreign hosts and opaque origins', () => {
    for (const origin of ['null', '', 'http://evil.example:4321', 'https://evil.example:4321']) {
      expect(isAllowedOrigin(origin, 4321, '0.0.0.0')).toBe(false);
    }
    expect(isAllowedOrigin(null, 4321, '0.0.0.0')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4321', 4321, '0.0.0.0')).toBe(true);
    expect(isAllowedOrigin('tauri://localhost', 4321, '0.0.0.0')).toBe(true);
    expect(isAllowedOrigin('http://192.0.2.1:4321', 4321, '192.0.2.1')).toBe(true);
    expect(isAllowedOrigin('http://192.0.2.1:4322', 4321, '192.0.2.1')).toBe(false);
  });
  test('health answers without auth', async () => {
    const response = await fetch(`${harness.url}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; version: string; pid: number };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(harness.core.version);
    expect(body.pid).toBe(process.pid);
  });

  test('health and hello report the bundle loaded by this core run', async () => {
    const bundled = await startTestCore({ bundleHash: 'loaded-bundle' });
    try {
      const body = await (await fetch(`${bundled.url}/health`)).json() as { bundleHash?: string };
      expect(body.bundleHash).toBe('loaded-bundle');
      const client = await bundled.connect();
      expect(client.core.bundleHash).toBe('loaded-bundle');
    } finally { await bundled.stop(); }
  });

  test('shutdown takes a POST with the core token, and an embedded core says it cannot stop', async () => {
    const at = `${harness.url}/shutdown`;
    expect((await fetch(at)).status).toBe(405);
    expect((await fetch(at, { method: 'POST' })).status).toBe(401);
    expect((await fetch(at, { method: 'POST', headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    // A proxy on this machine forwards a public name: the route is not for it.
    const proxied = await fetch(at, { method: 'POST', headers: { authorization: `Bearer ${harness.token}`, host: 'boite.example' } });
    expect(proxied.status).toBe(403);
    // The harness core has no process of its own to stop.
    expect((await fetch(at, { method: 'POST', headers: { authorization: `Bearer ${harness.token}` } })).status).toBe(501);
  });

  test('shutdown with the core token stops a core that owns its process', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'boite-shutdown-'));
    let stopped = 0;
    const token = newToken();
    const core = new Core({ dataDir, token, onShutdown: () => { stopped += 1; } });
    const server = startServer({ core, host: '127.0.0.1', port: 0 });
    try {
      const ask = () => fetch(`${server.url}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      const first = await ask();
      expect(first.status).toBe(202);
      expect(((await first.json()) as { pid: number }).pid).toBe(process.pid);
      // A second request while the first is draining is not a second stop.
      expect((await ask()).status).toBe(202);
      await Bun.sleep(60);
      expect(stopped).toBe(1);
    } finally {
      await server.stop();
      await core.close();
      await removeDir(dataDir);
    }
  });

  test('a core listens on the port of its previous run, then on its preferred ports, then on any', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'boite-sticky-'));
    const core = new Core({ dataDir, token: newToken() });
    const warnings: string[] = [];
    const log = core.log.bind(core);
    core.log = (level, message) => { if (level === 'warn') warnings.push(message); log(level, message); };
    // Two ports free a moment ago stand for the channel's preferred ones; a squatter holds a third.
    const free = [Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }), Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })];
    const preferred = free.map((server) => server.port!);
    await Promise.all(free.map((server) => server.stop(true)));
    const squatter = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('mine') });
    const sticky = (previousPort: number | null, preferredPorts: readonly number[], port = 0, explicitPort = false) =>
      startServerOnStickyPort({ core, host: '127.0.0.1', port, explicitPort, previousPort, preferredPorts });
    try {
      // A first run takes the first preferred port, never a random one.
      const first = sticky(null, preferred);
      expect(first.port).toBe(preferred[0]!);
      await first.stop();
      const coreFile = join(dataDir, 'core.json');
      writeFileSync(coreFile, JSON.stringify({ port: first.port, host: '127.0.0.1', token: 'kept', pid: 1 }));
      expect(readPreviousRun(coreFile)).toEqual({ token: 'kept', port: first.port });
      // A restart keeps the port of the previous run, even outside the preferred ones.
      const again = sticky(readPreviousRun(coreFile).port, [preferred[1]!]);
      expect(again.port).toBe(preferred[0]!);
      await again.stop();
      // Another program took it meanwhile: the next preferred port, said in the log.
      const moved = sticky(squatter.port!, [squatter.port!, preferred[1]!]);
      expect(moved.port).toBe(preferred[1]!);
      expect(warnings.some((line) => line.includes(`port ${squatter.port} of the previous run is taken, listening on ${preferred[1]}`))).toBe(true);
      await moved.stop();
      // Every candidate taken: any free port.
      const any = sticky(squatter.port!, [squatter.port!]);
      expect(any.port).not.toBe(squatter.port!);
      await any.stop();
      // A port the operator named is never swapped for another.
      expect(() => sticky(preferred[0]!, preferred, squatter.port!, true)).toThrow();
    } finally {
      void squatter.stop(true);
      await core.close();
      await removeDir(dataDir);
    }
  });

  test('the preferred ports stay below the range Windows lends to outgoing connections', () => {
    for (const ports of Object.values(PREFERRED_PORTS)) expect(ports.every((port) => port > 1024 && port < 49152)).toBe(true);
    expect(PREFERRED_PORTS.stable.some((port) => PREFERRED_PORTS.dev.includes(port))).toBe(false);
  });

  test('a pairing link names the LAN address of a core listening on every interface', () => {
    const iface = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }) as never;
    expect(lanAddress({ lo: [iface('127.0.0.1', true)], vpn: [iface('100.64.0.2')], eth: [iface('192.168.1.20')] })).toBe('192.168.1.20');
    expect(lanAddress({ eth: [iface('169.254.3.4')], wan: [iface('100.64.0.2')] })).toBe('100.64.0.2');
    expect(lanAddress({ lo: [iface('127.0.0.1', true)] })).toBeNull();
    const url = new URL(harness.core.sessions.pairingUrl('grant'));
    expect(url.hostname).toBe('127.0.0.1');
    harness.core.setEndpoint('0.0.0.0', 4321);
    const lan = lanAddress();
    expect(new URL(harness.core.sessions.pairingUrl('grant')).host).toBe(`${lan ?? '127.0.0.1'}:4321`);
  });

  test('the root serves the UI build, or the placeholder when there is none', async () => {
    expect(PLACEHOLDER_HTML).toContain('Boite core is running; the UI is not built');
    const response = await fetch(`${harness.url}/`);
    expect(response.status).toBe(200);
    const body = await response.text();
    if (existsSync(UI_DIST)) expect(body).toContain('<html');
    else expect(body).toBe(PLACEHOLDER_HTML);
    // No other site may frame the owner's UI.
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  test('a socket before hello may not send a large frame, and only so many may wait at once', async () => {
    const big = rawSocket();
    await opened(big);
    const closed = closeCode(big);
    let answered = false;
    big.addEventListener('message', () => { answered = true; });
    big.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { token: harness.token, pad: 'x'.repeat(70_000) } }));
    expect(await closed).toBe(RpcCloseCode.Unauthorized);
    expect(answered).toBe(false);

    // A core that waits longer for hello than this file's 200 ms, so the sockets stay pending.
    const patient = await startTestCore({ helloTimeoutMs: 10_000 });
    const waiting: WebSocket[] = [];
    const owner: WebSocket[] = [];
    // Peers of a tunnel on this machine: loopback address, public Host. They
    // are counted; the owner's shell, loopback both ways, never is.
    const tunnelled = { headers: { host: 'phone.example' } };
    const hello = (socket: WebSocket) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: {
      token: patient.token, protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' },
    } }));
    try {
      const url = patient.url.replace('http', 'ws') + RPC_PATH;
      for (let at = 0; at < 32; at += 1) waiting.push(new WebSocket(url, tunnelled as never));
      await Promise.all(waiting.map(opened));
      const refused = await fetch(`${patient.url}${RPC_PATH}`, tunnelled);
      expect(refused.status).toBe(503);

      // The owner still connects, and more than once, while every place is held.
      expect((await fetch(`${patient.url}${RPC_PATH}`)).status).toBe(400);
      for (let at = 0; at < 3; at += 1) owner.push(new WebSocket(url));
      await Promise.all(owner.map(opened));
      const shell = owner[0] as WebSocket;
      const answer = firstFrame(shell);
      hello(shell);
      expect((await answer).result).toBeDefined();

      // An authenticated client is not waiting: one hello frees a place.
      const first = waiting[0] as WebSocket;
      const freed = firstFrame(first);
      hello(first);
      expect((await freed).result).toBeDefined();
      const next = await fetch(`${patient.url}${RPC_PATH}`, tunnelled);
      expect(next.status).toBe(400);
    } finally {
      for (const socket of [...waiting, ...owner]) socket.close();
      await patient.stop();
    }
  });

  test('one LAN address may hold only 8 of the places waiting for hello, and loopback peers only the total', () => {
    expect(preauthPeer('127.0.0.1', '127.0.0.1:8777')).toBeNull();
    expect(preauthPeer('::ffff:127.0.0.1', 'localhost')).toBeNull();
    expect(preauthPeer('::1', '[::1]:8777')).toBeNull();
    // A loopback name forged by a LAN peer does not exempt it, nor a tunnel's public name its peers.
    expect(preauthPeer('192.168.1.20', '127.0.0.1:8777')).toBe('192.168.1.20');
    expect(preauthPeer('127.0.0.1', 'boite.example')).toBe('127.0.0.1');
    expect(preauthPeer(null, '127.0.0.1')).toBe('unknown');

    const phone = '192.168.1.20';
    expect(preauthRefusal(Array(7).fill(phone), phone)).toBeNull();
    expect(preauthRefusal(Array(8).fill(phone), phone)).toContain(`8 sockets from ${phone}`);
    // Another host keeps its own places.
    expect(preauthRefusal(Array(8).fill(phone), '192.168.1.21')).toBeNull();
    // Tunnelled peers share one address that names nobody: only the total bounds them.
    expect(preauthRefusal(Array(31).fill('127.0.0.1'), '127.0.0.1')).toBeNull();
    expect(preauthRefusal(Array(32).fill('127.0.0.1'), '192.168.1.21')).toContain('32 sockets from other machines');
  });

  // Without `bun run build:ui` there is nothing to serve and nothing to assert;
  // the end to end suite builds the UI before it starts, and proves the same three.
  test.skipIf(!existsSync(UI_DIST))(
    'the shell, the worker, a hashed asset and assetlinks.json carry what the PWA and the APK need',
    async () => {
      const index = await fetch(`${harness.url}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get('cache-control')).toBe('no-cache');
      const html = await index.text();

      const worker = await fetch(`${harness.url}/sw.js`);
      expect(worker.status).toBe(200);
      expect(worker.headers.get('cache-control')).toBe('no-cache');
      // Without it a worker served from `/sw.js` may only claim `/`, which is
      // the same scope here, but the header is what makes that explicit.
      expect(worker.headers.get('service-worker-allowed')).toBe('/');

      const manifest = await fetch(`${harness.url}/manifest.webmanifest`);
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get('cache-control')).toBe('no-cache');

      // Android reads it before opening the APK without an address bar
      // (docs/android.md), and Vite only copies a dot directory on purpose.
      const assetlinks = await fetch(`${harness.url}/.well-known/assetlinks.json`);
      expect(assetlinks.status).toBe(200);
      expect(assetlinks.headers.get('content-type')).toStartWith('application/json');
      const statements = (await assetlinks.json()) as { target: { package_name: string } }[];
      expect(statements[0]?.target.package_name).toBe('com.boite.two');

      // The hashed name is read out of the build rather than guessed.
      const hashed = /assets\/[A-Za-z0-9._-]+/.exec(html)?.[0];
      expect(hashed).toBeDefined();
      const asset = await fetch(`${harness.url}/${hashed}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    },
  );

  test('a foreign origin gets 403', async () => {
    const response = await fetch(`${harness.url}${RPC_PATH}`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
  });

  test('no hello inside the window closes 4001', async () => {
    const socket = rawSocket();
    await opened(socket);
    expect(await closeCode(socket)).toBe(RpcCloseCode.Unauthorized);
  });

  test('a wrong token closes 4001', async () => {
    const socket = rawSocket();
    await opened(socket);
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'hello',
        params: { token: 'not-the-token', client: { name: 'test', version: '0' } },
      }),
    );
    const frame = (await firstFrame(socket)) as { error?: { code: number } };
    expect(frame.error?.code).toBe(RpcErrorCode.Unauthorized);
    expect(await closeCode(socket)).toBe(RpcCloseCode.Unauthorized);
  });

  test('a frame before hello is refused', async () => {
    const socket = rawSocket();
    await opened(socket);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'projects.list', params: {} }));
    const frame = (await firstFrame(socket)) as { error?: { code: number } };
    expect(frame.error?.code).toBe(RpcErrorCode.Unauthorized);
    expect(await closeCode(socket)).toBe(RpcCloseCode.Unauthorized);
  });

  test('the right token opens the RPC', async () => {
    const client = await harness.connect();
    expect(client.core.pid).toBe(process.pid);
    expect(client.core.protocolVersion).toBe(PROTOCOL_VERSION);
    // A core nobody told otherwise is the stable install.
    expect(client.core.channel).toBe('stable');
    expect(await client.call('projects.list', {})).toEqual([]);
  });

  test('a pairing grant is exchanged once for a session that survives a restart, and a revoke closes it', async () => {
    const owner = await harness.connect();
    expect(owner.principal).toBe('owner');
    const { url, grant, expiresAt } = await owner.call('pairing.grant', {});
    expect(url).toBe(`${harness.url}/?grant=${grant}`);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(owner.core).not.toHaveProperty('pairingUrl');

    const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: '2.0.0-beta.1' } });
    expect(phone.principal).toBe('session');
    expect(phone.session?.token).toHaveLength(64);
    expect(phone.session?.token).not.toBe(harness.token);
    expect(await phone.call('projects.list', {})).toEqual([]);

    // Second use of the same link: refused by name, socket closed.
    let reused = 'none';
    try {
      await connect(harness.url, '', { grant });
    } catch (error) {
      reused = (error as Error).message;
    }
    expect(reused).toBe('the pairing link was already used, expired, or never issued');

    // The session token opens the RPC on its own, and the journal holds only its hash.
    const again = await connect(harness.url, phone.session?.token ?? '');
    expect(again.principal).toBe('session');
    const rows = harness.core.journal.listSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toContain(phone.session?.token ?? 'never');
    expect(rows[0]?.client_name).toBe('pwa');

    // A session sees the list with itself marked, and cannot mint or revoke.
    const seen = await again.call('sessions.list', {});
    expect(seen.map((row) => row.current)).toEqual([true]);
    let minted = 'none';
    try {
      await again.call('pairing.grant', {});
    } catch (error) {
      minted = (error as Error).message;
    }
    expect(minted).toBe('pairing.grant is for the owner only');

    // Revoked by the owner: both of its sockets close 4001 and the token is dead.
    const sessionId = phone.session?.id ?? '';
    const closed = new Promise<void>((resolve) => again.on('core.log', () => resolve()));
    await owner.call('sessions.revoke', { sessionId });
    void closed;
    expect(await owner.call('sessions.list', {})).toEqual([]);
    let dead = 'none';
    try {
      await connect(harness.url, phone.session?.token ?? '');
    } catch (error) {
      dead = (error as Error).message;
    }
    expect(dead).toBe('the token is wrong');
    let after = 'none';
    try {
      await again.call('projects.list', {});
    } catch (error) {
      after = (error as Error).message;
    }
    expect(after).toMatch(/^the (socket closed|client is closed)/);
  });

  test('an owner pairing link becomes a key that drives the core as its owner, until it is revoked', async () => {
    const owner = await harness.connect();
    const minted = await owner.call('pairing.grant', { role: 'owner' });
    expect(minted.role).toBe('owner');

    const laptop = await connect(harness.url, '', { grant: minted.grant, client: { name: 'shell', version: '2.0.0-beta.1' } });
    expect(laptop.principal).toBe('owner');
    expect(laptop.session?.token).toHaveLength(64);
    expect(laptop.session).not.toHaveProperty('role');

    // The key alone says hello as the owner, reaches what a phone is refused,
    // and is still a row the owner sees and can take away.
    const again = await connect(harness.url, laptop.session?.token ?? '');
    expect(again.principal).toBe('owner');
    const phoneLink = await again.call('pairing.grant', {});
    expect(phoneLink.role).toBe('device');
    const rows = await owner.call('sessions.list', {});
    expect(rows.map((row) => [row.role, row.client.name])).toEqual([['owner', 'shell']]);
    expect(harness.core.journal.listSessions()[0]?.role).toBe('owner');

    await owner.call('sessions.revoke', { sessionId: laptop.session?.id ?? '' });
    let dead = 'none';
    try {
      await connect(harness.url, laptop.session?.token ?? '');
    } catch (error) {
      dead = (error as Error).message;
    }
    expect(dead).toBe('the token is wrong');
  });

  test('pairing.grant refuses a role it does not know, by name', async () => {
    const owner = await harness.connect();
    let refused = 'none';
    try {
      await owner.call('pairing.grant', { role: 'admin' as 'owner' });
    } catch (error) {
      refused = (error as Error).message;
    }
    expect(refused).toBe('pairing.grant role must be device or owner, got admin');
  });

  test('boite-core pair reads core.json and hands back a link of the role asked for', async () => {
    let missing = 'none';
    try {
      await pair(['--data-dir', harness.dataDir]);
    } catch (error) {
      missing = (error as Error).message;
    }
    expect(missing).toContain('core.json does not exist');

    const port = Number(new URL(harness.url).port);
    const state = { port, host: '0.0.0.0', token: harness.token, pid: process.pid, startedAt: Date.now(), version: 'test' };
    writeFileSync(join(harness.dataDir, 'core.json'), JSON.stringify(state));
    const ownerLink = await pair(['--owner', '--data-dir', harness.dataDir]);
    expect(ownerLink.role).toBe('owner');
    expect(ownerLink.url).toBe(`${harness.url}/?grant=${ownerLink.grant}`);
    const laptop = await connect(harness.url, '', { grant: ownerLink.grant, client: { name: 'shell', version: '0' } });
    expect(laptop.principal).toBe('owner');

    const phoneLink = await pair(['--data-dir', harness.dataDir]);
    expect(phoneLink.role).toBe('device');
  });

  test('a grant whose answer was lost gives the same session to a retry with the same nonce, and to nobody else', async () => {
    const sessions = harness.core.sessions;
    const client = { name: 'pwa', version: '0' };
    const nonce = 'n'.repeat(32);
    const { grant } = sessions.grant(1_000);

    // The first answer never reached the phone: its retry repeats the grant and the nonce.
    const first = sessions.exchange(grant, client, 2_000, nonce);
    const again = sessions.exchange(grant, client, 3_000, nonce);
    expect(again).toEqual(first);
    expect(harness.core.journal.listSessions()).toHaveLength(1);

    // Someone else holding the QR code has no nonce, or the wrong one.
    const refusedWith = (other: string | null, now = 3_000): string => {
      try {
        sessions.exchange(grant, client, now, other);
        return 'accepted';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const spent = 'the pairing link was already used, expired, or never issued';
    expect(refusedWith(null)).toBe(spent);
    expect(refusedWith('m'.repeat(32))).toBe(spent);
    // Past the time the grant had, even the right nonce is refused.
    expect(refusedWith(nonce, 1_000 + 10 * 60 * 1000)).toBe(spent);

    // Through the socket: once the key opens the core, the grant is spent for good.
    const owner = await harness.connect();
    const link = await owner.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant: link.grant, nonce });
    const retry = await connect(harness.url, '', { grant: link.grant, nonce });
    expect(retry.session).toEqual(phone.session);
    await connect(harness.url, phone.session?.token ?? '');
    let after = 'none';
    try {
      await connect(harness.url, '', { grant: link.grant, nonce });
    } catch (error) {
      after = (error as Error).message;
    }
    expect(after).toBe(spent);
    expect(harness.core.journal.listSessions()).toHaveLength(2);

    // A nonce too short to be a secret is refused, and the grant is not spent by it.
    const short = sessions.grant(Date.now());
    const failure = (run: () => unknown): RpcFailure | null => {
      try { run(); return null; } catch (error) { return error as RpcFailure; }
    };
    const tooShort = failure(() => sessions.exchange(short.grant, client, Date.now(), 'short'));
    expect(tooShort?.code).toBe(RpcErrorCode.InvalidParams);
    expect(tooShort?.message).toBe('nonce must be 16 to 256 characters, got 5');
    expect(failure(() => sessions.exchange(short.grant, client, Date.now(), 'x'.repeat(257)))?.message)
      .toBe('nonce must be 16 to 256 characters, got 257');
    expect(failure(() => sessions.exchange(short.grant, client, Date.now(), nonce))).toBeNull();
  });

  test('a hello whose nonce is unusable is refused by name, and the grant survives it', async () => {
    const owner = await harness.connect();
    const link = await owner.call('pairing.grant', {});
    const refusal = async (params: Record<string, unknown>): Promise<unknown> => {
      const socket = rawSocket();
      await opened(socket);
      const frame = firstFrame(socket);
      const closed = closeCode(socket);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: {
        protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' }, ...params,
      } }));
      const answer = await frame;
      expect(await closed).toBe(RpcCloseCode.Unauthorized);
      return answer.error;
    };
    const named = { code: RpcErrorCode.InvalidParams, data: { field: 'nonce', min: 16, max: 256 } };
    expect(await refusal({ grant: link.grant, nonce: 'short' }))
      .toEqual({ ...named, message: 'nonce must be 16 to 256 characters, got 5' });
    expect(await refusal({ grant: link.grant, nonce: 42 }))
      .toEqual({ ...named, message: 'nonce must be a string of 16 to 256 characters, got number' });
    expect(await refusal({ token: harness.token, nonce: 'n'.repeat(32) }))
      .toEqual({ ...named, message: 'nonce goes with a grant; a hello with a token takes none' });
    // None of that spent the grant.
    const phone = await connect(harness.url, '', { grant: link.grant, nonce: 'n'.repeat(32) });
    expect(phone.session?.token).toBeDefined();
  });

  test('a grant expires, and hello with both a token and a grant is refused', async () => {
    const grant = harness.core.sessions.grant(1_000);
    let expired = 'none';
    try {
      harness.core.sessions.exchange(grant.grant, { name: 'pwa', version: '0' }, 1_000 + 10 * 60 * 1000);
    } catch (error) {
      expired = (error as Error).message;
    }
    expect(expired).toBe('the pairing link was already used, expired, or never issued');

    const socket = rawSocket();
    await opened(socket);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: {
      token: harness.token, grant: 'x', protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' },
    } }));
    const frame = (await firstFrame(socket)) as { error?: { code: number; message: string } };
    expect(frame.error?.message).toBe('hello takes a token, a grant or a group ticket, one of the three');
    expect(await closeCode(socket)).toBe(RpcCloseCode.Unauthorized);
  });

  test('an unknown method answers MethodNotFound', async () => {
    const client = await harness.connect();
    let failure = 'none';
    try {
      await client.call('does.not.exist' as 'projects.list', {} as Record<string, never>);
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toContain('unknown method');
  });
});
