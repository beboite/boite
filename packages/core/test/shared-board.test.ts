import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedBoardCard, SharedBoardCommand, SharedProjectRef } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { unavailable } from '../src/errors.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

const cores: TestCore[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const core of cores.splice(0).reverse()) await core.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function side(name: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-board-')); dirs.push(dataDir);
  const h = await startTestCore({ dataDir }); cores.push(h);
  const client = await h.connect();
  const path = join(dataDir, 'project'); mkdirSync(path);
  const project = await client.call('projects.add', { path, name });
  h.core.journal.db.run('UPDATE projects SET id=? WHERE id=?', ['prj_collision', project.id]);
  const account = h.core.accounts.list().find(a => a.providerId === 'echo')!;
  const thread = await client.call('threads.create', { projectId: 'prj_collision', providerId: 'echo', accountId: account.id, title: name });
  h.core.journal.db.run('UPDATE threads SET id=? WHERE id=?', ['thr_collision', thread.id]);
  h.core.contacts.setSettings({ minTier: 2 });
  const coreId = h.core.coordination.card().coreId;
  const ref: SharedProjectRef = { ownerCoreId: coreId, coreId, projectId: 'prj_collision' };
  return { h, client, ref, coreId, threadId: 'thr_collision' };
}
async function board() {
  const a = await side('alpha'), b = await side('bravo');
  a.h.core.contacts.selfUrl = async () => a.h.url;
  await b.client.call('contacts.join', { link: (await a.client.call('contacts.invite', {})).link });
  await waitFor(() => a.h.core.contacts.linked(b.coreId));
  await a.client.call('contacts.grant', { coreId: b.coreId, projectId: a.ref.projectId });
  await b.client.call('contacts.grant', { coreId: a.coreId, projectId: b.ref.projectId });
  await waitFor(() => a.h.core.contacts.find(b.coreId)?.capabilities?.sharedProjects === 1);
  const offered = await a.client.call('sharedProjects.offer', { coreId: b.coreId, projectId: a.ref.projectId, remote: b.ref, requestId: 'offer' });
  const scope = { threadId: a.threadId, sharedProjectId: offered.shared.id };
  await b.client.call('sharedProjects.decide', { sharedProjectId: offered.shared.id, accept: true, requestId: 'accept' });
  await a.client.call('sharedProjects.configure', { sharedProjectId: offered.shared.id, board: true });
  await b.client.call('sharedProjects.configure', { sharedProjectId: offered.shared.id, board: true });
  return { a, b, scope };
}
async function cards(client: Awaited<ReturnType<typeof side>>['client'], scope: {threadId: string; sharedProjectId: string}): Promise<SharedBoardCard[]> {
  const page = await client.call('sharedBoard.get', scope);
  if (page.kind !== 'snapshot') throw new Error('expected local snapshot');
  return page.cards;
}
const command = (kind: 'add' | 'update', requestId: string, text: string): SharedBoardCommand => ({ kind, requestId, cardId: 'card_collision', text });

test('a successful authority read reports local disk exhaustion instead of an offline snapshot', async () => {
  const {a, b, scope} = await board();
  const request = b.h.core.coordination.request.bind(b.h.core.coordination);
  b.h.core.coordination.request = (peer, op, payload) => op === 'contact.project' ? Promise.reject(unavailable('fixture offline')) : request(peer, op, payload);
  await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'disk-card', 'durable remote card')});
  const full = Object.assign(new Error('local board storage is full'), {code: 'SQLITE_FULL'});
  let transported = false;
  b.h.core.coordination.request = async (...args) => {
    const result = await request(...args);
    if (args[1] === 'contact.project' && (args[2] as {method?: string}).method === 'board.get') transported = true;
    return result;
  };
  const append = spyOn(b.h.core.sharedBoard.journal, 'append').mockImplementation(() => {throw full;});
  try {
    expect(await thrown(b.h.core.sharedBoard.get(scope))).toThrow(full);
    expect(transported).toBe(true);
  } finally {append.mockRestore(); b.h.core.coordination.request = request;}
}, 30000);

test.each([null, 'updated text'])('a Todo hidden by a queued removal refuses update %s', async text => {
  const {a, b, scope} = await board();
  await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'hidden-card', 'shared')});
  await cards(b.client, scope);
  const request = b.h.core.coordination.request.bind(b.h.core.coordination);
  b.h.core.coordination.request = (peer, op, payload) => op === 'contact.project' ? Promise.reject(unavailable('fixture offline')) : request(peer, op, payload);
  try {
    expect((await b.client.call('sharedBoard.apply', {...scope, command: {kind: 'remove', cardId: 'card_collision', requestId: 'pending-remove'}})).outcome).toBe('queued');
    expect(b.h.core.sharedBoard.journal.entry(scope.sharedProjectId, 'card_collision')?.kind).toBe('card');
    expect(await thrown(b.client.call('todos.update', {...scope, todoId: 'card_collision', ...(text === null ? {goalThreadId: null} : {text})}))).toThrow('todoId: expected a live shared card');
  } finally {b.h.core.coordination.request = request;}
}, 30000);

