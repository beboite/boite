import { expect, spyOn, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import { echoThread, holdAccountTurns, startTestCore, waitFor, type TestCore } from './harness.ts';

function ask(h: TestCore): Promise<Response> {
  return fetch(`${h.url}/shutdown-if-idle?pid=${process.pid}`, { method: 'POST', headers: { authorization: `Bearer ${h.token}` } });
}

function trustedPeer(h: TestCore) {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const coreId = createHash('sha256').update(publicKey).digest('hex');
  h.core.coordination.trust({ coreId, name: 'Peer', publicKey, url: 'http://127.0.0.1:1' });
  return { coreId, privateKey: keys.privateKey };
}

test('an update lets running and queued turns finish before admitting shutdown', async () => {
  let stops = 0;
  const h = await startTestCore({ onShutdown: () => { stops += 1; } });
  let release: (() => void) | undefined;
  try {
    const client = await h.connect();
    const first = await echoThread(h, client, 'first');
    const second = await echoThread(h, client, 'queued');
    await client.call('threads.subscribe', { threadId: first.threadId });
    await client.call('threads.subscribe', { threadId: second.threadId });
    const finished = client.next('turn.finished', turn => turn.threadId === first.threadId);
    const queuedFinished = client.next('turn.finished', turn => turn.threadId === second.threadId);
    void finished.catch(() => undefined); void queuedFinished.catch(() => undefined);
    await client.call('turns.start', { threadId: first.threadId, prompt: '[sleep:300] completes once' });
    release = holdAccountTurns(h, second.accountId);
    const queued = await client.call('turns.start', { threadId: second.threadId, prompt: 'also completes once' });
    expect(queued.status).toBe('queued');
    expect((await ask(h)).status).toBe(409);
    expect(h.core.stopping).toBe(false);
    expect(stops).toBe(0);
    expect((await finished).status).toBe('done');
    expect((await ask(h)).status).toBe(409);
    release(); release = undefined;
    expect((await queuedFinished).status).toBe('done');
    await waitFor(() => h.core.scheduler.state().running.length === 0);
    const accepted = await ask(h);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ ok: true, pid: process.pid });
    await waitFor(() => stops === 1);
    expect(h.core.journal.listTurns(first.threadId)).toHaveLength(1);
    expect(h.core.journal.listTurns(second.threadId)).toHaveLength(1);
  } finally { release?.(); await h.stop(); }
});

test('an update leaves a permission card answerable and its turn completes', async () => {
  const h = await startTestCore({ onShutdown: () => undefined });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('threads.subscribe', { threadId });
    const permission = client.next('permission.requested', request => request.threadId === threadId);
    const finished = client.next('turn.finished', turn => turn.threadId === threadId);
    void permission.catch(() => undefined); void finished.catch(() => undefined);
    await client.call('turns.start', { threadId, prompt: '[permission] finished after approval' });
    const card = await permission;
    expect((await ask(h)).status).toBe(409);
    await client.call('permissions.answer', { requestId: card.id, decision: 'allow' });
    expect((await finished).status).toBe('done');
  } finally { await h.stop(); }
});

test('an update waits for dependent workflow steps and their parent delivery', async () => {
  const h = await startTestCore({ onShutdown: () => undefined });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const thread = h.core.threads.require(threadId);
    await client.call('delegation.configure', { threadId, config: {
      ...DEFAULT_DELEGATION_CONFIG, enabled: true,
      profiles: [{ id: 'worker', name: 'Worker', providerId: 'echo', accountId: thread.accountId, model: thread.model!, effort: null }],
    } });
    const run = await client.call('workflows.start', { threadId, requestId: 'update-workflow', plan: {
      name: 'Finish both steps', steps: [
        { id: 'first', profile: 'worker', task: '[sleep:200] first step' },
        { id: 'second', profile: 'worker', after: ['first'], task: '[sleep:200] dependent step' },
      ],
    } });
    expect((await ask(h)).status).toBe(409);
    await waitFor(() => {
      const current = h.core.workflows.get(threadId, run.id);
      return current.status === 'done' && current.delivered && h.core.scheduler.state().running.length === 0;
    }, 10_000);
    const done = h.core.workflows.get(threadId, run.id);
    expect(done.nodes.map(node => node.status)).toEqual(['done', 'done']);
    for (const node of done.nodes) expect(h.core.journal.listTurns(node.instances[0]!.threadId!)).toHaveLength(1);
    expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
    expect((await ask(h)).status).toBe(202);
  } finally { await h.stop(); }
});

test('processes and reported background work block an update after the turn ends', async () => {
  const h = await startTestCore({ onShutdown: () => undefined });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const child = h.core.procs.spawn(threadId, process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { agentRoot: false });
    expect((await ask(h)).status).toBe(409);
    expect(h.core.stopping).toBe(false);
    await child.exited;
    await waitFor(() => h.core.procs.liveThreads().length === 0);
    h.core.threads.agentState.noteBackground(threadId, [{ id: 'task', kind: 'shell', description: 'Still working', toolId: null, startedAt: Date.now() }]);
    expect((await ask(h)).status).toBe(409);
    h.core.threads.agentState.noteBackground(threadId, []);
    expect((await ask(h)).status).toBe(202);
  } finally { await h.stop(); }
});

