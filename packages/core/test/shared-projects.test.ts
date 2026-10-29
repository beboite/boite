import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedProjectRef } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';
import { unavailable } from '../src/errors.ts';

const cores: TestCore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const core of cores.splice(0).reverse()) await core.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function side(name: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-shared-'));
  dirs.push(dataDir);
  const h = await startTestCore({ dataDir });
  cores.push(h);
  const client = await h.connect();
  const path = join(dataDir, 'project');
  mkdirSync(path);
  const project = await client.call('projects.add', { path, name });
  // Deliberate collision in both databases, including the canonical thread id.
  h.core.journal.db.run('UPDATE projects SET id = ? WHERE id = ?', ['prj_collision', project.id]);
  const account = h.core.accounts.list().find(a => a.providerId === 'echo')!;
  const thread = await client.call('threads.create', { projectId: 'prj_collision', providerId: 'echo', accountId: account.id, title: `${name} work` });
  h.core.journal.db.run('UPDATE threads SET id = ? WHERE id = ?', ['thr_collision', thread.id]);
  h.core.contacts.setSettings({ minTier: 2 });
  const coreId = h.core.coordination.card().coreId;
  const ref: SharedProjectRef = { ownerCoreId: coreId, coreId, projectId: 'prj_collision' };
  return { h, client, ref, coreId, threadId: 'thr_collision' };
}

async function pair() {
  const a = await side('alpha');
  const b = await side('bravo');
  a.h.core.contacts.selfUrl = async () => a.h.url;
  await b.client.call('contacts.join', { link: (await a.client.call('contacts.invite', {})).link });
  await waitFor(() => a.h.core.contacts.linked(b.coreId));
  await a.client.call('contacts.grant', { coreId: b.coreId, projectId: a.ref.projectId });
  await b.client.call('contacts.grant', { coreId: a.coreId, projectId: b.ref.projectId });
  await waitFor(() => a.h.core.contacts.find(b.coreId)?.capabilities?.sharedProjects === 1 && b.h.core.contacts.find(a.coreId)?.capabilities?.sharedProjects === 1);
  return { a, b };
}

async function associated() {
  const { a, b } = await pair();
  const offered = await a.client.call('sharedProjects.offer', { coreId: b.coreId, projectId: a.ref.projectId, remote: b.ref, requestId: 'offer' });
  const scope = { threadId: a.threadId, sharedProjectId: offered.shared.id };
  await b.client.call('sharedProjects.decide', { sharedProjectId: offered.shared.id, accept: true, requestId: 'accept' });
  return { a, b, offered, scope };
}

test.each(['unsubscribe', 'disconnect'] as const)('a current grant revision closes the peer lease on %s', async action => {
  const {a,b,scope}=await associated();
  await a.client.call('sharedProjects.subscribe',{...scope,enabled:true});
  await b.client.call('sharedProjects.configure',{sharedProjectId:scope.sharedProjectId,board:true});
  await waitFor(()=>a.h.core.sharedProjects.require(scope.sharedProjectId).access[1].revision===b.h.core.sharedProjects.require(scope.sharedProjectId).access[1].revision);
  if(action==='unsubscribe') await a.client.call('sharedProjects.subscribe',{...scope,enabled:false});
  else a.client.close();
  await b.client.call('threads.update',{threadId:b.threadId,title:'After unsubscribe'});
  await new Promise(resolve=>setTimeout(resolve,250));
  const subscriptions=b.h.core.sharedProjects.subscriptions as unknown as {leases:Map<string,unknown>;timer:unknown};
  expect(subscriptions.leases.size).toBe(0);
  expect(subscriptions.timer).toBeNull();
},30000);