test.each([0, 150])('an acknowledged board edit reports local receipt storage exhaustion after a %i ms acknowledgement', async delay => {
  const {a, b, scope} = await board();
  await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'receipt-card', 'shared')});
  await cards(b.client, scope);
  const request = b.h.core.sharedProjects.request.bind(b.h.core.sharedProjects);
  b.h.core.sharedProjects.request = async (...args) => {
    const result = await request(...args);
    if (args[1] === 'board.apply' && delay) await Bun.sleep(delay);
    return result;
  };
  const full = Object.assign(new Error('local receipt storage is full'), {code: 'SQLITE_FULL'});
  const settle = spyOn(b.h.core.sharedBoard.journal, 'settle').mockImplementation(() => {throw full;});
  try {
    expect(await thrown((async () => {
      const receipt = await b.h.core.sharedBoard.apply({...scope, command: command('update', 'disk-edit', 'accepted remotely')});
      // An edit may return queued before the remote acknowledgement. A read
      // drains that same durable queue, so it must still report the disk error.
      if (receipt.outcome === 'queued') await b.h.core.sharedBoard.get(scope);
    })())).toThrow(full);
    expect(b.h.core.sharedBoard.journal.pending(scope.sharedProjectId)).toHaveLength(1);
    expect((await cards(a.client, scope))[0]!.text).toBe('accepted remotely');
  } finally {settle.mockRestore(); b.h.core.sharedProjects.request = request;}
}, 30000);

test('two simultaneous canonical claims reserve one worker and retries start exactly one goal', async () => {
  const { a, b, scope } = await board();
  const added = await a.client.call('sharedBoard.apply', { ...scope, command: command('add', 'add', 'one task') });
  const claim = (s: typeof a, requestId: string): SharedBoardCommand => ({ kind: 'claim', requestId, cardId: 'card_collision', expectedRevision: added.revision, worker: { project: s.ref, threadId: s.threadId, address: { coreId: s.coreId, threadId: s.threadId } } });
  const attempts = await Promise.all([a.client.call('sharedBoard.apply', { ...scope, command: claim(a, 'claim-a') }), b.client.call('sharedBoard.apply', { ...scope, command: claim(b, 'claim-b') })]);
  expect(attempts.map(x => x.outcome).sort()).toEqual(['applied', 'conflict']);
  const winner = attempts[0]!.outcome === 'applied' ? a : b;
  const claimId = attempts.find(x => x.outcome === 'applied')!.card!.assignment!.claimId;
  let starts = 0;
  const set = winner.h.core.activity.set.bind(winner.h.core.activity);
  winner.h.core.activity.set = (p, claim) => { starts++; return set(p, claim); };
  const start = { ...scope, cardId: 'card_collision', claimId };
  await Promise.all([winner.client.call('sharedBoard.start', start), winner.client.call('sharedBoard.start', start)]);
  expect(starts).toBe(1);
  expect((await cards(a.client, scope))[0]!.assignment?.worker.project).toEqual(winner.ref);
  expect((await cards(b.client, scope))[0]!.assignment?.claimId).toBe(claimId);
  expect((await cards(b.client, scope))[0]!.assignment?.workerInfo?.agent).toBeString();
  expect(await thrown((winner === a ? b : a).client.call('sharedBoard.start', start))).toThrow('worker');
}, 30000);