test('an in-flight RPC completes before the update barrier, which refuses later work', async () => {
  const h = await startTestCore({ onShutdown: () => undefined });
  let finish: (() => void) | undefined;
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    let entered = false;
    h.core.router.register('projects.list', async () => {
      entered = true;
      await new Promise<void>(resolve => { finish = resolve; });
      return [];
    });
    const inFlight = client.call('projects.list', {});
    void inFlight.catch(() => undefined);
    await waitFor(() => entered);
    expect((await ask(h)).status).toBe(409);
    finish!();
    await inFlight;
    expect((await ask(h)).status).toBe(202);
    expect(h.core.stopping).toBe(true);
    await expect(client.call('turns.start', { threadId, prompt: 'too late' })).rejects.toThrow('stopping');
    expect(() => h.core.procs.spawn(threadId, process.execPath, ['-e', '0'])).toThrow('stopping');
    expect(h.core.journal.listTurns(threadId)).toHaveLength(0);
  } finally { finish?.(); await h.stop(); }
});

test('idle shutdown requires owner authentication and a process owned by the core', async () => {
  const h = await startTestCore();
  try {
    const at = `${h.url}/shutdown-if-idle`;
    expect((await fetch(at)).status).toBe(405);
    expect((await fetch(at, { method: 'POST' })).status).toBe(401);
    expect((await fetch(at, { method: 'POST', headers: { authorization: `Bearer ${h.token}`, host: 'other.example' } })).status).toBe(403);
    expect((await fetch(`${at}?pid=1`, { method: 'POST', headers: { authorization: `Bearer ${h.token}` } })).status).toBe(412);
    expect((await ask(h)).status).toBe(501);
    expect(h.core.stopping).toBe(false);
  } finally { await h.stop(); }
});

test('an in-flight peer HTTP request completes before update admission', async () => {
  const h = await startTestCore({ onShutdown: () => undefined });
  let finish: (() => void) | undefined;
  const tracked = h.core.router.trackRequest.bind(h.core.router);
  let entered = false;
  const gate = spyOn(h.core.router, 'trackRequest').mockImplementation(<T>(work: () => T | Promise<T>): Promise<T> => tracked(async () => {
    entered = true;
    await new Promise<void>(resolve => { finish = resolve; });
    return work();
  }));
  try {
    const peer = trustedPeer(h);
    const body = JSON.stringify({ from: peer.coreId, to: h.core.coordination.identity().coreId, at: Date.now(), nonce: crypto.randomUUID(), operation: 'directory', payload: {} });
    const delivery = fetch(`${h.url}/agent-messages`, { method: 'POST', body, headers: {
      'x-boite-peer': peer.coreId, 'x-boite-signature': sign(null, Buffer.from(body), peer.privateKey).toString('base64'),
    } });
    void delivery.catch(() => undefined);
    await waitFor(() => entered);
    expect((await ask(h)).status).toBe(409);
    finish!();
    expect(await (await delivery).json()).toMatchObject({ result: [] });
    expect((await ask(h)).status).toBe(202);
    expect((await fetch(`${h.url}/agent-messages`, { method: 'POST' })).status).toBe(503);
  } finally { finish?.(); gate.mockRestore(); await h.stop(); }
});

test('a slow unauthenticated peer body cannot hold update admission', async () => {
  const h = await startTestCore({ onShutdown: () => undefined });
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pending: Promise<Response> | undefined;
  try {
    const peer = trustedPeer(h);
    let entered = false;
    const http = h.core.coordination.http.bind(h.core.coordination);
    h.core.coordination.http = request => { entered = true; return http(request); };
    const body = new ReadableStream<Uint8Array>({ start(stream) { controller = stream; stream.enqueue(new TextEncoder().encode('{')); } });
    pending = fetch(`${h.url}/agent-messages`, { method: 'POST', body, headers: { 'x-boite-peer': peer.coreId, 'x-boite-signature': 'invalid' } });
    void pending.catch(() => undefined);
    await waitFor(() => entered);
    expect((await ask(h)).status).toBe(202);
    controller!.close(); controller = undefined;
    expect((await pending).status).toBe(403);
  } finally { controller?.close(); await pending?.catch(() => undefined); await h.stop(); }
});

test('a peer authenticated after update admission cannot process its request', async () => {
  const h = await startTestCore({ onShutdown: () => undefined });
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pending: Promise<Response> | undefined;
  try {
    const peer = trustedPeer(h);
    const raw = JSON.stringify({ from: peer.coreId, to: h.core.coordination.identity().coreId, at: Date.now(), nonce: crypto.randomUUID(), operation: 'directory', payload: {} });
    let entered = false;
    const http = h.core.coordination.http.bind(h.core.coordination);
    h.core.coordination.http = request => { entered = true; return http(request); };
    const body = new ReadableStream<Uint8Array>({ start(stream) { controller = stream; stream.enqueue(new TextEncoder().encode(raw.slice(0, 1))); } });
    pending = fetch(`${h.url}/agent-messages`, { method: 'POST', body, headers: {
      'x-boite-peer': peer.coreId, 'x-boite-signature': sign(null, Buffer.from(raw), peer.privateKey).toString('base64'),
    } });
    void pending.catch(() => undefined);
    await waitFor(() => entered);
    expect((await ask(h)).status).toBe(202);
    controller!.enqueue(new TextEncoder().encode(raw.slice(1))); controller!.close(); controller = undefined;
    expect((await pending).status).toBe(503);
  } finally { controller?.close(); await pending?.catch(() => undefined); await h.stop(); }
});