test('two owners explicitly associate colliding ids; scoped threads and readThreads never expose private projects', async () => {
  const { a, b, offered, scope } = await associated();
  expect((await a.client.call('sharedProjects.get', scope)).shared.state).toBe('active');
  expect(offered.shared.authority).toEqual(a.ref);
  expect(a.h.core.contacts.find(b.coreId)?.grants[0]?.readThreads).toBe(false);
  const privatePath = join(b.h.dataDir, 'private');
  mkdirSync(privatePath);
  const privateProject = await b.client.call('projects.add', { path: privatePath, name: 'private-project' });
  const account = b.h.core.accounts.list().find(ac => ac.providerId === 'echo')!;
  const privateThread = await b.client.call('threads.create', { projectId: privateProject.id, providerId: 'echo', accountId: account.id, title: 'private-thread' });
  // Even a separate ordinary Contact grant does not widen this association.
  await b.client.call('contacts.grant', { coreId: a.coreId, projectId: privateProject.id, readThreads: true });
  const directory = await a.client.call('sharedProjects.threads', scope);
  expect(directory.unavailable).toEqual([]);
  expect(directory.threads.map(t => t.ref.project.coreId).sort()).toEqual([a.coreId, b.coreId].sort());
  expect(directory.threads.every(t => t.ref.threadId === 'thr_collision')).toBe(true);
  expect(directory.threads.every(t => t.ref.address.coreId === t.ref.project.coreId)).toBe(true);
  expect(JSON.stringify(directory)).not.toMatch(/private-project|private-thread|PUBLIC KEY|coordination-key|accountId|token/);
  const remote = directory.threads.find(t => t.ref.project.coreId === b.coreId)!;
  expect(await thrown(a.client.call('sharedProjects.read', { ...scope, target: remote.ref }))).toThrow('readThreads');
  const local = directory.threads.find(t => t.ref.project.coreId === a.coreId)!;
  expect((await a.client.call('sharedProjects.read', { ...scope, target: local.ref })).contact.coreId).toBe(a.coreId);
  const request = b.h.core.coordination.request.bind(b.h.core.coordination);
  const accessQueued = Promise.withResolvers<void>(), releaseAccess = Promise.withResolvers<void>();
  b.h.core.coordination.request = async (peer, operation, payload) => {
    if (operation === 'contact.project' && (payload as {method?: string}).method === 'access') {
      accessQueued.resolve();
      await releaseAccess.promise;
    }
    return request(peer, operation, payload);
  };
  try {
    await b.client.call('contacts.grant', { coreId: a.coreId, projectId: b.ref.projectId, readThreads: true });
    await accessQueued.promise;
    // The owner RPC commits locally; the peer must reject the old revision
    // until its durable access notification has been delivered.
    expect(await thrown(a.client.call('sharedProjects.read', { ...scope, target: remote.ref }))).toThrow('grantRevision');
    releaseAccess.resolve();
    await b.h.core.sharedProjects.flush(a.coreId);
    expect((await a.client.call('sharedProjects.read', { ...scope, target: remote.ref })).contact.coreId).toBe(b.coreId);
  } finally {
    releaseAccess.resolve();
    b.h.core.coordination.request = request;
  }
  expect(await thrown(a.client.call('sharedProjects.read', { ...scope, target: { project: { ...b.ref, projectId: privateProject.id }, threadId: privateThread.id, address: { coreId: b.coreId, threadId: privateThread.id } } }))).toThrow('target.project');
  await a.client.call('contacts.update', { coreId: b.coreId, name: 'Renamed contact' });
  expect((await a.client.call('sharedProjects.get', scope)).contact.name).toBe('Renamed contact');
  expect((await a.h.core.coordination.directory(a.threadId)).agents.filter(t => t.coreId === b.coreId).map(t => t.sharedThread?.project)).toEqual([b.ref]);
  const agent = await connect(a.h.url, a.h.core.agents.tokenFor(a.threadId));
  try {
    expect(await thrown(agent.call('sharedProjects.decide', { sharedProjectId: scope.sharedProjectId, accept: true, requestId: 'forged' }))).toThrow('agent');
    expect(await thrown(agent.call('sharedProjects.threads', { ...scope, threadId: 'thr_other' }))).toThrow('thr_collision');
  } finally { agent.close(); }
}, 30000);