test('offline edits are durable, merge distinct fields and converge after a real restart without resurrecting deletions', async () => {
  const { a, b, scope } = await board();
  await a.client.call('sharedBoard.apply', { ...scope, command: command('add', 'add', 'initial') });
  await cards(b.client, scope);
  const original = b.h.core.coordination.request.bind(b.h.core.coordination);
  b.h.core.coordination.request = (peer, op, payload) => op === 'contact.project' ? Promise.reject(unavailable('fixture offline')) : original(peer, op, payload);
  expect((await b.client.call('sharedBoard.apply', { ...scope, command: command('update', 'offline-text', 'offline edit') })).outcome).toBe('queued');
  expect((await cards(b.client, scope))[0]).toMatchObject({ text: 'offline edit', pending: true });
  await a.client.call('sharedBoard.apply', { ...scope, command: { kind: 'update', requestId: 'owner-status', cardId: 'card_collision', status: 'claimed' } });
  await b.h.stop();
  const h = await startTestCore({ dataDir: b.h.dataDir }); cores.push(h);
  const client = await h.connect();
  await waitFor(() => a.h.core.contacts.linked(b.coreId), 10000);
  await h.core.sharedBoard.flush(a.coreId);
  expect((await cards(client, scope))[0]).toMatchObject({ text: 'offline edit', status: 'claimed' });
  expect(await cards(a.client, scope)).toEqual(await cards(client, scope));
  const remove: SharedBoardCommand = { kind: 'remove', requestId: 'remove', cardId: 'card_collision' };
  await a.client.call('sharedBoard.apply', { ...scope, command: remove });
  expect((await client.call('sharedBoard.apply', { ...scope, command: command('update', 'stale-edit', 'resurrect') })).outcome).toBe('deleted');
  expect((await client.call('sharedBoard.apply', { ...scope, command: command('add', 'stale-add', 'resurrect') })).outcome).toBe('deleted');
  expect(await cards(client, scope)).toEqual([]);
  expect(await cards(a.client, scope)).toEqual([]);
}, 30000);

test('receipts bind actor and content, revoked peers lose reads and writes, local todos keep their behavior', async () => {
  const { a, b, scope } = await board();
  const p = { ...scope, command: command('add', 'same', 'shared') };
  const first = await b.client.call('sharedBoard.apply', p);
  expect(await b.client.call('sharedBoard.apply', p)).toEqual(first);
  expect(await thrown(b.client.call('sharedBoard.apply', { ...scope, command: command('update', 'same', 'forged') }))).toThrow('different content');
  const local = await a.client.call('todos.add', { threadId: a.threadId, text: 'private local' });
  expect(await cards(b.client, scope)).toHaveLength(1);
  expect((await a.client.call('todos.list', { threadId: a.threadId })).some(t => t.id === local.id)).toBe(true);
  const agent = await connect(b.h.url, b.h.core.agents.tokenFor(b.threadId));
  try {
    expect(await thrown(agent.call('sharedBoard.apply', { ...scope, command: { kind: 'update', requestId: 'agent-done', cardId: 'card_collision', status: 'done' } }))).toThrow('user');
    expect(await thrown(agent.call('sharedBoard.apply', { ...scope, command: { kind: 'remove', requestId: 'agent-delete', cardId: 'card_collision' } }))).toThrow('user');
    expect(await thrown(agent.call('sharedBoard.get', { ...scope, threadId: 'thr_other' }))).toThrow('thr_collision');
  } finally { agent.close(); }
  await a.client.call('contacts.revoke', { coreId: b.coreId, projectId: a.ref.projectId });
  expect(await thrown(b.client.call('sharedBoard.get', scope))).toThrow('active');
  expect(await thrown(b.client.call('sharedBoard.apply', { ...scope, command: command('update', 'revoked', 'bad') }))).toThrow('active');
  expect((await a.client.call('todos.list', { threadId: a.threadId })).find(t => t.id === local.id)?.text).toBe('private local');
  const peer = b.h.core.contacts.peers().find(p => p.coreId === a.coreId)!;
  const forged = {sharedProjectId: scope.sharedProjectId, grantRevision: 2, source: {kind: 'human', project: b.ref}};
  expect(await thrown(b.h.core.coordination.request(peer, 'contact.project', {...forged, method: 'board.get', requestId: 'revoked-wire-read', params: {after: 0}}))).toThrow('active');
  expect(await thrown(b.h.core.coordination.request(peer, 'contact.project', {...forged, method: 'board.apply', requestId: 'revoked-wire-write', params: {command: command('update', 'revoked-wire-write', 'not allowed')}}))).toThrow('active');
}, 30000);

