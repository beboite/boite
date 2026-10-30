import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedComputeJob, SharedProjectRef, WorkflowPlan } from '@boite/contracts';
import { holdAccountTurns, startTestCore, waitFor, type TestCore } from './harness.ts';
import { connect } from '../src/client.ts';
import { unavailable } from '../src/errors.ts';
import { sharedPermissionSupport } from '../src/contacts/compute-policy.ts';
import { thrown } from './settle.ts';
import { waitForComputeJob } from './shared-compute-fixture.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnResult } from '../src/drivers/types.ts';

const cores: TestCore[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const h of cores.splice(0).reverse()) await h.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function git(h: TestCore, cwd: string, ...args: string[]) {
  const p = h.core.procs.spawn('thr_fixture', 'git', args, { cwd });
  const [out, err, code] = await Promise.all([new Response(p.proc.stdout).text(), new Response(p.proc.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args[0]}: ${err}`);
  return out.trim();
}
async function side(name: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-compute-')); dirs.push(dataDir);
  const h = await startTestCore({ dataDir }); cores.push(h);
  h.core.contacts.selfUrl = async () => h.url;
  const client = await h.connect();
  const path = join(dataDir, 'project'); mkdirSync(path);
  await git(h, path, 'init', '-b', 'main');
  await git(h, path, 'remote', 'add', 'origin', 'https://example.invalid/fixtures/shared.git');
  // Identical deterministic base in independent repositories, no network or real account.
  await git(h, path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'base');
  const project = await client.call('projects.add', { path, name });
  h.core.journal.db.run('UPDATE projects SET id=? WHERE id=?', ['prj_collision', project.id]);
  const account = h.core.accounts.list().find(a => a.providerId === 'echo')!;
  const thread = await client.call('threads.create', { projectId: 'prj_collision', providerId: 'echo', accountId: account.id, title: name });
  h.core.journal.db.run('UPDATE threads SET id=? WHERE id=?', ['thr_collision', thread.id]);
  h.core.contacts.setSettings({ minTier: 2 });
  const coreId = h.core.coordination.card().coreId;
  const ref: SharedProjectRef = { ownerCoreId: coreId, coreId, projectId: 'prj_collision' };
  return { h, client, path, ref, coreId, accountId: account.id, threadId: 'thr_collision' };
}
async function pair() {
  const a = await side('alpha'), b = await side('bravo');
  // Use the same object even when the two setup commits crossed a second boundary.
  await git(b.h, b.path, 'fetch', a.path, 'main');
  await git(b.h, b.path, 'reset', '--hard', 'FETCH_HEAD');
  a.h.core.contacts.selfUrl = async () => a.h.url;
  await b.client.call('contacts.join', { link: (await a.client.call('contacts.invite', {})).link });
  await waitFor(() => a.h.core.contacts.linked(b.coreId));
  await a.client.call('contacts.grant', { coreId: b.coreId, projectId: a.ref.projectId });
  await b.client.call('contacts.grant', { coreId: a.coreId, projectId: b.ref.projectId });
  await waitFor(() => a.h.core.contacts.find(b.coreId)?.capabilities?.sharedProjects === 1);
  const offered = await a.client.call('sharedProjects.offer', { coreId: b.coreId, projectId: a.ref.projectId, remote: b.ref, requestId: 'offer' });
  const scope = { threadId: a.threadId, sharedProjectId: offered.shared.id };
  await b.client.call('sharedProjects.decide', { sharedProjectId: offered.shared.id, accept: true, requestId: 'accept' });
  const baseCommit = await git(a.h, a.path, 'rev-parse', 'HEAD');
  const enable = (s: typeof a, maxConcurrent: number | null = null) => s.client.call('sharedProjects.configure', {
    sharedProjectId: scope.sharedProjectId, computeThreadId: s.threadId,
    compute: { enabled: true, profiles: ['conversation'], permissionMode: 'default', maxConcurrent },
  });
  return { a, b, scope, baseCommit, enable };
}
async function done(s: Awaited<ReturnType<typeof side>>, scope: { threadId: string; sharedProjectId: string }, job: SharedComputeJob) {
  await waitForComputeJob(s.h, job.id, ['done']);
  const current = await s.client.call('sharedCompute.get', { ...scope, jobId: job.id });
  expect(current.error).toBeNull(); expect(current.status).toBe('done');
  return current;
}
// A completed turn can still be verifying Git provenance after the checkout
// settles. Advance the wall clock while publication is held, without slowing CI.
test.each(['local', 'remote'] as const)('completion waits for verified %s provenance rather than a helper clock cutoff', async route => {
  const {a, b, scope, baseCommit, enable} = await pair();
  const host = route === 'local' ? a : b;
  await enable(host);
  let entered!: () => void, release!: () => void;
  const publishing = new Promise<void>(resolve => {entered = resolve;});
  const held = new Promise<void>(resolve => {release = resolve;});
  host.h.core.sharedCompute.publishText = async (_record, text) => {entered(); await held; return text;};
  const job = await a.client.call('sharedCompute.start', {...scope, requestId: 'slow-provenance', host: host.ref,
    profileId: 'conversation', baseCommit, task: 'Verify the held result'});
  await publishing;
  expect(host.h.core.journal.lastTurn(job.worker!.threadId)?.status).toBe('done');
  expect(host.h.core.sharedCompute.journal.get(job.id, 'host')!.job.status).toBe('running');
  const result = done(a, scope, job);
  // Observe rejection immediately so the old helper fails this test, not its successor.
  const settled = result.then(value => ({value, error: null}), error => ({value: null, error}));
  const now = Date.now.bind(Date), clock = spyOn(Date, 'now').mockImplementation(() => now() + 13_000);
  try {await Bun.sleep(60);}
  finally {clock.mockRestore(); release();}
  const received = await settled;
  expect(received.error).toBeNull();
  expect(received.value?.result?.baseCommit).toBe(baseCommit);
}, 30000);

test.each(['done', 'failed'] as const)('late cancellation preserves %s local and remote history while revocation still fences it', async status => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(a); await enable(b);
  if (status === 'failed') for (const side of [a, b]) side.h.core.sharedCompute.guardStart = () => {throw new Error('fixture admission refused');};
  // The remote host's change notices reach the source only after the source read the same revision, on a later clock.
  const request = b.h.core.coordination.request.bind(b.h.core.coordination), held: (() => void)[] = [], notices: Promise<unknown>[] = [];
  b.h.core.coordination.request = (peer, operation, payload) => {
    if (operation !== 'contact.project' || (payload as {method?: string}).method !== 'changed') return request(peer, operation, payload);
    const notice = new Promise<void>(r => held.push(r)).then(() => request(peer, operation, payload));
    notices.push(notice); return notice;
  };
  const jobs = [];
  for (const host of [a, b]) {
    const job = await a.client.call('sharedCompute.start', {...scope, requestId: `history-${host.coreId}`, host: host.ref, profileId: 'conversation', task: 'Complete the fixture', baseCommit});
    await waitFor(() => host.h.core.sharedCompute.journal.get(job.id, 'host')?.job.status === status);
    jobs.push(await a.client.call('sharedCompute.get', {...scope, jobId: job.id}));
  }
  expect(held.length).toBeGreaterThan(0);
  const now = Date.now.bind(Date), clock = spyOn(Date, 'now').mockImplementation(() => now() + 1000);
  try {for (const release of held.splice(0)) release(); await Promise.all(notices);}
  finally {clock.mockRestore(); b.h.core.coordination.request = request;}
  for (const job of jobs) {
    expect(await a.client.call('sharedCompute.cancel', {...scope, jobId: job.id, requestId: `late-${job.id}`})).toEqual(job);
    const host = job.host.coreId === a.coreId ? a : b;
    const hosted = host.h.core.sharedCompute.journal.get(job.id, 'host')!.job;
    expect(await host.client.call('sharedCompute.cancel', {...scope, jobId: job.id, requestId: `host-late-${job.id}`})).toEqual(hosted);
  }
  for (const host of [a, b]) await host.client.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, compute: {enabled: false, profiles: [], permissionMode: 'default', maxConcurrent: null}});
  for (const job of jobs) await waitFor(() => a.h.core.sharedCompute.journal.get(job.id, job.host.coreId === a.coreId ? 'host' : 'source')?.job.status === 'revoked');
}, 30000);

test('completion racing a source cancellation keeps the verified result and clears its cancellation retry', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const unblock = holdAccountTurns(b.h, b.accountId);
  const request = a.h.core.coordination.request.bind(a.h.core.coordination);
  try {
    const job = await a.client.call('sharedCompute.start', {...scope, requestId: 'completion-race', host: b.ref, profileId: 'conversation', task: 'Finish during cancellation', baseCommit});
    await waitFor(() => b.h.core.sharedCompute.journal.get(job.id, 'host')?.job.status === 'running');
    a.h.core.coordination.request = async (peer, op, payload) => {
      if (op === 'contact.project' && (payload as {method?: string}).method === 'compute.cancel') {
        unblock();
        await waitFor(() => b.h.core.sharedCompute.journal.get(job.id, 'host')?.job.status === 'done');
      }
      return request(peer, op, payload);
    };
    const cancelled = await a.client.call('sharedCompute.cancel', {...scope, jobId: job.id, requestId: 'completion-cancel'});
    expect(cancelled.status).toBe('done'); expect(cancelled.result?.baseCommit).toBe(baseCommit);
    expect(cancelled).toEqual({...b.h.core.sharedCompute.journal.get(job.id, 'host')!.job, updatedAt: cancelled.updatedAt});
    expect(a.h.core.sharedCompute.journal.get(job.id, 'source')!.cancelRequest).toBeUndefined();
    expect(b.h.core.journal.listChildThreads().filter(t => t.parentThreadId === b.threadId)).toHaveLength(1);
  } finally {unblock(); a.h.core.coordination.request = request;}
}, 30000);

test('releasing a completed claim preserves history and fences a follow-up already in transport across host restart', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  for (const side of [a, b]) await side.client.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, board: true});
  const added = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'add', requestId: 'completed-card', cardId: 'completed', text: 'Complete once'}});
  const claimed = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', requestId: 'completed-claim', cardId: 'completed', expectedRevision: added.revision, worker: {project: a.ref, threadId: a.threadId, address: {coreId: a.coreId, threadId: a.threadId}}}});
  const claimId = claimed.card!.assignment!.claimId;
  const job = await a.client.call('sharedCompute.start', {...scope, requestId: 'claim-history', host: b.ref, profileId: 'conversation', task: 'One result', baseCommit, claimId});
  const completed = await done(a, scope, job), hosted = b.h.core.sharedCompute.journal.get(job.id, 'host')!.job;
  const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const request = a.h.core.coordination.request.bind(a.h.core.coordination);
  let captured!: Parameters<typeof request>;
  a.h.core.coordination.request = async (...args) => {
    if (args[1] === 'contact.project' && (args[2] as {method?: string}).method === 'compute.send') {captured = args; entered.resolve(); await held.promise;}
    return request(...args);
  };
  try {
    const sending = a.client.call('sharedCompute.send', {...scope, jobId: job.id, text: 'Must never resume', requestId: 'late-claim-send'}).catch(error => error);
    await entered.promise;
    expect((await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'release', requestId: 'release-completed', cardId: 'completed', claimId}})).outcome).toBe('applied');
    held.resolve();
    const error = await sending;
    expect(error).toBeInstanceOf(Error); expect(error.message).toContain('claim');
    expect(b.h.core.sharedCompute.journal.get(job.id, 'host')!.job).toEqual(hosted);
    expect(a.h.core.sharedCompute.journal.get(job.id, 'source')!.job.result).toEqual(completed.result);
    expect(await thrown(a.client.call('sharedCompute.send', {...scope, jobId: job.id, text: 'Still closed', requestId: 'closed-source'}))).toThrow('claim');
    await b.h.stop();
    // Observe the old link closing so the next wait cannot accept its stale route.
    await waitFor(() => !a.h.core.contacts.linked(b.coreId));
    const restarted = await startTestCore({dataDir: b.h.dataDir, port: Number(new URL(b.h.url).port)}); cores.push(restarted);
    await waitFor(() => a.h.core.contacts.linked(b.coreId), 10000);
    expect(await thrown(request(...captured))).toThrow('claim');
    expect(restarted.core.sharedCompute.journal.get(job.id, 'host')!.job).toEqual(hosted);
  } finally {held.resolve(); a.h.core.coordination.request = request;}
}, 30000);

test('a send refuses remote permission disabled during its association lookup without persisting a letter', async () => {
  const {a, b} = await pair();
  const threads = a.h.core.sharedProjects.threads.bind(a.h.core.sharedProjects);
  const lookup = spyOn(a.h.core.sharedProjects, 'threads').mockImplementationOnce(async (...args) => {
    const result = await threads(...args);
    a.h.core.coordination.configure(a.threadId, {...a.h.core.coordination.config(a.threadId), remote: false});
    return result;
  });
  try {
    expect(await thrown(a.h.core.coordination.send({threadId: a.threadId, to: {coreId: b.coreId, threadId: b.threadId}, text: 'Late remote permission', requestId: 'late-remote'}))).toThrow('coordination permissions changed');
    expect(a.h.core.coordination.get(a.threadId).messages.some(m => m.text === 'Late remote permission')).toBe(false);
    const local = await a.client.call('threads.create', {projectId: a.ref.projectId, providerId: 'echo', accountId: a.accountId, title: 'Local recipient'});
    const letter = await a.h.core.coordination.send({threadId: a.threadId, to: {coreId: a.coreId, threadId: local.id}, text: 'Local permission is unchanged', requestId: 'local-only'});
    expect(a.h.core.coordination.get(local.id).messages.some(message => message.id === letter.id)).toBe(true);
  } finally {lookup.mockRestore();}
}, 30000);
test('start and duplicate requests acknowledge a durable queued job while host admission is held', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(a); await enable(b);
  for (const host of [a, b]) {
    const release = Promise.withResolvers<void>();
    let entered = false, reply: SharedComputeJob | undefined;
    const guard = host.h.core.sharedCompute.guardStart;
    host.h.core.sharedCompute.guardStart = async (...args) => {await guard(...args); entered = true; await release.promise;};
    const input = {...scope, requestId: `queued-${host.coreId}`, host: host.ref, profileId: 'conversation', baseCommit, task: 'one durable admission'};
    const started = a.client.call('sharedCompute.start', input).then(job => {reply = job; return job;});
    try {
      await waitFor(() => entered);
      await waitFor(() => reply !== undefined, 1000);
      expect(reply!.status).toBe('queued');
      const retry = await a.client.call('sharedCompute.start', input);
      expect(retry).toMatchObject({id: reply!.id, worker: reply!.worker, status: 'queued', revision: reply!.revision});
      const direct = await thrown(host.client.call('turns.start', {threadId: reply!.worker!.threadId, prompt: 'bypass preparation'}));
      const followup = await thrown(a.client.call('sharedCompute.send', {...scope, jobId: reply!.id, requestId: 'early-followup', text: 'bypass preparation'}));
      expect(direct).toThrow('admission');
      expect(followup).toThrow('admission');
      expect(host.h.core.journal.listChildThreads()).toHaveLength(1);
      expect(host.h.core.journal.db.query('SELECT COUNT(*) AS n FROM turns WHERE thread_id=?').get(reply!.worker!.threadId)).toEqual({n: 0});
      release.resolve();
      expect((await done(a, scope, reply!)).worker).toEqual(reply!.worker);
    } finally {release.resolve(); await started; host.h.core.sharedCompute.guardStart = guard;}
  }
}, 30000);

test('core shutdown drains a held child worktree inspection before closing its journal', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const job = await done(a, scope, await a.client.call('sharedCompute.start', {...scope, requestId: 'shutdown-inspection', host: b.ref, profileId: 'conversation', baseCommit, task: 'inspect at shutdown'}));
  const worktrees = b.h.core.delegation.worktrees, workerId = job.worker!.threadId;
  worktrees.record(workerId, {...worktrees.get(workerId)!, state: 'active'});
  const release = Promise.withResolvers<{commits: number; dirty: boolean}>();
  const changes = spyOn(b.h.core.worktrees, 'changes').mockImplementation(() => release.promise);
  const inspection = worktrees.settle(workerId)!;
  // Consume a late rejection too, so the RED run reports the assertion rather than an unhandled error.
  const inspected = inspection.catch(error => error);
  let closed = false;
  const closing = b.h.core.close().then(() => {closed = true;});
  try {
    await Promise.race([closing, Bun.sleep(1000)]);
    expect(closed).toBe(false);
    expect(b.h.core.journal.isClosed()).toBe(false);
    release.resolve({commits: 1, dirty: false});
    await inspection; await closing;
    expect(b.h.core.journal.isClosed()).toBe(true);
  } finally {release.resolve({commits: 1, dirty: false}); await inspected; await closing; changes.mockRestore();}
}, 30000);

test('host opt-in runs four local and five remote children on the owning accounts and returns git provenance', async () => {
  const { a, b, scope, baseCommit, enable } = await pair();
  const guard = b.h.core.sharedCompute.guardStart;
  b.h.core.sharedCompute.guardStart = async (...args) => {await guard(...args); await Bun.sleep(1500);};
  let phase = 'disabled';
  try {
    expect(await thrown(a.client.call('sharedCompute.start', { ...scope, requestId: 'disabled', host: b.ref, profileId: 'conversation', baseCommit, task: 'fixture' }))).toThrow('compute');
    phase = 'enable';
    await enable(a); await enable(b);
    phase = 'start';
    const jobs = await Promise.all(Array.from({ length: 9 }, (_, n) => a.client.call('sharedCompute.start', {
      ...scope, requestId: `job-${n}`, host: n < 4 ? a.ref : b.ref, profileId: 'conversation', baseCommit, task: `fixture ${n}`,
    })));
    phase = 'finish';
    const results = await Promise.all(jobs.map(job => done(a, scope, job)));
    expect(new Set(results.map(j => j.worker!.threadId)).size).toBe(9);
    for (const job of results) {
      phase = `provenance:${job.id}`;
      const host = job.host.coreId === a.coreId ? a : b;
      const worker = host.h.core.threads.require(job.worker!.threadId);
      expect(worker.accountId).toBe(host.accountId);
      expect(worker.projectId).toBe(host.ref.projectId);
      expect(worker.parentThreadId).toBe(host.threadId);
      expect(worker.cwd).not.toBe(host.path);
      expect(job.result).toMatchObject({ repository: 'example.invalid/fixtures/shared', baseCommit, commit: baseCommit, dirty: false });
      expect(await git(host.h, worker.cwd, 'rev-parse', 'HEAD')).toBe(job.result!.commit);
      expect(await git(host.h, worker.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe(job.result!.branch);
      expect(JSON.stringify(job)).not.toContain(host.accountId);
      expect(JSON.stringify(job)).not.toContain(host.path);
    }
  } catch (error) {
    for (const {h, coreId} of [a, b]) {
      try {
        console.error(JSON.stringify({stage: 'shared-compute.fanout-failed', phase, coreId,
          logs: await h.core.logs.query({limit: 100, minLevel: 'warn'}),
          jobs: h.core.sharedCompute.journal.all(scope.sharedProjectId).map(({role, job}) => ({
            role, id: job.id, status: job.status, revision: job.revision, error: job.error, worker: job.worker?.threadId,
            worktree: job.worker && h.core.delegation.worktrees.get(job.worker.threadId),
          })),
        }));
      } catch (snapshotError) {console.error(`shared-compute.fanout-snapshot: ${String(snapshotError)}`);}
    }
    throw error;
  }
}, 45000);

test('a shared echo route cannot turn scripted text into a host shell command', async () => {
  const { a, b, scope, baseCommit, enable } = await pair(); await enable(b);
  const target = join(b.path, 'injected-marker');
  const job = await a.client.call('sharedCompute.start', {...scope, requestId: 'shell', host: b.ref, profileId: 'conversation', baseCommit, task: `[spawn:touch ${target}]`});
  let result = job;
  const until = Date.now() + 10000;
  while (['queued', 'running', 'waiting'].includes(result.status) && Date.now() < until) {
    await new Promise(r => setTimeout(r, 30)); result = await a.client.call('sharedCompute.get', {...scope, jobId: job.id});
  }
  expect(existsSync(target)).toBe(false);
  expect(result.status).toBe('failed');
}, 30000);

test('only the owner restores the persisted host parent and an unchanged policy keeps job authority', async () => {
  const {a, b, scope, baseCommit} = await pair();
  const params = {sharedProjectId: scope.sharedProjectId};
  expect(await b.client.call('sharedCompute.host', params)).toEqual({threadId: null});
  const parent = await b.client.call('threads.create', {projectId: b.ref.projectId, providerId: 'echo', accountId: b.accountId, title: 'Explicit host'});
  const compute = {enabled: true, profiles: ['conversation'], permissionMode: 'default' as const, maxConcurrent: 4};
  const configured = await b.client.call('sharedProjects.configure', {...params, computeThreadId: parent.id, compute});
  expect(await b.client.call('sharedCompute.host', params)).toEqual({threadId: parent.id});
  // No binding from this host is disclosed in the peer view or the other owner's local settings.
  expect(await a.client.call('sharedCompute.host', params)).toEqual({threadId: null});
  expect(JSON.stringify(await a.client.call('sharedProjects.get', scope))).not.toContain(parent.id);
  const {grant} = await b.client.call('pairing.grant', {});
  const phone = await connect(b.h.url, '', {grant, client: {name: 'pwa', version: 'test'}});
  const agent = await connect(b.h.url, b.h.core.agents.tokenFor(b.threadId));
  try {
    expect(await thrown(phone.call('sharedCompute.host', params))).toThrow('owner only');
    expect(await thrown(agent.call('sharedCompute.host', params))).toThrow('agent');
  } finally {phone.close(); agent.close();}
  const unblock = holdAccountTurns(b.h, b.accountId);
  try {
    const job = await a.client.call('sharedCompute.start', {...scope, host: b.ref, profileId: 'conversation', baseCommit, task: 'Keep authority', requestId: 'unchanged-host'});
    const unchanged = await b.client.call('sharedProjects.configure', {...params, compute});
    expect(unchanged.shared.access).toEqual(configured.shared.access);
    expect((await a.client.call('sharedCompute.get', {...scope, jobId: job.id})).status).not.toBe('revoked');
    expect(b.h.core.threads.require(job.worker!.threadId).parentThreadId).toBe(parent.id);
    await a.client.call('sharedCompute.cancel', {...scope, jobId: job.id, requestId: 'end-host-fixture'});
  } finally {unblock();}
  await b.h.stop();
  const restarted = await startTestCore({dataDir: b.h.dataDir}); cores.push(restarted);
  expect(await (await restarted.connect()).call('sharedCompute.host', params)).toEqual({threadId: parent.id});
}, 30000);

test('content-bound start receipts survive a lost response, concurrent retries and a source restart', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const p = {...scope, requestId: 'same', host: b.ref, profileId: 'conversation', baseCommit, task: 'one exact job'};
  const original = a.h.core.coordination.request.bind(a.h.core.coordination);
  let lost = false;
  a.h.core.coordination.request = async (peer, op, payload) => {
    const value = await original(peer, op, payload);
    if (op === 'contact.project' && (payload as {method?: string}).method === 'compute.start' && !lost) {lost = true; throw unavailable('fixture lost response');}
    return value;
  };
  expect(await thrown(a.client.call('sharedCompute.start', p))).toThrow('lost response');
  a.h.core.coordination.request = original;
  const [first, retry] = await Promise.all([a.client.call('sharedCompute.start', p), a.client.call('sharedCompute.start', p)]);
  expect(first.id).toBe(retry.id); expect(first.worker).toEqual(retry.worker);
  expect(b.h.core.journal.listChildThreads().filter(t => t.parentThreadId === b.threadId)).toHaveLength(1);
  expect(await thrown(a.client.call('sharedCompute.start', {...p, task: 'different'}))).toThrow('different compute content');
  const completed = await done(a, scope, first);
  await a.h.stop();
  const restarted = await startTestCore({dataDir: a.h.dataDir, port: Number(new URL(a.h.url).port)}); cores.push(restarted);
  await waitFor(() => b.h.core.contacts.linked(a.coreId), 10000);
  const client = await restarted.connect();
  expect((await client.call('sharedCompute.start', p)).result).toEqual(completed.result);
  expect(b.h.core.journal.listChildThreads()).toHaveLength(1);
}, 30000);

test('host restart preserves the exact job and never replays inference; cancellation stays scoped', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const p = {...scope, requestId: 'restart', host: b.ref, profileId: 'conversation', baseCommit, task: '[sleep:20000]'};
  const first = await a.client.call('sharedCompute.start', p);
  await waitFor(() => b.h.core.journal.getThread(first.worker!.threadId)?.status === 'running');
  await b.h.stop(); await waitFor(() => !a.h.core.contacts.linked(b.coreId));
  const restarted = await startTestCore({dataDir: b.h.dataDir}); cores.push(restarted);
  await waitFor(() => a.h.core.contacts.linked(b.coreId), 10000);
  const retry = await a.client.call('sharedCompute.start', p);
  expect(retry.id).toBe(first.id); expect(retry.worker).toEqual(first.worker);
  expect(['uncertain', 'failed']).toContain(retry.status);
  expect(restarted.core.journal.listChildThreads()).toHaveLength(1);
  expect(() => restarted.core.threads.startTurn(first.worker!.threadId, 'resume without a new admission')).toThrow('authority is closed');
  const cancelled = await a.client.call('sharedCompute.cancel', {...scope, jobId: first.id, requestId: 'cancel-restart'});
  expect(cancelled.status).toBe('cancelled');
  expect(() => restarted.core.threads.startTurn(first.worker!.threadId, 'unauthorized resume')).toThrow('authority is closed');
}, 30000);

test('revoking one contact stops only its captured job, preserving another owner and local host work', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const c = await side('charlie');
  await git(c.h, c.path, 'fetch', a.path, 'main'); await git(c.h, c.path, 'reset', '--hard', 'FETCH_HEAD');
  c.h.core.contacts.selfUrl = async () => c.h.url;
  await b.client.call('contacts.join', {link: (await c.client.call('contacts.invite', {})).link});
  await waitFor(() => c.h.core.contacts.linked(b.coreId));
  await c.client.call('contacts.grant', {coreId: b.coreId, projectId: c.ref.projectId});
  await b.client.call('contacts.grant', {coreId: c.coreId, projectId: b.ref.projectId});
  await waitFor(() => c.h.core.contacts.find(b.coreId)?.capabilities?.sharedProjects === 1);
  const offered = await c.client.call('sharedProjects.offer', {coreId: b.coreId, projectId: c.ref.projectId, remote: b.ref, requestId: 'offer-c'});
  const cscope = {threadId: c.threadId, sharedProjectId: offered.shared.id};
  await b.client.call('sharedProjects.decide', {sharedProjectId: offered.shared.id, accept: true, requestId: 'accept-c'});
  await b.client.call('sharedProjects.configure', {sharedProjectId: offered.shared.id, computeThreadId: b.threadId, compute: {enabled: true, profiles: ['conversation'], permissionMode: 'default', maxConcurrent: null}});
  const params = {requestId: 'same-id', host: b.ref, profileId: 'conversation', baseCommit, task: '[sleep:20000]'};
  const guard = b.h.core.sharedCompute.guardStart, admission = Promise.withResolvers<void>();
  const unrelated = b.h.core.procs.spawn(b.threadId, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {cwd: b.path});
  try {
    b.h.core.sharedCompute.guardStart = async (...args) => {
      await guard(...args);
      if (args[2].sharedProjectId === cscope.sharedProjectId) await admission.promise;
    };
    const owned = await a.client.call('sharedCompute.start', {...scope, ...params});
    const other = await c.client.call('sharedCompute.start', {...cscope, ...params});
    expect(owned.id).not.toBe(other.id);
    await waitFor(() => b.h.core.journal.getThread(owned.worker!.threadId)?.status === 'running');
    // A durable start receipt can precede admission of the other owner's worker.
    expect(b.h.core.sharedCompute.journal.get(other.id, 'host')?.job.status).toBe('queued');
    admission.resolve();
    await waitFor(() => b.h.core.sharedCompute.journal.get(other.id, 'host')?.job.status === 'running'
      && b.h.core.journal.getThread(other.worker!.threadId)?.status === 'running');
    const captured = b.h.core.procs.spawn(owned.worker!.threadId, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {cwd: b.path});
    await b.client.call('contacts.revoke', {coreId: a.coreId, projectId: b.ref.projectId});
    await waitFor(() => b.h.core.sharedCompute.journal.get(owned.id, 'host')?.job.status === 'revoked');
    expect(await captured.exited).not.toBe(0);
    expect(b.h.core.procs.liveOf(b.threadId).some(p => p.pid === unrelated.record.pid)).toBe(true);
    expect(b.h.core.sharedCompute.journal.get(other.id, 'host')?.job.status).toBe('running');
    expect(await thrown(a.client.call('sharedCompute.get', {...scope, jobId: owned.id}))).toThrow('not active');
    const cancel = await c.client.call('sharedCompute.cancel', {...cscope, jobId: other.id, requestId: 'cancel-c'});
    expect(cancel.status).toBe('cancelled');
    expect(b.h.core.procs.liveOf(b.threadId).some(p => p.pid === unrelated.record.pid)).toBe(true);
  } finally {
    admission.resolve(); b.h.core.sharedCompute.guardStart = guard;
    unrelated.proc.kill(); await unrelated.exited;
  }
}, 45000);

test('host contribution and authenticated source boundaries reject arbitrary paths, accounts and forged artifacts', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b, 1);
  const unblock = holdAccountTurns(b.h, b.accountId);
  const p = {...scope, requestId: 'held', host: b.ref, profileId: 'conversation', baseCommit, task: 'held fixture'};
  try {
    for (const extra of [{cwd: '/tmp'}, {repository: 'evil.invalid/repo'}, {accountId: a.accountId}, {permissionMode: 'yolo'}, {result: {commit: baseCommit}}])
      expect(await thrown(a.client.call('sharedCompute.start', {...p, ...extra} as typeof p))).toThrow('compute.');
    expect(await thrown(a.client.call('sharedCompute.start', {...p, baseCommit: '--help'}))).toThrow('baseCommit');
    expect(await thrown(a.client.call('sharedCompute.start', {...p, host: {...b.ref, projectId: 'other'}}))).toThrow('host');
    // The source knows this commit; the host must diagnose its own missing object.
    await git(a.h, a.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'source-only base');
    const sourceOnlyBase = await git(a.h, a.path, 'rev-parse', 'HEAD');
    let missing = await a.client.call('sharedCompute.start', {...p, requestId: 'missing-base', baseCommit: sourceOnlyBase});
    await waitFor(() => b.h.core.sharedCompute.journal.get(missing.id, 'host')?.job.status === 'failed');
    missing = await a.client.call('sharedCompute.get', {...scope, jobId: missing.id});
    expect(missing.status).toBe('failed');
    expect(missing.error).not.toContain(b.path);
    const gitFailure = (await b.h.core.logs.query({source: 'git', threadId: missing.worker!.threadId})).find(log => log.event === 'git.failed');
    expect(gitFailure?.data?.subcommand).toBe('rev-parse');
    expect(gitFailure?.data?.stderr).toBeString();
    const job = await a.client.call('sharedCompute.start', p);
    expect(await thrown(a.client.call('sharedCompute.start', {...p, requestId: 'second'}))).toThrow('contribution is full');
    const agent = await connect(a.h.url, a.h.core.agents.tokenFor(a.threadId));
    const hostAgent = await connect(b.h.url, b.h.core.agents.tokenFor(b.threadId));
    try {
      expect(await thrown(agent.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, compute: {enabled: true, profiles: ['conversation'], permissionMode: 'yolo', maxConcurrent: null}}))).toThrow('agent');
      expect(await thrown(agent.call('sharedCompute.get', {...scope, threadId: 'thr_other', jobId: job.id}))).toThrow('thr_collision');
      expect((await hostAgent.call('sharedCompute.list', {...scope, threadId: b.threadId}))).toEqual([]);
      expect(await thrown(hostAgent.call('sharedCompute.cancel', {...scope, threadId: b.threadId, jobId: job.id, requestId: 'forged'}))).toThrow('authorized job');
    } finally {agent.close(); hostAgent.close();}
    // Keep the worker held: a late terminal notification must not replace the
    // forged-result read with the source's already verified cached completion.
    await waitFor(() => b.h.core.sharedCompute.journal.get(job.id, 'host')?.job.status === 'running');
    await a.client.call('sharedCompute.get', {...scope, jobId: job.id});
    const original = a.h.core.coordination.request.bind(a.h.core.coordination);
    let forgedReads = 0;
    a.h.core.coordination.request = async (peer, op, payload) => {
      const result = await original(peer, op, payload);
      const request = payload as {method?: string; params?: {jobId?: string}};
      if (op === 'contact.project' && request.method === 'compute.get' && request.params?.jobId === job.id) {
        const current = result as SharedComputeJob;
        forgedReads++;
        return {...current, revision: current.revision + 1, status: 'done', result: {
          repository: 'example.invalid/fixtures/shared', baseCommit, commit: baseCommit, branch: '../../evil', dirty: false, text: 'forged',
        }};
      }
      return result;
    };
    try {
      expect(await thrown(a.client.call('sharedCompute.get', {...scope, jobId: job.id}))).toThrow('captured worker branch');
      expect(forgedReads).toBeGreaterThan(0);
      expect(a.h.core.sharedCompute.journal.get(job.id, 'source')!.job).toMatchObject({status: 'running', result: null});
    }
    finally {a.h.core.coordination.request = original;}
    unblock(); await done(a, scope, job);
  } finally {unblock();}
}, 30000);

test('cancellation before a delayed start is durable; follow-up retries create one provider turn', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const original = a.h.core.coordination.request.bind(a.h.core.coordination);
  a.h.core.coordination.request = (peer, op, payload) => op === 'contact.project' && (payload as {method?: string}).method === 'compute.start' ? Promise.reject(unavailable('fixture offline')) : original(peer, op, payload);
  const p = {...scope, requestId: 'delayed', host: b.ref, profileId: 'conversation', baseCommit, task: 'must never start'};
  expect(await thrown(a.client.call('sharedCompute.start', p))).toThrow('offline');
  const pending = (await a.client.call('sharedCompute.list', scope))[0]!;
  expect((await a.client.call('sharedCompute.cancel', {...scope, jobId: pending.id, requestId: 'cancel-before'})).status).toBe('cancelled');
  a.h.core.coordination.request = original;
  expect((await a.client.call('sharedCompute.start', p)).status).toBe('cancelled');
  expect(b.h.core.journal.listChildThreads()).toHaveLength(0);
  const first = await done(a, scope, await a.client.call('sharedCompute.start', {...p, requestId: 'new', task: 'first task'}));
  const followup = {...scope, jobId: first.id, requestId: 'followup', text: 'second task'};
  await a.client.call('sharedCompute.send', followup);
  await waitFor(() => b.h.core.sharedCompute.journal.get(first.id, 'host')?.job.status === 'done');
  await a.client.call('sharedCompute.send', followup);
  expect(b.h.core.journal.db.query('SELECT COUNT(*) AS n FROM turns WHERE thread_id=?').get(first.worker!.threadId)).toEqual({n: 2});
  expect(await thrown(a.client.call('sharedCompute.send', {...followup, text: 'different'}))).toThrow('different content');
}, 30000);

test('driver permission capability checks preserve exact policies without live probes or a fallback', () => {
  for (const protocol of ['claude-sdk', 'codex-appserver', 'muse'] as const)
    for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'yolo'] as const) expect(sharedPermissionSupport(protocol, mode)).toBe(true);
  for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'yolo'] as const) {
    expect(sharedPermissionSupport('acp', mode)).toBe(false);
    expect(sharedPermissionSupport('acp', mode, 'opencode')).toBe(mode === 'default' || mode === 'plan');
    expect(sharedPermissionSupport('pi', mode)).toBe(mode === 'yolo' || mode === 'bypassPermissions');
  }
  expect(sharedPermissionSupport('echo', 'default')).toBe(true); expect(sharedPermissionSupport('echo', 'yolo')).toBe(false);
});

test('the existing workflow runner distributes four local and five remote jobs without a new concurrency cap', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(a); await enable(b);
  const plan: WorkflowPlan = {name: 'Shared fanout', limits: {maxConcurrent: 9}, steps: Array.from({length: 9}, (_, i) => ({
    id: `step${i}`, task: `workflow fixture ${i}`, compute: {sharedProjectId: scope.sharedProjectId, host: i < 4 ? a.ref : b.ref, profileId: 'conversation', baseCommit},
  }))};
  const run = await a.client.call('workflows.start', {threadId: a.threadId, plan, requestId: 'workflow-nine'});
  try {
    await waitFor(() => ['done', 'failed'].includes(a.h.core.workflows.get(a.threadId, run.id).status), 15000);
  } catch (error) {
    try {
      console.error('Shared fanout timeout', {
        run: a.h.core.workflows.get(a.threadId, run.id),
        hosts: await Promise.all([a, b].map(async side => ({
          coreId: side.coreId,
          records: side.h.core.sharedCompute.journal.all(scope.sharedProjectId),
          logs: await side.h.core.logs.query({ limit: 40, minLevel: 'debug' }),
        }))),
      });
    } catch (diagnosticError) { console.error('Shared fanout diagnostics failed', diagnosticError); }
    throw error;
  }
  const result = await a.client.call('workflows.get', {threadId: a.threadId, runId: run.id});
  if (result.error) for (const {h, coreId} of [a, b]) {
    console.error('Shared workflow host diagnostics', {coreId, logs: await h.core.logs.query({limit: 40, minLevel: 'debug'}),
      jobs: h.core.sharedCompute.journal.all(scope.sharedProjectId).filter(r => r.role === 'host' && r.job.status === 'failed').map(r => ({job: r.job.id, error: r.job.error, worktree: r.job.worker && h.core.delegation.worktrees.get(r.job.worker.threadId)}))});
  }
  expect(result.error).toBeNull(); expect(result.status).toBe('done');
  expect(result.nodes.flatMap(n => n.instances).filter(i => i.compute?.host.coreId === b.coreId)).toHaveLength(5);
  expect(result.nodes.flatMap(n => n.instances).filter(i => i.compute?.host.coreId === a.coreId)).toHaveLength(4);
  for (const inst of result.nodes.flatMap(n => n.instances)) {
    expect(inst.threadId).toBeNull(); expect(inst.compute?.worker?.threadId).toBeString(); expect(inst.compute?.result?.baseCommit).toBe(baseCommit);
  }
  expect(await thrown(a.client.call('workflows.check', {threadId: a.threadId, plan: {...plan, steps: [{...plan.steps[0]!, model: 'echo'}]}}))).toThrow('host owns model');
}, 30000);

test.each([undefined, {maxSteps: 24}, {maxConcurrent: 2}])('mixed workflows retain ordinary admission with plan limits %j while shared work can start', async limits => {
  const maxConcurrent = limits && 'maxConcurrent' in limits ? limits.maxConcurrent : undefined;
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const unblockA = holdAccountTurns(a.h, a.accountId), unblockB = holdAccountTurns(b.h, b.accountId);
  try {
    const run = await a.client.call('workflows.start', {threadId: a.threadId, requestId: 'mixed-admission', plan: {
      name: 'Mixed admission', ...(limits === undefined ? {} : {limits}),
      steps: [...Array.from({length: 5}, (_, i) => ({id: `local${i}`, task: 'Held local work'})),
        {id: 'remote', task: 'Held remote work', compute: {sharedProjectId: scope.sharedProjectId, host: b.ref, profileId: 'conversation', baseCommit}}],
    }});
    const current = () => a.h.core.workflows.get(a.threadId, run.id);
    await waitFor(() => current().nodes.some(n => n.instances.some(i => i.status === 'running')));
    const local = current().nodes.filter(n => n.id.startsWith('local'));
    expect(local.flatMap(n => n.instances).filter(i => i.status === 'running')).toHaveLength(maxConcurrent ?? 3);
    expect(local.flatMap(n => n.instances).filter(i => i.status === 'waiting')).toHaveLength(5 - (maxConcurrent ?? 3));
    if (maxConcurrent === undefined) await waitFor(() => current().nodes.find(n => n.id === 'remote')!.instances.some(i => i.compute?.jobId));
    else expect(current().nodes.find(n => n.id === 'remote')!.instances[0]!.status).toBe('waiting');
    await a.client.call('workflows.control', {threadId: a.threadId, runId: run.id, action: 'stop'});
  } finally {unblockA(); unblockB();}
}, 30000);

test('workflow stop cancels the captured remote execution; a paused restart reattaches the same completed job', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const plan: WorkflowPlan = {name: 'Shared controlled', steps: [{id: 'remote', task: '[sleep:3000]', compute: {sharedProjectId: scope.sharedProjectId, host: b.ref, profileId: 'conversation', baseCommit}}]};
  const run = await a.client.call('workflows.start', {threadId: a.threadId, plan, requestId: 'controlled'});
  await waitFor(() => !!a.h.core.workflows.get(a.threadId, run.id).nodes[0]?.instances[0]?.compute?.worker, 10000);
  const jobId = a.h.core.workflows.get(a.threadId, run.id).nodes[0]!.instances[0]!.compute!.jobId;
  await a.client.call('workflows.control', {threadId: a.threadId, runId: run.id, action: 'stop'});
  await waitFor(() => b.h.core.sharedCompute.journal.get(jobId, 'host')?.job.status === 'cancelled');
  expect(a.h.core.workflows.get(a.threadId, run.id).status).toBe('stopped');
  const next = await a.client.call('workflows.start', {threadId: a.threadId, plan: {...plan, name: 'Restarted', steps: [{...plan.steps[0]!, task: '[sleep:500]'}]}, requestId: 'recover'});
  await waitFor(() => !!a.h.core.workflows.get(a.threadId, next.id).nodes[0]?.instances[0]?.compute?.worker);
  const identity = a.h.core.workflows.get(a.threadId, next.id).nodes[0]!.instances[0]!.compute!;
  await a.h.stop();
  const restarted = await startTestCore({dataDir: a.h.dataDir, port: Number(new URL(a.h.url).port)}); cores.push(restarted);
  await waitFor(() => restarted.core.contacts.linked(b.coreId), 10000);
  const client = await restarted.connect();
  expect(restarted.core.workflows.get(a.threadId, next.id).status).toBe('paused');
  await client.call('workflows.control', {threadId: a.threadId, runId: next.id, action: 'resume'});
  await waitFor(() => restarted.core.workflows.get(a.threadId, next.id).status === 'done', 10000);
  expect(restarted.core.workflows.get(a.threadId, next.id).nodes[0]!.instances[0]!.compute!.jobId).toBe(identity.jobId);
  expect(b.h.core.journal.listChildThreads()).toHaveLength(2);
}, 30000);

test('board release cancels its exact delegated job before releasing the reservation and closes delayed starts', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  for (const s of [a, b]) await s.client.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, board: true});
  const add = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'add', requestId: 'add', cardId: 'card', text: 'delegated card'}});
  const worker = {project: a.ref, threadId: a.threadId, address: {coreId: a.coreId, threadId: a.threadId}};
  const claim = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'claim', requestId: 'claim', cardId: 'card', expectedRevision: add.revision, worker}});
  const claimId = claim.card!.assignment!.claimId;
  const input = {...scope, requestId: 'claimed-compute', host: b.ref, profileId: 'conversation', baseCommit, claimId, task: '[sleep:15000]'};
  let job = await a.client.call('sharedCompute.start', input);
  await waitFor(() => b.h.core.sharedCompute.journal.get(job.id, 'host')?.job.status === 'running');
  job = await a.client.call('sharedCompute.get', {...scope, jobId: job.id});
  expect(job.status).toBe('running');
  let released;
  try {
    released = await a.client.call('sharedBoard.apply', {...scope, command: {kind: 'release', requestId: 'release', cardId: 'card', claimId}});
  } catch (error) {
    for (const {h, coreId, threadId} of [a, b]) {
      try {
        console.error(JSON.stringify({stage: 'shared-compute.board-release-failed', coreId,
          logs: await h.core.logs.query({limit: 100}),
          workers: [threadId, job.worker!.threadId].map(id => ({threadId: id,
            status: h.core.journal.getThread(id)?.status, activity: h.core.activity.get(id),
            processes: h.core.procs.liveOf(id),
          })),
          jobs: h.core.sharedCompute.journal.all(scope.sharedProjectId).map(({role, job}) => ({
            role, id: job.id, status: job.status, revision: job.revision, error: job.error, worker: job.worker?.threadId,
          })),
        }));
      } catch (snapshotError) {console.error(`shared-compute.board-release-snapshot: ${String(snapshotError)}`);}
    }
    throw error;
  }
  expect(released.outcome).toBe('applied'); expect(released.card!.assignment).toBeNull();
  expect(b.h.core.sharedCompute.journal.get(job.id, 'host')?.job.status).toBe('cancelled');
  expect(b.h.core.procs.liveCount(job.worker!.threadId)).toBe(0);
  let late = await a.client.call('sharedCompute.start', {...input, requestId: 'late'});
  await waitFor(() => b.h.core.sharedCompute.journal.get(late.id, 'host')?.job.status === 'failed');
  late = await a.client.call('sharedCompute.get', {...scope, jobId: late.id});
  expect(late.status).toBe('failed');
}, 30000);

test('one source request cannot launch once locally and once remotely under colliding job IDs', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(a); await enable(b);
  const p = {...scope, requestId: 'host-collision', host: b.ref, profileId: 'conversation', baseCommit, task: 'one task'};
  await a.client.call('sharedCompute.start', p);
  expect(await thrown(a.client.call('sharedCompute.start', {...p, host: a.ref}))).toThrow('different compute content');
  expect(a.h.core.journal.listChildThreads()).toHaveLength(0);
}, 30000);

test('a completed worker returns a fresh commit read from its captured checkout, not from its answer', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const guard = b.h.core.sharedCompute.guardStart;
  let actualCommit = '';
  b.h.core.sharedCompute.guardStart = async (ctx, ref, job) => {
    await guard(ctx, ref, job);
    const worker = b.h.core.threads.require(ref.threadId);
    writeFileSync(join(worker.cwd, 'verified.txt'), 'fixture content\n');
    await git(b.h, worker.cwd, 'add', 'verified.txt');
    await git(b.h, worker.cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture result');
    actualCommit = await git(b.h, worker.cwd, 'rev-parse', 'HEAD');
  };
  const job = await done(a, scope, await a.client.call('sharedCompute.start', {...scope, requestId: 'new-commit', host: b.ref, profileId: 'conversation', baseCommit, task: 'My answer claims commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and branch evil.'}));
  expect(job.result!.commit).toBe(actualCommit); expect(actualCommit).not.toBe(baseCommit);
  expect(await git(b.h, b.path, 'show', `${job.result!.commit}:verified.txt`)).toBe('fixture content');
  expect(job.result!.branch).not.toBe('evil');
}, 30000);

test('a consent change during admission fences the captured worker before any provider turn', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  b.h.core.sharedCompute.guardStart = async () => {entered = true; await held;};
  const pending = a.client.call('sharedCompute.start', {...scope, requestId: 'held-guard', host: b.ref, profileId: 'conversation', baseCommit, task: 'must not execute'}).catch(error => error);
  await waitFor(() => entered);
  await b.client.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, compute: {enabled: false, profiles: [], permissionMode: 'default', maxConcurrent: null}});
  release(); await pending;
  const record = b.h.core.sharedCompute.journal.all(scope.sharedProjectId)[0]!;
  await waitFor(() => b.h.core.sharedCompute.journal.get(record.job.id, 'host')?.job.status === 'revoked');
  expect(b.h.core.journal.db.query('SELECT COUNT(*) AS n FROM turns WHERE thread_id=?').get(record.job.worker!.threadId)).toEqual({n: 0});
  expect(b.h.core.procs.liveCount(record.job.worker!.threadId)).toBe(0);
}, 30000);

test('shared checkout preparation and result inspection cannot execute host git hooks or filters', async () => {
  const {a, b, scope, enable} = await pair();
  writeFileSync(join(a.path, '.gitattributes'), '*.txt filter=fixture\n');
  writeFileSync(join(a.path, 'data.txt'), 'ordinary data\n');
  await git(a.h, a.path, 'add', '.gitattributes', 'data.txt');
  await git(a.h, a.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'filter fixture');
  const baseCommit = await git(a.h, a.path, 'rev-parse', 'HEAD');
  await git(b.h, b.path, 'fetch', a.path, 'main'); await git(b.h, b.path, 'reset', '--hard', 'FETCH_HEAD');
  const hookMarker = join(b.h.dataDir, 'hook-executed'), filterMarker = join(b.h.dataDir, 'filter-executed');
  const hook = join(b.path, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\ntouch '${hookMarker}'\n`); chmodSync(hook, 0o755);
  await git(b.h, b.path, 'config', 'filter.fixture.smudge', `touch '${filterMarker}'; cat`);
  await git(b.h, b.path, 'config', 'filter.fixture.clean', `touch '${filterMarker}'; cat`);
  await enable(b);
  const job = await done(a, scope, await a.client.call('sharedCompute.start', {...scope, requestId: 'git-hooks', host: b.ref, profileId: 'conversation', baseCommit, task: 'ordinary echo'}));
  expect(job.result?.commit).toBe(baseCommit);
  expect(existsSync(hookMarker)).toBe(false); expect(existsSync(filterMarker)).toBe(false);
}, 30000);