test('chat search is scoped to the destination project and its current readThreads grant', async () => {
  const { a, b, scope } = await associated();
  b.h.core.journal.putMessage({ id: 'msg_shared', threadId: b.threadId, turnId: 'turn_fixture', role: 'assistant', state: 'complete', parts: [{ type: 'text', text: 'confidentialmarker' }], createdAt: Date.now() });
  expect((await a.client.call('sharedProjects.search', { ...scope, query: 'confidentialmarker' })).matches).toEqual([]);
  expect((await a.h.core.coordination.search(a.threadId, 'confidentialmarker')).matches).toEqual([]);
  await b.client.call('contacts.grant', { coreId: a.coreId, projectId: b.ref.projectId, readThreads: true });
  await b.h.core.sharedProjects.flush(a.coreId);
  const matches = (await a.client.call('sharedProjects.search', { ...scope, query: 'confidentialmarker' })).matches;
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ coreId: b.coreId, threadId: b.threadId, sharedThread: { project: b.ref }, matched: ['chat'] });
  expect((await a.h.core.coordination.search(a.threadId, 'confidentialmarker')).matches[0]?.sharedThread?.project).toEqual(b.ref);
  expect((await a.h.core.coordination.read(a.threadId, { coreId: b.coreId, threadId: b.threadId })).entries[0]?.text).toBe('confidentialmarker');
  await b.client.call('contacts.grant', { coreId: a.coreId, projectId: b.ref.projectId, readThreads: false });
  await b.h.core.sharedProjects.flush(a.coreId);
  expect((await a.client.call('sharedProjects.search', { ...scope, query: 'confidentialmarker' })).matches).toEqual([]);
}, 30000);

test('consent is explicit and idempotent; trusted contacts cannot accept or widen either endpoint', async () => {
  const { a, b } = await pair();
  const params = { coreId: b.coreId, projectId: a.ref.projectId, remote: b.ref, requestId: 'same-offer' };
  const offered = await a.client.call('sharedProjects.offer', params);
  expect((await a.client.call('sharedProjects.offer', params)).shared.id).toBe(offered.shared.id);
  const scope = { threadId: a.threadId, sharedProjectId: offered.shared.id };
  await b.client.call('contacts.update', { coreId: a.coreId, trusted: true });
  expect((await a.client.call('sharedProjects.get', scope)).shared.state).toBe('pending');
  expect(await thrown(a.client.call('sharedProjects.threads', scope))).toThrow('not active');
  expect(await thrown(a.client.call('sharedProjects.decide', { sharedProjectId: offered.shared.id, accept: true, requestId: 'bad-accept' }))).toThrow('incoming pending');
  const p = { sharedProjectId: offered.shared.id, accept: true, requestId: 'accept' };
  expect((await b.client.call('sharedProjects.decide', p)).shared.state).toBe('active');
  expect((await b.client.call('sharedProjects.decide', p)).shared.state).toBe('active');
  expect(await thrown(b.client.call('sharedProjects.decide', { ...p, accept: false }))).toThrow('different content');
  expect(await thrown(a.client.call('sharedProjects.offer', { ...params, remote: { ...b.ref, projectId: 'different-project' } }))).toThrow('different content');
  const ctx = a.h.core.sharedProjects.scope(scope);
  const peer = a.h.core.contacts.peers()[0]!;
  expect(await thrown(a.h.core.coordination.request(peer, 'contact.project', { method: 'settings.set', requestId: 'control', sharedProjectId: offered.shared.id, grantRevision: 1, source: ctx.source, params: { token: 'fixture-only' } }))).toThrow('not supported');
  expect(await thrown(a.h.core.coordination.request(peer, 'contact.project', { method: 'threads', requestId: 'bad-revision', sharedProjectId: offered.shared.id, grantRevision: 999, source: ctx.source, params: {} }))).toThrow('grantRevision');
  expect(await thrown(a.h.core.coordination.request(peer, 'contact.project', { method: 'access', requestId: 'widen', sharedProjectId: offered.shared.id, grantRevision: 1, source: { kind: 'human', project: a.ref }, params: { access: { ...ctx.shared.access[0], project: b.ref, board: true, revision: 2 } } }))).toThrow('access');
  expect((await a.client.call('sharedProjects.get', scope)).shared.access.every(ac => !ac.board && !ac.compute.enabled)).toBe(true);
}, 30000);