test('worker progress carries the existing checklist, orders sequences and cannot forge another host or revive a deletion', async () => {
  const { a, b, scope } = await board();
  const added = await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'add', 'tracked task')});
  const worker = {project: b.ref, threadId: b.threadId, address: {coreId: b.coreId, threadId: b.threadId}};
  const accepted = await b.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', requestId: 'worker-claim', cardId: 'card_collision', expectedRevision: added.revision, worker}});
  const claimId = accepted.card!.assignment!.claimId;
  const ctx = b.h.core.sharedProjects.scope(scope);
  const goal = {status: 'active' as const, reviewing: true, checklist: {threadId: 'private-tracker', phase: 'idle' as const, model: 'echo', effort: null, error: null, items: [{id: 1, text: 'run the check', source: 'one task', status: 'done' as const}]}};
  const p = {cardId: 'card_collision', claimId, worker, goal, sequence: 2, reviewPassedAt: null};
  const progress = await b.h.core.sharedProjects.request(ctx, 'board.progress', p, 'progress-two');
  const repeated = await b.h.core.sharedProjects.request(ctx, 'board.progress', p, 'new-envelope-same-progress');
  expect(repeated).toEqual(progress);
  expect((await cards(a.client, scope))[0]?.goal).toMatchObject({reviewing: true, checklist: {threadId: null, items: [{id: 1, status: 'done'}]}});
  expect((await b.h.core.sharedProjects.request(ctx, 'board.progress', {...p, goal: null, sequence: 1}, 'late-one')).outcome).toBe('conflict');
  expect(await thrown(b.h.core.sharedProjects.request(ctx, 'board.progress', {...p, goal: null}, 'same-sequence-different-data'))).toThrow('different content');
  const aCtx = a.h.core.sharedProjects.scope(scope);
  // An authenticated source of the wrong host still cannot attest the worker's goal.
  expect(await thrown(a.h.core.sharedBoard.core.sharedProjects.receive(b.coreId, {method: 'board.progress', requestId: 'wrong-worker', sharedProjectId: scope.sharedProjectId, grantRevision: aCtx.shared.access[0].revision, source: ctx.source,
    params: {...p, worker: {project: a.ref, threadId: a.threadId, address: {coreId: a.coreId, threadId: a.threadId}}, sequence: 3}}))).toThrow('worker');
  const completed = {...p, sequence: 3, goal: {...goal, status: 'complete' as const, reviewing: false}, reviewPassedAt: null};
  await b.h.core.sharedProjects.request(ctx, 'board.progress', completed, 'manual-complete');
  expect((await cards(a.client, scope))[0]?.status).toBe('open');
  // A worker clock can be arbitrarily behind the authority's. It identifies a verdict, not its ordering.
  await b.h.core.sharedProjects.request(ctx, 'board.progress', {...completed, sequence: 4, reviewPassedAt: 1}, 'review-pass');
  expect((await cards(a.client, scope))[0]?.status).toBe('claimed');
  await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'update', cardId: 'card_collision', requestId: 'resume-after-pass', status: 'open'}});
  await b.h.core.sharedProjects.request(ctx, 'board.progress', {...completed, sequence: 5, reviewPassedAt: 1}, 'same-pass-after-resume');
  expect((await cards(a.client, scope))[0]?.status).toBe('open');
  await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'remove', requestId: 'delete', cardId: 'card_collision'}});
  expect((await b.h.core.sharedProjects.request(ctx, 'board.progress', {...completed, sequence: 6}, 'after-delete')).outcome).toBe('deleted');
}, 30000);

test('lost acknowledgements replay once after an authority restart; tombstones and start receipts remain durable', async () => {
  const { a, b, scope } = await board();
  const original = b.h.core.coordination.request.bind(b.h.core.coordination);
  let lost = false;
  b.h.core.coordination.request = async (peer, operation, payload) => {
    const response = await original(peer, operation, payload);
    if (operation === 'contact.project' && (payload as {method?: string}).method === 'board.apply' && !lost) { lost = true; throw unavailable('fixture lost acknowledgement'); }
    return response;
  };
  const add = {...scope, command: command('add', 'lost-add', 'exactly once')};
  expect((await b.client.call('sharedBoard.apply', add)).outcome).toBe('queued');
  expect((await cards(a.client, scope))).toHaveLength(1);
  const before = a.h.core.sharedBoard.journal.revision(scope.sharedProjectId);
  await a.h.stop();
  const h = await startTestCore({dataDir: a.h.dataDir}); cores.push(h);
  h.core.contacts.selfUrl = async () => h.url;
  // The fixture's inviting host moved its ephemeral port. The contact store persists this new dial target.
  b.h.core.coordination.request = original;
  b.h.core.journal.setSetting('contacts', b.h.core.contacts.list().map(contact => contact.coreId === a.coreId ? {...contact, role: 'guest', url: h.url} : contact));
  await b.client.call('contacts.update', {coreId: a.coreId, name: 'authority restarted'});
  await b.h.core.sharedBoard.flush(a.coreId);
  expect((await b.client.call('sharedBoard.apply', add)).outcome).toBe('applied');
  expect(h.core.sharedBoard.journal.revision(scope.sharedProjectId)).toBe(before);
  const client = await h.connect();
  await client.call('sharedBoard.apply', {...scope, command: {kind: 'remove', requestId: 'durable-delete', cardId: 'card_collision'}});
  await h.stop();
  const h2 = await startTestCore({dataDir: a.h.dataDir}); cores.push(h2);
  const c2 = await h2.connect();
  expect((await c2.call('sharedBoard.apply', {...scope, command: command('add', 'old-id-new-operation', 'resurrect')})).outcome).toBe('deleted');
  expect(await cards(c2, scope)).toEqual([]);
}, 30000);