test('cancellation drains Git admission already in flight before confirming the captured job stopped', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const spawn = b.h.core.procs.spawn.bind(b.h.core.procs);
  let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  b.h.core.procs.spawn = (threadId, cmd, args, options) => {
    const captured = spawn(threadId, cmd, args, options);
    if (cmd === 'git' && !entered && b.h.core.sharedCompute.journal.worker(threadId)) {
      entered = true;
      return {...captured, exited: captured.exited.then(async code => {await held; return code;})};
    }
    return captured;
  };
  const pending = a.client.call('sharedCompute.start', {...scope, requestId: 'git-drain', host: b.ref, profileId: 'conversation', baseCommit, task: 'must not start'}).catch(error => error);
  await waitFor(() => entered);
  const record = b.h.core.sharedCompute.journal.all(scope.sharedProjectId)[0]!;
  const cancellation = b.client.call('sharedCompute.cancel', {...scope, threadId: b.threadId, jobId: record.job.id, requestId: 'stop-git'});
  let early: boolean;
  try {early = await Promise.race([cancellation.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 100))]);}
  finally {release();}
  await pending;
  expect((await cancellation).status).toBe('cancelled');
  expect(early!).toBe(false);
  expect(b.h.core.procs.liveCount(record.job.worker!.threadId)).toBe(0);
  expect(b.h.core.journal.db.query('SELECT COUNT(*) AS n FROM turns WHERE thread_id=?').get(record.job.worker!.threadId)).toEqual({n: 0});
}, 30000);