test('both owners keep model tiers and source/target communication, archive and project boundaries', async () => {
  const { a, b, scope } = await associated();
  const agent = await connect(a.h.url, a.h.core.agents.tokenFor(a.threadId));
  try {
    a.h.core.contacts.setSettings({ minTier: 1 });
    expect(await thrown(agent.call('sharedProjects.threads', scope))).toThrow('tier 2');
    a.h.core.contacts.setSettings({ minTier: 2 });
    b.h.core.contacts.setSettings({ minTier: 1 });
    expect(await thrown(agent.call('sharedProjects.threads', scope))).toThrow('tier 1');
    b.h.core.contacts.setSettings({ minTier: 2 });
    const config = b.h.core.coordination.config(b.threadId);
    b.h.core.coordination.configure(b.threadId, { ...config, remote: false });
    expect((await agent.call('sharedProjects.threads', scope)).threads.map(t => t.ref.project)).toEqual([a.ref]);
    b.h.core.coordination.configure(b.threadId, { ...config, mode: 'off' });
    expect((await agent.call('sharedProjects.threads', scope)).threads.map(t => t.ref.project)).toEqual([a.ref]);
    b.h.core.coordination.configure(b.threadId, config);
    b.h.core.journal.db.run('UPDATE threads SET archived=1 WHERE id=?', [b.threadId]);
    expect((await agent.call('sharedProjects.threads', scope)).threads.map(t => t.ref.project)).toEqual([a.ref]);
    b.h.core.journal.db.run('UPDATE threads SET archived=0 WHERE id=?', [b.threadId]);
    a.h.core.coordination.configure(a.threadId, { ...a.h.core.coordination.config(a.threadId), remote: false });
    expect(await thrown(agent.call('sharedProjects.threads', scope))).toThrow('remote coordination');
  } finally { agent.close(); }
}, 30000);

test('revocation closes the immutable association, including bare legacy reads, and a new grant cannot revive it', async () => {
  const { a, b, scope } = await associated();
  const remote = (await a.client.call('sharedProjects.threads', scope)).threads.find(t => t.ref.project.coreId === b.coreId)!;
  await b.client.call('contacts.revoke', { coreId: a.coreId, projectId: b.ref.projectId });
  expect(await thrown(b.client.call('sharedProjects.threads', { ...scope, threadId: b.threadId }))).toThrow('not active');
  await waitFor(() => a.h.core.sharedProjects.require(scope.sharedProjectId).state === 'revoked');
  expect(await thrown(a.client.call('sharedProjects.read', { ...scope, target: remote.ref }))).toThrow('not active');
  const peer = a.h.core.contacts.peers()[0]!;
  expect(await thrown(a.h.core.coordination.request(peer, 'directory', {}))).toThrow('scoped contact.project');
  await b.client.call('contacts.grant', { coreId: a.coreId, projectId: b.ref.projectId, readThreads: true });
  expect((await a.client.call('sharedProjects.get', scope)).shared.state).toBe('revoked');
  const fresh = await a.client.call('sharedProjects.offer', { coreId: b.coreId, projectId: a.ref.projectId, remote: b.ref, requestId: 'fresh-offer' });
  expect(fresh.shared.id).not.toBe(scope.sharedProjectId);
  expect(fresh.shared.state).toBe('pending');
}, 30000);

test('a buffered read cannot return data after readThreads or its local source grant changed', async () => {
  const { a, b, scope } = await associated();
  await b.client.call('contacts.grant', { coreId: a.coreId, projectId: b.ref.projectId, readThreads: true });
  await b.h.core.sharedProjects.flush(a.coreId);
  const target = (await a.client.call('sharedProjects.threads', scope)).threads.find(t => t.ref.project.coreId === b.coreId)!.ref;
  const original = a.h.core.coordination.request.bind(a.h.core.coordination);
  let changed = false;
  a.h.core.coordination.request = async (peer, operation, payload) => {
    const result = await original(peer, operation, payload);
    if (operation === 'contact.project' && (payload as { method?: string }).method === 'read' && !changed) {
      changed = true;
      b.h.core.contacts.grant({ coreId: a.coreId, projectId: b.ref.projectId, readThreads: false });
    }
    return result;
  };
  try { expect(await thrown(a.client.call('sharedProjects.read', { ...scope, target }))).toThrow('grant'); }
  finally { a.h.core.coordination.request = original; }
  await b.client.call('contacts.grant', { coreId: a.coreId, projectId: b.ref.projectId, readThreads: true });
  await waitFor(() => a.h.core.sharedProjects.require(scope.sharedProjectId).access[1].revision === b.h.core.sharedProjects.require(scope.sharedProjectId).access[1].revision);
  a.h.core.coordination.request = async (peer, operation, payload) => {
    const result = await original(peer, operation, payload);
    if (operation === 'contact.project' && (payload as { method?: string }).method === 'read') a.h.core.contacts.revoke({ coreId: b.coreId, projectId: a.ref.projectId });
    return result;
  };
  try { expect(await thrown(a.client.call('sharedProjects.read', { ...scope, target }))).toThrow('not active'); }
  finally { a.h.core.coordination.request = original; }
}, 30000);