test('offline claims cannot start; a delayed admission loses authority on release and revoke', async () => {
  const { a, b, scope } = await board();
  const added = await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'add', 'reserved task')});
  await cards(b.client, scope);
  const original = b.h.core.coordination.request.bind(b.h.core.coordination);
  b.h.core.coordination.request = () => Promise.reject(unavailable('authority offline'));
  const worker = {project: b.ref, threadId: b.threadId, address: {coreId: b.coreId, threadId: b.threadId}};
  expect((await b.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', requestId: 'offline-claim', cardId: 'card_collision', expectedRevision: added.revision, worker}})).outcome).toBe('queued');
  expect((await b.client.call('sharedBoard.get', scope)).authorityAvailable).toBe(false);
  expect(await thrown(b.client.call('sharedBoard.start', {...scope, cardId: 'card_collision', claimId: 'offline-claim'}))).toThrow('offline');
  expect(b.h.core.activity.get(b.threadId).goal).toBeNull();
  b.h.core.coordination.request = original;
  await b.h.core.sharedBoard.flush(a.coreId);
  const claimId = (await cards(b.client, scope))[0]!.assignment!.claimId;
  let unblock!: () => void, entered = false;
  const held = new Promise<void>(resolve => {unblock = resolve;});
  b.h.core.sharedBoard.guardStart = async () => {entered = true; await held;};
  const start = b.client.call('sharedBoard.start', {...scope, cardId: 'card_collision', claimId});
  await waitFor(() => entered);
  await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'release', requestId: 'release', cardId: 'card_collision', claimId}});
  unblock();
  expect(await thrown(start)).toThrow('changed');
  expect(b.h.core.activity.get(b.threadId).goal).toBeNull();
  const revision = (await cards(a.client, scope))[0]!.revision;
  const second = await b.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', requestId: 'second-claim', cardId: 'card_collision', expectedRevision: revision, worker}});
  entered = false;
  const heldAgain = new Promise<void>(resolve => {unblock = resolve;});
  b.h.core.sharedBoard.guardStart = async () => {entered = true; await heldAgain;};
  const revokedStart = b.client.call('sharedBoard.start', {...scope, cardId: 'card_collision', claimId: second.card!.assignment!.claimId});
  await waitFor(() => entered);
  await a.client.call('contacts.revoke', {coreId: b.coreId, projectId: a.ref.projectId});
  unblock();
  expect(await thrown(revokedStart)).toThrow('active');
  expect(b.h.core.activity.get(b.threadId).goal).toBeNull();
}, 30000);

test('replication pages bounded deltas and quiesces after acknowledgement; shared and local cards do not collide', async () => {
  const { a, b, scope } = await board();
  let requests = 0;
  const original = a.h.core.coordination.request.bind(a.h.core.coordination);
  a.h.core.coordination.request = (peer, operation, payload) => {if (operation === 'contact.project' && String((payload as {method?: string}).method).startsWith('board.')) requests++; return original(peer, operation, payload);};
  for (let i = 0; i < 70; i++) await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'add', requestId: `add-${i}`, cardId: `card-${i}`, text: `task ${i}`}});
  const first = await b.h.core.sharedProjects.request(b.h.core.sharedProjects.scope(scope), 'board.get', {after: 0});
  expect(first.kind).toBe('delta');
  if (first.kind === 'delta') {expect(first.changes).toHaveLength(64); expect(first.more).toBe(true);}
  expect(await cards(b.client, scope)).toHaveLength(70);
  await a.h.core.sharedBoard.flush(b.coreId);
  await new Promise(resolve => setTimeout(resolve, 120));
  const settled = requests;
  await a.h.core.sharedBoard.flush(b.coreId); await b.h.core.sharedBoard.flush(a.coreId);
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(requests).toBe(settled);
  const local = await b.client.call('todos.add', {threadId: b.threadId, text: 'private local'});
  const shared = await b.client.call('todos.update', {threadId: b.threadId, todoId: 'card-0', sharedProjectId: scope.sharedProjectId, text: 'shared through existing todo API'});
  expect(shared.shared?.sharedProjectId).toBe(scope.sharedProjectId);
  expect((await cards(a.client, scope)).find(c => c.id === 'card-0')?.text).toBe('shared through existing todo API');
  expect((await b.client.call('todos.list', {threadId: b.threadId})).find(t => t.id === local.id)?.text).toBe('private local');
}, 30000);