test('a workflow restart before the launch response recovers the same durable request and never duplicates the remote child', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const original = a.h.core.coordination.request.bind(a.h.core.coordination);
  let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  a.h.core.coordination.request = async (peer, op, payload) => {
    const result = await original(peer, op, payload);
    if (op === 'contact.project' && (payload as {method?: string}).method === 'compute.start') {
      entered = true; await held; throw unavailable('fixture lost launch response during shutdown');
    }
    return result;
  };
  const plan: WorkflowPlan = {name: 'In-flight restart', steps: [{id: 'remote', task: 'one remote child', compute: {sharedProjectId: scope.sharedProjectId, host: b.ref, profileId: 'conversation', baseCommit}}]};
  const run = await a.client.call('workflows.start', {threadId: a.threadId, plan, requestId: 'inflight-restart'});
  await waitFor(() => entered);
  const id = b.h.core.sharedCompute.journal.all(scope.sharedProjectId)[0]!.job.id;
  // Fence callbacks as the real drain does, then lose the response before closing the journal.
  a.h.core.workflows.beginClose(); release(); await a.h.stop();
  const restarted = await startTestCore({dataDir: a.h.dataDir, port: Number(new URL(a.h.url).port)}); cores.push(restarted);
  await waitFor(() => restarted.core.contacts.linked(b.coreId), 10000);
  const client = await restarted.connect();
  await client.call('workflows.control', {threadId: a.threadId, runId: run.id, action: 'resume'});
  await waitFor(() => restarted.core.workflows.get(a.threadId, run.id).status === 'done', 10000);
  expect(restarted.core.workflows.get(a.threadId, run.id).nodes[0]!.instances[0]!.compute!.jobId).toBe(id);
  expect(b.h.core.journal.listChildThreads()).toHaveLength(1);
}, 30000);