test('subscriptions invalidate only their connection/source/association and release on unsubscribe, move and disconnect', async () => {
  const { a, b, scope } = await associated();
  const { grant } = await a.client.call('pairing.grant', {});
  const other = await connect(a.h.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  const events: unknown[] = [], leaked: unknown[] = [];
  const off = a.client.on('sharedProjects.changed', p => events.push(p));
  const offOther = other.on('sharedProjects.changed', p => leaked.push(p));
  try {
    expect((await other.call('sharedProjects.threads', scope)).threads.map(t => t.ref.project)).toEqual([a.ref, b.ref]);
    expect(await thrown(other.call('sharedProjects.revoke', { sharedProjectId: scope.sharedProjectId, requestId: 'phone-revoke' }))).toThrow('owner only');
    await a.client.call('sharedProjects.subscribe', { ...scope, enabled: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    events.length = 0;
    await b.client.call('threads.update', { threadId: b.threadId, title: 'changed remotely' });
    await waitFor(() => events.length > 0);
    expect(events.every(p => JSON.stringify(p) === JSON.stringify({...scope,kinds:['threads']}))).toBe(true);
    expect(leaked).toEqual([]);
    await a.client.call('sharedProjects.subscribe', { ...scope, enabled: false });
    await new Promise(resolve => setTimeout(resolve, 150));
    events.length = 0;
    await b.client.call('threads.update', { threadId: b.threadId, title: 'after unsubscribe' });
    // Accidental future use of the global bus must not leak association ids either.
    a.h.core.bus.emit('sharedProjects.changed', scope);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(events).toEqual([]); expect(leaked).toEqual([]);
    await other.call('sharedProjects.subscribe', { ...scope, enabled: true });
    await b.client.call('threads.update', { threadId: b.threadId, title: 'subscribed phone' });
    await waitFor(() => leaked.length > 0);
    expect(leaked.every(p => JSON.stringify(p) === JSON.stringify({...scope,kinds:['threads']}))).toBe(true);
    other.close();
    await new Promise(resolve => setTimeout(resolve, 150));
    const original = b.h.core.coordination.request.bind(b.h.core.coordination);
    let notifications = 0;
    b.h.core.coordination.request = (peer, operation, payload) => {
      if (operation === 'contact.project' && (payload as { method?: string }).method === 'changed') notifications += 1;
      return original(peer, operation, payload);
    };
    try {
      await b.client.call('threads.update', { threadId: b.threadId, title: 'after disconnect' });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(notifications).toBe(0);
    } finally { b.h.core.coordination.request = original; }
    await a.client.call('sharedProjects.subscribe', { ...scope, enabled: true });
    a.h.core.journal.db.run('UPDATE threads SET project_id=NULL WHERE id=?', [a.threadId]);
    a.h.core.bus.emit('collaboration.changed', { threadId: a.threadId });
    await waitFor(() => events.length > 0);
    events.length = 0;
    await new Promise(resolve => setTimeout(resolve, 150));
    await b.client.call('threads.update', { threadId: b.threadId, title: 'after source moved' });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(events).toEqual([]);
  } finally { off(); offOther(); other.close(); }
}, 30000);

test('an active association remains readable after restart; a reconnected subscriber receives fresh scoped changes', async () => {
  const { a, b, scope } = await associated();
  await b.client.call('contacts.grant', { coreId: a.coreId, projectId: b.ref.projectId, readThreads: true });
  await b.h.core.sharedProjects.flush(a.coreId);
  const events: unknown[] = [];
  const off = a.client.on('sharedProjects.changed', p => events.push(p));
  await a.client.call('sharedProjects.subscribe', { ...scope, enabled: true });
  // Simulate peers upgrading from a stored pre-capability contact relationship.
  for (const side of [a, b]) side.h.core.journal.setSetting('contacts', side.h.core.contacts.list().map(({ capabilities: _caps, ...contact }) => contact));
  await b.h.stop();
  await waitFor(() => !a.h.core.contacts.linked(b.coreId));
  expect((await a.client.call('sharedProjects.threads', scope)).unavailable).toEqual([b.ref]);
  const restarted = await startTestCore({ dataDir: b.h.dataDir }); cores.push(restarted);
  await waitFor(() => a.h.core.contacts.linked(b.coreId), 10000);
  await waitFor(() => a.h.core.contacts.find(b.coreId)?.capabilities?.sharedProjects === 1 && restarted.core.contacts.find(a.coreId)?.capabilities?.sharedProjects === 1);
  const client = await restarted.connect();
  expect((await client.call('sharedProjects.get', { ...scope, threadId: b.threadId })).shared.state).toBe('active');
  await waitFor(() => events.length > 0);
  await new Promise(resolve => setTimeout(resolve, 150));
  events.length = 0;
  await client.call('threads.update', { threadId: b.threadId, title: 'after restart' });
  await waitFor(() => events.length > 0);
  const target = (await a.client.call('sharedProjects.threads', scope)).threads.find(t => t.ref.project.coreId === b.coreId)!.ref;
  expect((await a.client.call('sharedProjects.read', { ...scope, target })).contact.title).toBe('after restart');
  off();
}, 30000);

test('an enable delayed behind unsubscribe cannot recreate the peer lease', async () => {
  const { a, b, scope } = await associated();
  const original = a.h.core.coordination.request.bind(a.h.core.coordination);
  let enablePending = false, disabled = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  a.h.core.coordination.request = async (peer, operation, payload) => {
    const p = payload as { method?: string; params?: { enabled?: boolean } };
    if (operation === 'contact.project' && p.method === 'subscribe' && p.params?.enabled === true) { enablePending = true; await held; }
    const result = await original(peer, operation, payload);
    if (operation === 'contact.project' && p.method === 'subscribe' && p.params?.enabled === false) disabled = true;
    return result;
  };
  let notifications = 0;
  const send = b.h.core.coordination.request.bind(b.h.core.coordination);
  b.h.core.coordination.request = (peer, operation, payload) => {
    if (operation === 'contact.project' && (payload as { method?: string }).method === 'changed') notifications += 1;
    return send(peer, operation, payload);
  };
  try {
    const subscribe = a.client.call('sharedProjects.subscribe', { ...scope, enabled: true });
    await waitFor(() => enablePending);
    await a.client.call('sharedProjects.subscribe', { ...scope, enabled: false });
    await waitFor(() => disabled);
    release(); await subscribe;
    await b.client.call('threads.update', { threadId: b.threadId, title: 'after reordered unsubscribe' });
    b.h.core.sharedProjects.notify(scope.sharedProjectId, ['threads']);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(notifications).toBe(0);
  } finally { release(); a.h.core.coordination.request = original; b.h.core.coordination.request = send; }
}, 30000);

test('associations and an offline revocation survive a full guest restart and replay once on reconnect', async () => {
  const { a, b, scope } = await associated();
  const original = b.h.core.coordination.request.bind(b.h.core.coordination);
  b.h.core.coordination.request = (peer, operation, payload) => operation === 'contact.project' ? Promise.reject(unavailable('fixture offline')) : original(peer, operation, payload);
  await b.client.call('sharedProjects.revoke', { sharedProjectId: scope.sharedProjectId, requestId: 'offline-revoke' });
  expect(a.h.core.sharedProjects.require(scope.sharedProjectId).state).toBe('active');
  expect(b.h.core.sharedProjects.journal.queued(a.coreId)).toHaveLength(1);
  await b.h.stop();
  await waitFor(() => !a.h.core.contacts.linked(b.coreId));
  const restarted = await startTestCore({ dataDir: b.h.dataDir }); cores.push(restarted);
  expect(restarted.core.coordination.card().coreId).toBe(b.coreId);
  expect(restarted.core.sharedProjects.require(scope.sharedProjectId).state).toBe('revoked');
  await waitFor(() => a.h.core.sharedProjects.require(scope.sharedProjectId).state === 'revoked', 10000);
  await waitFor(() => restarted.core.sharedProjects.journal.queued(a.coreId).length === 0);
  const client = await restarted.connect();
  expect((await client.call('sharedProjects.revoke', { sharedProjectId: scope.sharedProjectId, requestId: 'offline-revoke' })).shared.state).toBe('revoked');
  expect(restarted.core.sharedProjects.journal.queued(a.coreId)).toHaveLength(0);
}, 30000);