test('an accepted goal start is not repeated after restarting its host, and a paired device can move a card', async () => {
  const {a, b, scope} = await board();
  const added = await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'add', 'once after restart')});
  const worker = {project: a.ref, threadId: a.threadId, address: {coreId: a.coreId, threadId: a.threadId}};
  const accepted = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', cardId: 'card_collision', requestId: 'start-once', expectedRevision: added.revision, worker}});
  const claimId = accepted.card!.assignment!.claimId;
  await a.client.call('sharedBoard.start', {...scope, cardId: 'card_collision', claimId});
  await a.h.stop();
  const h = await startTestCore({dataDir: a.h.dataDir}); cores.push(h);
  const client = await h.connect();
  let starts = 0;
  const set = h.core.activity.set.bind(h.core.activity);
  h.core.activity.set = (p, claim) => {starts++; return set(p, claim);};
  await client.call('sharedBoard.start', {...scope, cardId: 'card_collision', claimId});
  expect(starts).toBe(0);
  expect(h.core.activity.get(a.threadId).goal?.status).toBe('paused');
  expect((await cards(client, scope))[0]?.goal?.status).toBe('paused');
  const {grant} = await client.call('pairing.grant', {});
  const phone = await connect(h.url, '', {grant, client: {name: 'pwa', version: 'test'}});
  try {
    // A paired device has the same local authority as its human, under that endpoint's Store.
    expect((await phone.call('sharedBoard.get', scope)).kind).toBe('snapshot');
    expect((await phone.call('sharedBoard.apply', {...scope, command: {kind: 'update', requestId: 'phone-confirm', cardId: 'card_collision', status: 'done'}})).card?.status).toBe('done');
    expect(await thrown(phone.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, board: false}))).toThrow('owner only');
  } finally {phone.close();}
}, 30000);

test('board traffic uses one durable hint and one bounded delta for a burst, with no idle replay', async () => {
  const {a, b, scope} = await board();
  await a.h.core.sharedBoard.flush(b.coreId); await b.h.core.sharedBoard.flush(a.coreId);
  await new Promise(resolve => setTimeout(resolve, 120));
  const traffic: Record<string, {messages: number; requestBytes: number; responseBytes: number}> = {};
  for (const side of [a, b]) {
    const original = side.h.core.coordination.request.bind(side.h.core.coordination);
    side.h.core.coordination.request = async (peer, operation, payload) => {
      const method = (payload as {method?: string}).method;
      if (operation !== 'contact.project' || !method?.startsWith('board.')) return original(peer, operation, payload);
      const row = traffic[method] ??= {messages: 0, requestBytes: 0, responseBytes: 0};
      row.messages++; row.requestBytes += Buffer.byteLength(JSON.stringify(payload));
      const result = await original(peer, operation, payload);
      row.responseBytes += Buffer.byteLength(JSON.stringify(result));
      return result;
    };
  }
  await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'add', requestId: 'burst-1', cardId: 'burst', text: 'one'}});
  await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'update', requestId: 'burst-2', cardId: 'burst', text: 'two'}});
  await waitFor(() => b.h.core.sharedBoard.journal.revision(scope.sharedProjectId) === 2);
  await a.h.core.sharedBoard.flush(b.coreId);
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(traffic['board.changed']?.messages).toBe(1);
  expect(traffic['board.get']?.messages).toBe(1);
  const idleBefore = JSON.stringify(traffic);
  await a.h.core.sharedBoard.flush(b.coreId); await b.h.core.sharedBoard.flush(a.coreId);
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(JSON.stringify(traffic)).toBe(idleBefore);
  if (process.env.BOITE_BOARD_TRAFFIC_REPORT) writeFileSync(process.env.BOITE_BOARD_TRAFFIC_REPORT, JSON.stringify({date: new Date().toISOString(), unit: 'UTF-8 JSON of contact.project payload/result, before signing/sealing and transport framing', traffic, idleExtraMessages: 0}, null, 2));
}, 30000);

test('legacy todo reads and broadcasts do not bypass a shared board source model policy', async () => {
  const {a, b, scope} = await board();
  await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'add', 'shared board only')});
  await cards(b.client, scope);
  const local = await b.client.call('todos.add', {threadId: b.threadId, text: 'ordinary local card'});
  const agent = await connect(b.h.url, b.h.core.agents.tokenFor(b.threadId));
  try {
    b.h.core.contacts.setSettings({minTier: 1});
    expect((await agent.call('todos.list', {threadId: b.threadId})).filter(todo => todo.shared)).toHaveLength(0);
    expect((await agent.call('todos.list', {threadId: b.threadId})).map(todo => todo.id)).toEqual([local.id]);
    const event = agent.next<'todos.updated'>('todos.updated');
    await b.client.call('todos.update', {threadId: b.threadId, todoId: local.id, text: 'still local'});
    expect((await event).todos.some(todo => todo.shared)).toBe(false);
    b.h.core.contacts.setSettings({minTier: 2});
    expect((await agent.call('todos.list', {threadId: b.threadId})).some(todo => todo.shared)).toBe(true);
  } finally {agent.close();}
}, 30000);