test('a workflow retry fences its previous shared job and accepts only the replacement result', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const guard = b.h.core.sharedCompute.guardStart;
  let attempts = 0;
  b.h.core.sharedCompute.guardStart = (ctx, ref, job) => {
    if (attempts++ === 0) throw unavailable('fixture fails one admission');
    return guard(ctx, ref, job);
  };
  const plan: WorkflowPlan = {name: 'Retry shared job', steps: [{id: 'remote', task: 'successful replacement', compute: {sharedProjectId: scope.sharedProjectId, host: b.ref, profileId: 'conversation', baseCommit}}]};
  const run = await a.client.call('workflows.start', {threadId: a.threadId, plan, requestId: 'retry-shared'});
  await waitFor(() => a.h.core.workflows.get(a.threadId, run.id).status === 'failed');
  const rejected = a.h.core.workflows.get(a.threadId, run.id);
  expect(rejected.error).not.toContain('fixture fails one admission');
  const failure = (await b.h.core.logs.query({source: 'shared-compute'})).find(log => log.event === 'shared-compute.admission.failed');
  expect(failure?.message).toContain('fixture fails one admission');
  expect((await a.h.core.logs.query({source: 'shared-compute'}))).toHaveLength(0);
  const first = rejected.nodes[0]!.instances[0]!.compute!;
  const previousJob = b.h.core.sharedCompute.journal.get(first.jobId, 'host')!.job;
  expect(failure?.threadId).toBe(first.worker!.threadId);
  await a.client.call('workflows.control', {threadId: a.threadId, runId: run.id, action: 'retry', stepId: 'remote'});
  await waitFor(() => ['done', 'failed'].includes(a.h.core.workflows.get(a.threadId, run.id).status));
  const last = a.h.core.workflows.get(a.threadId, run.id);
  expect(last.error).toBeNull(); expect(last.status).toBe('done');
  expect(last.nodes[0]!.instances[0]!.compute!.jobId).not.toBe(first.jobId);
  expect(b.h.core.sharedCompute.journal.get(first.jobId, 'host')!.job).toEqual(previousJob);
  expect(b.h.core.journal.listChildThreads()).toHaveLength(2);
}, 30000);