test('releasing a running claim first stops its exact worker host and preserves unrelated goals', async () => {
  const {a, b, scope} = await board();
  const account = b.h.core.accounts.list().find(a => a.providerId === 'echo')!;
  const other = await b.client.call('threads.create', {projectId: b.ref.projectId, providerId: 'echo', accountId: account.id});
  b.h.core.activity.set({threadId: other.id, loop: {prompt: 'unrelated work', intervalMs: 60000}});
  const added = await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'add', 'shared running goal')});
  const worker = {project: b.ref, threadId: b.threadId, address: {coreId: b.coreId, threadId: b.threadId}};
  const accepted = await b.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', requestId: 'running-claim', cardId: 'card_collision', expectedRevision: added.revision, worker}});
  const claimId = accepted.card!.assignment!.claimId;
  await b.client.call('sharedBoard.start', {...scope, cardId: 'card_collision', claimId});
  const released = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'release', requestId: 'release-running', cardId: 'card_collision', claimId}});
  expect(released.outcome).toBe('applied');
  expect(b.h.core.activity.get(b.threadId).goal).toBeNull();
  expect(b.h.core.activity.get(other.id).loop?.status).toBe('active');
  expect((await cards(a.client, scope))[0]?.assignment).toBeNull();
  expect(await thrown(b.client.call('sharedBoard.start', {...scope, cardId: 'card_collision', claimId}))).toThrow();
}, 30000);

test('an uncertain or replaced worker retains its claim instead of stopping the user\'s replacement activity', async () => {
  const {a, b, scope} = await board();
  const added = await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'add', 'owned goal')});
  const worker = {project: b.ref, threadId: b.threadId, address: {coreId: b.coreId, threadId: b.threadId}};
  const accepted = await b.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', requestId: 'owned-claim', cardId: 'card_collision', expectedRevision: added.revision, worker}});
  const claimId = accepted.card!.assignment!.claimId;
  await b.client.call('sharedBoard.start', {...scope, cardId: 'card_collision', claimId});
  b.h.core.activity.set({threadId: b.threadId, goal: {objective: 'replacement owned by the user'}});
  expect(await thrown(a.client.call('sharedBoard.apply', {...scope, command: {kind: 'release', requestId: 'unsafe-release', cardId: 'card_collision', claimId}}))).toThrow('uncertain');
  expect(b.h.core.activity.get(b.threadId).goal?.objective).toBe('replacement owned by the user');
  expect((await cards(a.client, scope))[0]?.assignment?.claimId).toBe(claimId);
  expect(await thrown(b.client.call('sharedBoard.start', {...scope, cardId: 'card_collision', claimId}))).toThrow('stopping or stopped');
}, 30000);

test('different agents reusing a request id receive distinct claim identities and independent progress', async () => {
  const {a, b, scope} = await board();
  const first = await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'first', 'first task')});
  const second = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'add', requestId: 'second', cardId: 'card-two', text: 'second task'}});
  const account = b.h.core.accounts.list().find(a => a.providerId === 'echo')!;
  const thread = await b.client.call('threads.create', {projectId: b.ref.projectId, providerId: 'echo', accountId: account.id});
  const one = await connect(b.h.url, b.h.core.agents.tokenFor(b.threadId));
  const two = await connect(b.h.url, b.h.core.agents.tokenFor(thread.id));
  try {
    const receipts = [];
    for (const {client, threadId, cardId, revision} of [
      {client: one, threadId: b.threadId, cardId: 'card_collision', revision: first.revision},
      {client: two, threadId: thread.id, cardId: 'card-two', revision: second.revision},
    ]) receipts.push(await client.call('sharedBoard.apply', {threadId, sharedProjectId: scope.sharedProjectId, command: {kind: 'claim', requestId: 'same-operation-id', cardId, expectedRevision: revision, worker: {project: b.ref, threadId, address: {coreId: b.coreId, threadId}}}}));
    expect(receipts.map(r => r.outcome)).toEqual(['applied', 'applied']);
    expect(receipts[0]!.card!.assignment!.claimId).not.toBe(receipts[1]!.card!.assignment!.claimId);
    const host = {...b.h.core.sharedProjects.scope(scope), source: {kind: 'human' as const, project: b.ref}};
    for (const r of receipts) {
      const card = r.card!, assigned = card.assignment!;
      await b.h.core.sharedProjects.request(host, 'board.progress', {cardId: card.id, claimId: assigned.claimId, worker: assigned.worker, sequence: 1, goal: {status: 'active', reviewing: false, checklist: null}, reviewPassedAt: null});
    }
    expect((await cards(a.client, scope)).every(card => card.assignment?.state === 'running')).toBe(true);
    const released = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'release', requestId: 'release-first', cardId: 'card_collision', claimId: receipts[0]!.card!.assignment!.claimId}});
    const reclaimed = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', requestId: 'same-operation-id', cardId: 'card_collision', expectedRevision: released.revision, worker: {project: a.ref, threadId: a.threadId, address: {coreId: a.coreId, threadId: a.threadId}}}});
    expect(reclaimed.outcome).toBe('applied');
    expect(reclaimed.card!.assignment!.claimId).not.toBe(receipts[0]!.card!.assignment!.claimId);
  } finally {one.close(); two.close();}
}, 30000);