test('a worker cannot substitute another repository through its captured checkout Git pointer', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  b.h.core.sharedCompute.guardStart = (_ctx, worker) => {
    const thread = b.h.core.threads.require(worker.threadId);
    writeFileSync(join(thread.cwd, '.git'), `gitdir: ${join(a.path, '.git')}\n`);
  };
  let job = await a.client.call('sharedCompute.start', {...scope, requestId: 'foreign-git', host: b.ref, profileId: 'conversation', baseCommit, task: 'must not start'});
  await waitFor(() => b.h.core.sharedCompute.journal.get(job.id, 'host')?.job.status === 'failed');
  job = await a.client.call('sharedCompute.get', {...scope, jobId: job.id});
  expect(job.status).toBe('failed'); expect(job.result).toBeNull();
  expect(b.h.core.journal.db.query('SELECT COUNT(*) AS n FROM turns WHERE thread_id=?').get(job.worker!.threadId)).toEqual({n: 0});
}, 30000);

test('a tool-free shared driver cannot escape through the SDK child-process launcher', async () => {
  const {a, b, scope, baseCommit, enable} = await pair(); await enable(b);
  const marker = join(b.h.dataDir, 'sdk-spawn-marker');
  const restore = setDriver('echo', {protocol: 'echo', startTurn(ctx) {
    const child = ctx.spawnChild(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped')`]);
    return {done: new Promise<TurnResult>(resolve => child.once('close', () => resolve({status: 'done', sessionId: null, usage: null}))), stop() {child.kill();}};
  }});
  try {
    const job = await a.client.call('sharedCompute.start', {...scope, requestId: 'sdk-spawn', host: b.ref, profileId: 'conversation', baseCommit, task: 'hostile driver fixture'});
    await waitFor(() => ['done', 'failed'].includes(b.h.core.sharedCompute.journal.get(job.id, 'host')!.job.status));
    expect(existsSync(marker)).toBe(false);
    expect(b.h.core.sharedCompute.journal.get(job.id, 'host')!.job.status).toBe('failed');
  } finally {restore();}
}, 30000);

test('a workflow can retry a local host rejection that never reserved or dispatched a job', async () => {
  const {a, scope, baseCommit, enable} = await pair(); await enable(a);
  const protection = a.h.core.sharedCompute.protection;
  a.h.core.sharedCompute.protection = () => ({supported: false, reason: 'fixture unavailable boundary'});
  const run = await a.client.call('workflows.start', {threadId: a.threadId, requestId: 'pre-admission', plan: {name: 'Retry admission', steps: [{id: 'local', task: 'one child', compute: {sharedProjectId: scope.sharedProjectId, host: a.ref, profileId: 'conversation', baseCommit}}]}});
  await waitFor(() => a.h.core.workflows.get(a.threadId, run.id).status === 'failed');
  expect(a.h.core.sharedCompute.journal.all(scope.sharedProjectId)).toHaveLength(0);
  a.h.core.sharedCompute.protection = protection;
  await a.client.call('workflows.control', {threadId: a.threadId, runId: run.id, action: 'retry', stepId: 'local'});
  await waitFor(() => ['done', 'failed'].includes(a.h.core.workflows.get(a.threadId, run.id).status));
  expect(a.h.core.workflows.get(a.threadId, run.id).status).toBe('done');
  expect(a.h.core.journal.listChildThreads()).toHaveLength(1);
}, 30000);