test('an in-flight flush drains newly queued claims before returning their receipts', async () => {
  const {a, b, scope} = await board();
  const first = await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'first', 'first task')});
  const second = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'add', requestId: 'second', cardId: 'card-two', text: 'second task'}});
  const account = b.h.core.accounts.list().find(a => a.providerId === 'echo')!;
  const thread = await b.client.call('threads.create', {projectId: b.ref.projectId, providerId: 'echo', accountId: account.id});
  const original = b.h.core.coordination.request.bind(b.h.core.coordination);
  let unblock!: () => void, entered = false;
  const held = new Promise<void>(resolve => {unblock = resolve;});
  b.h.core.coordination.request = async (peer, operation, payload) => {
    if (operation === 'contact.project' && (payload as {method?: string}).method === 'board.apply' && !entered) {entered = true; await held;}
    return original(peer, operation, payload);
  };
  const claim = (cardId: string, threadId: string, expectedRevision: number): SharedBoardCommand => ({kind: 'claim', requestId: cardId, cardId, expectedRevision, worker: {project: b.ref, threadId, address: {coreId: b.coreId, threadId}}});
  const one = b.client.call('sharedBoard.apply', {...scope, command: claim('card_collision', b.threadId, first.revision)});
  await waitFor(() => entered);
  const two = b.client.call('sharedBoard.apply', {...scope, command: claim('card-two', thread.id, second.revision)});
  await waitFor(() => b.h.core.sharedBoard.journal.pending(scope.sharedProjectId).length === 2);
  unblock();
  expect((await Promise.all([one, two])).map(r => r.outcome)).toEqual(['applied', 'applied']);
  expect(b.h.core.sharedBoard.journal.pending(scope.sharedProjectId)).toHaveLength(0);
}, 30000);

test('a newer revision hint waits for an older in-flight pull to catch up before acknowledgement', async () => {
  const {a, b, scope} = await board();
  await a.client.call('sharedBoard.apply', {...scope, command: command('add', 'add', 'initial')});
  await cards(b.client, scope);
  await a.h.core.sharedBoard.flush(b.coreId);
  const original = b.h.core.coordination.request.bind(b.h.core.coordination);
  let unblock!: () => void, entered = false, hintSeen = false;
  const held = new Promise<void>(resolve => {unblock = resolve;});
  b.h.core.coordination.request = async (peer, operation, payload) => {
    const response = await original(peer, operation, payload);
    if (operation === 'contact.project' && (payload as {method?: string}).method === 'board.get' && !entered) {entered = true; await held;}
    return response;
  };
  const receive = b.h.core.sharedProjects.receive.bind(b.h.core.sharedProjects);
  b.h.core.sharedProjects.receive = (peer, payload) => {
    if ((payload as {method?: string}).method === 'board.changed') hintSeen = true;
    return receive(peer, payload);
  };
  const oldRead = cards(b.client, scope);
  await waitFor(() => entered);
  const updated = await a.client.call('sharedBoard.apply', {...scope, command: command('update', 'newer', 'new value')});
  const owner = {...a.h.core.sharedProjects.scope(scope), source: {kind: 'human' as const, project: a.ref}};
  const hint = a.h.core.sharedProjects.request(owner, 'board.changed', {revision: updated.revision});
  await waitFor(() => hintSeen);
  unblock();
  await Promise.all([oldRead, hint]);
  expect(b.h.core.sharedBoard.journal.revision(scope.sharedProjectId)).toBe(updated.revision);
  expect(b.h.core.sharedBoard.journal.snapshot(scope.sharedProjectId).cards[0]?.text).toBe('new value');
  expect(await thrown(a.h.core.sharedProjects.request(owner, 'board.changed', {revision: updated.revision + 1}))).toThrow('announced revision');
}, 30000);
