import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONVERSATION_PROFILE_ID, RpcErrorCode } from '@boite/contracts';
import { assertAllowed } from '../src/access.ts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoDriver } from '../src/drivers/echo.ts';
import { MergedPrArchive } from '../src/merged-pr-archive.ts';
import { archiveState } from '../src/merged-pr-archive-state.ts';
import { githubRepository, parseMergedPrProof } from '../src/pull-requests.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore;
let service: MergedPrArchive;
let restoreSpawn: (() => void) | undefined;
let restoreDriver: (() => void) | undefined;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { restoreSpawn?.(); restoreSpawn = undefined; await service?.close(); await harness.stop(); restoreDriver?.(); restoreDriver = undefined; });
const gitEnv = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Fixture', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'fixture@example.invalid' };
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd, env: gitEnv, stdout: 'pipe', stderr: 'pipe' });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function fixture() {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const repo = join(harness.dataDir, 'repo'), checkout = join(harness.dataDir, 'worktree');
  mkdirSync(repo);
  git(repo, 'init', '-q'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'fixture');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
  git(repo, 'worktree', 'add', '-q', '-b', 'topic', checkout);
  const thread = harness.core.threads.require(threadId);
  const project = harness.core.journal.getProject(thread.projectId!)!;
  harness.core.journal.putProject({ ...project, path: repo });
  harness.core.journal.putThread({ ...thread, cwd: checkout, branch: 'topic', pinned: false, unread: false });
  const sha = git(checkout, 'rev-parse', 'HEAD');
  let candidates = [{ number: 7, url: 'https://github.com/example/repo/pull/7', state: 'MERGED', headRefName: 'topic', headRefOid: sha, headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'example' }, isCrossRepository: false, mergedAt: '2026-10-01T12:00:00Z' }];
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  let ghGate: string | undefined;
  let ghCalls = 0;
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
    if (command !== 'gh') return spawn(scope, command, args, options);
    ghCalls++;
    const wait = ghGate ? `while (!require('node:fs').existsSync(${JSON.stringify(ghGate)})) await Bun.sleep(5);` : '';
    return spawn(scope, process.execPath, ['-e', `${wait}console.log(${JSON.stringify(JSON.stringify(candidates))})`], options);
  });
  restoreSpawn = () => replacement.mockRestore();
  await harness.core.mergedPrArchive.close();
  service = new MergedPrArchive(harness.core, harness.core.pullRequests, 0, 0);
  Object.defineProperty(harness.core, 'mergedPrArchive', { value: service });
  return { client, threadId, repo, checkout, project, sha, setCandidates: (value: typeof candidates) => { candidates = value; }, candidates,
    holdGh: () => { ghGate = join(harness.dataDir, 'gh-gate'); },
    releaseGh: () => { if (ghGate) writeFileSync(ghGate, 'ready'); },
    ghCalls: () => ghCalls,
  };
}

async function completedFamily() {
  restoreDriver = setDriver('echo', { protocol: 'echo', sideQuestion: async () => 'Completed fixture question.', startTurn(ctx) {
    const message = ctx.emit.startMessage('assistant');
    ctx.emit.part(message, 0, { type: 'text', text: 'Completed fixture work.' });
    ctx.emit.complete(message, 'complete');
    return { done: Promise.resolve({ status: 'done', sessionId: null, usage: null }), stop() {} };
  } });
  const f = await fixture();
  const run = await f.client.call('workflows.start', { threadId: f.threadId, requestId: 'archive-family-workflow', plan: { name: 'Completed family', steps: [{ id: 'review', task: 'Review the merged change.' }] } });
  await waitFor(() => {
    const current = harness.core.workflows.get(f.threadId, run.id);
    return current.status === 'done' && current.delivered && harness.core.threads.require(f.threadId).status === 'idle';
  });
  const delegated = await f.client.call('delegation.spawn', { threadId: f.threadId, profileId: CONVERSATION_PROFILE_ID, task: 'Verify the merged change.', requestId: 'archive-family-delegate' });
  await waitFor(() => {
    const team = harness.core.delegation.get(f.threadId);
    return team.messages.some(letter => letter.origin === 'result' && letter.status === 'delivered') && harness.core.threads.require(f.threadId).status === 'idle' && harness.core.threads.require(delegated.thread.id).status === 'idle';
  });
  const children = harness.core.journal.listThreads().filter(thread => thread.parentThreadId === f.threadId);
  expect(children).toHaveLength(2);
  for (const thread of [harness.core.threads.require(f.threadId), ...children]) await f.client.call('threads.markRead', { threadId: thread.id });
  return { ...f, children, runId: run.id };
}

test('large archive sweeps bound hydration, yield to owner RPCs and advance beyond retained candidates', async () => {
  const f = await fixture();
  const journal = harness.core.journal;
  const original = harness.core.threads.require(f.threadId);
  const ids: string[] = [];
  journal.db.transaction(() => {
    journal.putThread({ ...original, archived: true });
    for (let index = 0; index < 20_000; index++) {
      const id = `selection-${index}`;
      ids.push(id);
      journal.putThread({ ...original, id, branch: `selection-${index}`, cwd: join(f.checkout, id), archived: index > 168 });
      journal.putMessage({ id: `selection-message-${index}`, threadId: id, turnId: `selection-turn-${index}`, role: 'user', state: 'complete', createdAt: 1, parts: [{ type: 'text', text: 'Retained history.' }] });
      if (index >= 8 && index < 168) harness.core.threads.deferred.pendingWakes.set(id, 'Retained result');
    }
  })();
  const enumerations = spyOn(journal, 'listThreads');
  const hydration = spyOn(journal, 'getThread');
  const scheduler = spyOn(harness.core.scheduler, 'state');
  const proved: string[] = [];
  const proofYielded: boolean[] = [];
  let yielded = false;
  const proof = spyOn(harness.core.pullRequests, 'proveMerged').mockImplementation(async thread => { proved.push(thread.id); proofYielded.push(yielded); return null; });
  const measurements: Record<string, number | boolean>[] = [];
  try {
    for (let pass = 0; pass < 3; pass++) {
      const enumerated = enumerations.mock.calls.length, hydrated = hydration.mock.calls.length, snapshots = scheduler.mock.calls.length, proofs = proved.length;
      yielded = false;
      setImmediate(() => { yielded = true; });
      const started = performance.now(), usage = process.cpuUsage();
      const pending = service.sweep();
      const synchronousMs = performance.now() - started;
      const rpcStarted = performance.now();
      expect((await f.client.call('projects.list', {})).some(project => project.id === f.project.id)).toBe(true);
      const rpcMs = performance.now() - rpcStarted;
      expect(await pending).toBe(0);
      const elapsedMs = performance.now() - started;
      const cpu = process.cpuUsage(usage);
      measurements.push({ pass, enumerations: enumerations.mock.calls.length - enumerated, hydrated: hydration.mock.calls.length - hydrated,
        schedulerSnapshots: scheduler.mock.calls.length - snapshots, proofs: proved.length - proofs, synchronousMs, elapsedMs, rpcMs,
        cpuMs: (cpu.user + cpu.system) / 1000, yielded });
    }
    console.log('archive-selection-measurement', JSON.stringify({ threads: 20_001, messages: 20_000, measurements }));
    expect(enumerations).not.toHaveBeenCalled();
    expect(measurements.every(measurement => Number(measurement.hydrated) <= 136 && Number(measurement.schedulerSnapshots) <= 17)).toBe(true);
    expect(measurements.every(measurement => Number(measurement.proofs) <= 8)).toBe(true);
    expect(proofYielded.every(Boolean)).toBe(true);
    expect(proved).toContain(ids[168]!);
    expect(proved.filter(id => ids.slice(8, 168).includes(id))).toEqual([]);
    expect(harness.core.threads.require(ids[168]!).archived).toBe(false);
    const unrelated = await echoThread(harness, f.client, 'Unrelated work after archive scans');
    const turn = await f.client.call('turns.start', { threadId: unrelated.threadId, prompt: 'Still functional.' });
    await waitFor(() => journal.getTurn(turn.id)?.status === 'done');
    expect(journal.getTurn(turn.id)?.status).toBe('done');
  } finally { proof.mockRestore(); enumerations.mockRestore(); hydration.mockRestore(); scheduler.mockRestore(); }
});

test('archive rowid cycles revisit old candidates while appends and replacements continue', async () => {
  const f = await fixture();
  const journal = harness.core.journal;
  const original = harness.core.threads.require(f.threadId);
  journal.putThread({ ...original, archived: true });
  const ids = Array.from({ length: 9 }, (_, index) => `cycle-${index}`);
  for (const id of ids) journal.putThread({ ...original, id, branch: id, cwd: join(f.checkout, id) });
  const proved: string[] = [];
  const proof = spyOn(harness.core.pullRequests, 'proveMerged').mockImplementation(async thread => { proved.push(thread.id); return null; });
  try {
    expect(await service.sweep()).toBe(0);
    expect(proved).toEqual(ids.slice(0, 8));
    // A replaced row receives a new rowid outside the current cycle boundary.
    journal.putThread({ ...original, id: ids[0]!, branch: ids[0]!, cwd: join(f.checkout, ids[0]!) });
    for (let index = 0; index < 32; index++) journal.putThread({ ...original, id: `append-${index}`, archived: true });
    expect(await service.sweep()).toBe(0);
    expect(proved.slice(8)).toEqual([ids[8]!]);
    for (let index = 32; index < 64; index++) journal.putThread({ ...original, id: `append-${index}`, archived: true });
    const secondCycle = proved.length;
    expect(await service.sweep()).toBe(0);
    expect(proved.slice(secondCycle)).toHaveLength(8);
    for (let index = 64; index < 96; index++) journal.putThread({ ...original, id: `append-${index}`, archived: true });
    expect(await service.sweep()).toBe(0);
    expect(proved.slice(secondCycle)).toContain(ids[0]!);
  } finally { proof.mockRestore(); }
});

test('root mutations during archive selection yields are observed before proof admission', async () => {
  const f = await fixture();
  const journal = harness.core.journal;
  const original = harness.core.threads.require(f.threadId);
  const proof = spyOn(harness.core.pullRequests, 'proveMerged').mockResolvedValue(null);
  try {
    for (const mutate of [
      () => journal.putThread({ ...original, status: 'running' }),
      () => journal.stageThreadDeletion(original.id, [original]),
    ]) {
      let mutated = false;
      const mutation = new Promise<void>(resolve => setImmediate(() => { mutate(); mutated = true; resolve(); }));
      const sweeping = service.sweep();
      await mutation;
      expect(await sweeping).toBe(0);
      expect(mutated).toBe(true);
      expect(proof).not.toHaveBeenCalled();
      journal.restoreDeletedThreads(original.id);
      journal.putThread(original);
    }
    expect(await f.client.call('projects.list', {})).toBeInstanceOf(Array);
  } finally { proof.mockRestore(); }
});

test('a completed delivered workflow and delegation family archives with histories intact and rejects late child work until restore', async () => {
  const f = await completedFamily();
  const childId = f.children[0]!.id;
  const child = harness.core.threads.require(childId);
  const history = harness.core.journal.listTurns(childId);
  const stale = await connect(harness.url, harness.core.agents.tokenFor(childId));
  try {
    expect(await service.sweep()).toBe(1);
    expect(harness.core.threads.require(f.threadId).archived).toBe(true);
    expect(harness.core.threads.require(childId)).toEqual(child);
    expect(harness.core.journal.listTurns(childId)).toEqual(history);
    expect(existsSync(join(f.checkout, '.git'))).toBe(true);
    await expect(f.client.call('turns.start', { threadId: childId, prompt: 'Late child work' })).rejects.toMatchObject({ rpc: { code: RpcErrorCode.Refused } });
    await expect(f.client.call('threads.btw', { threadId: childId, question: 'Late child question', requestId: 'side_archived_child' })).rejects.toMatchObject({ rpc: { code: RpcErrorCode.Refused } });
    await expect(stale.call('delegation.send', { threadId: childId, toThreadId: f.threadId, text: 'Late result', requestId: 'late-family-result' })).rejects.toThrow();
    harness.core.threads.deferred.wake(childId, 'Late background wake');
    expect(harness.core.journal.listTurns(childId)).toEqual(history);
    await f.client.call('threads.archive', { threadId: f.threadId, archived: false });
    expect(await service.sweep()).toBe(0);
    const resumed = await f.client.call('turns.start', { threadId: childId, prompt: 'Explicit work after restore' });
    await waitFor(() => harness.core.journal.getTurn(resumed.id)?.status === 'done');
  } finally { stale.close(); }
});

test('retained child activity, unread results, protected input and undelivered family results prevent archive', async () => {
  const f = await completedFamily();
  const child = harness.core.threads.require(f.children[0]!.id);
  for (const patch of [{ status: 'running' as const }, { unread: true }, { pinned: true }, { agentSessionId: 'retained-session' }]) {
    harness.core.journal.putThread({ ...child, ...patch });
    expect(await service.sweep()).toBe(0);
  }
  harness.core.journal.putThread(child);
  const childProcess = harness.core.procs.spawn(child.id, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.checkout });
  try { expect(await service.sweep()).toBe(0); }
  finally { harness.core.procs.killTree(child.id); await childProcess.exited; }
  await f.client.call('threads.focus', { threadId: null, protectedThreadIds: [child.id] });
  expect(await service.sweep()).toBe(0);
  await f.client.call('threads.focus', { threadId: child.id, protectedThreadIds: [] });
  expect(await service.sweep()).toBe(0);
  await f.client.call('threads.focus', { threadId: null });
  harness.core.journal.db.query("UPDATE workflow_runs SET data = json_set(data, '$.delivered', 0) WHERE id = ?").run(f.runId);
  expect(await service.sweep()).toBe(0);
  harness.core.journal.db.query("UPDATE workflow_runs SET data = json_set(data, '$.delivered', 1) WHERE id = ?").run(f.runId);
  const letter = harness.core.delegation.get(f.threadId).messages.find(letter => letter.origin === 'result')!;
  harness.core.journal.db.query("UPDATE delegation_messages SET status = 'uncertain' WHERE id = ?").run(letter.id);
  expect(await service.sweep()).toBe(0);
  harness.core.journal.db.query("UPDATE delegation_messages SET status = 'delivered' WHERE id = ?").run(letter.id);
  // Archiving a completed child does not discard its retained unread/input/result guards.
  harness.core.journal.putThread({ ...child, archived: true, unread: true });
  expect(await service.sweep()).toBe(0);
  harness.core.journal.putThread({ ...child, archived: true });
  expect(await service.sweep()).toBe(1);
});

test('pending and retained side answers on a root or retained descendant keep the merged family visible', async () => {
  const f = await completedFamily();
  const child = f.children[0]!;
  const descendant = { ...harness.core.threads.require(child.id), id: 'thr_archive_descendant', parentThreadId: child.id };
  harness.core.journal.putThread(descendant);
  harness.core.journal.putTurn({ ...harness.core.journal.listTurns(child.id).at(-1)!, id: 'trn_archive_descendant', threadId: descendant.id });
  restoreDriver?.();
  let finish!: (answer: string) => void;
  restoreDriver = setDriver('echo', { ...echoDriver, sideQuestion: () => new Promise(resolve => { finish = resolve; }) });
  const root = harness.core.threads.require(f.threadId);
  for (const threadId of [f.threadId, child.id, descendant.id]) {
    const answered = f.client.next('thread.btw', event => event.requestId === 'side_archive');
    await f.client.call('threads.subscribe', { threadId });
    await f.client.call('threads.btw', { threadId, question: 'Keep this answer available', requestId: 'side_archive' });
    expect(harness.core.threads.require(threadId).status).toBe('idle');
    expect(harness.core.procs.liveCount(threadId)).toBe(0);
    expect(await service.sweep()).toBe(0);
    finish('A retained answer');
    expect((await answered).answer).toBe('A retained answer');
    expect(await service.sweep()).toBe(0);
    await f.client.call('threads.btw.cancel', { threadId, requestId: 'side_archive' });
    expect(service.eligible(root)).toBe(true);
  }
  expect(await service.sweep()).toBe(1);
  expect(harness.core.threads.require(f.threadId).archived).toBe(true);
});

test('a child turn admitted during final Git validation keeps its merged parent visible', async () => {
  const f = await completedFamily();
  const childId = f.children[0]!.id;
  restoreDriver?.();
  restoreDriver = setDriver('echo', { protocol: 'echo', startTurn() {
    let finish!: () => void;
    const done = new Promise<import('../src/drivers/types.ts').TurnResult>(resolve => { finish = () => resolve({ status: 'stopped', sessionId: null, usage: null }); });
    return { done, stop: finish };
  } });
  const validate = harness.core.pullRequests.validateMergedCheckout.bind(harness.core.pullRequests);
  const held = spyOn(harness.core.pullRequests, 'validateMergedCheckout').mockImplementation(async (thread, proof, signal) => {
    const valid = await validate(thread, proof, signal);
    harness.core.threads.startTurn(childId, 'Work admitted while Git was validating');
    return valid;
  });
  try {
    expect(await service.sweep()).toBe(0);
    expect(harness.core.threads.require(childId).status).toBe('running');
    expect(harness.core.threads.require(f.threadId).archived).toBe(false);
  } finally { held.mockRestore(); harness.core.threads.stopTurn(childId); }
});

test('strict action proof rejects forks, reused branch, wrong tip and repository ambiguity', () => {
  const expected = { repository: 'github.com/example/repo', checkoutRepository: '/repo/.git', branch: 'topic', sha: 'a'.repeat(40) };
  const pr = { number: 7, url: 'https://github.com/example/repo/pull/7', state: 'MERGED', headRefName: 'topic', headRefOid: expected.sha, headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'example' }, isCrossRepository: false, mergedAt: '2026-10-01T12:00:00Z' };
  expect(parseMergedPrProof(JSON.stringify([pr]), expected)?.number).toBe(7);
  for (const candidate of [[pr, pr], [{ ...pr, isCrossRepository: true }], [{ ...pr, headRefOid: 'b'.repeat(40) }], [{ ...pr, headRefName: 'other' }], [{ ...pr, headRepositoryOwner: { login: 'fork' } }], [{ ...pr, mergedAt: null }], [{ ...pr, url: `${pr.url}?token=unsafe` }]]) expect(parseMergedPrProof(JSON.stringify(candidate), expected)).toBeNull();
  expect(githubRepository('origin https://github.com/example/repo.git (fetch)\norigin git@github.com:example/repo.git (push)')).toBe(expected.repository);
  expect(githubRepository('origin https://github.com/fork/repo.git (fetch)\nupstream https://github.com/example/repo.git (fetch)')).toBeNull();
});

test('closing the archive aborts its current proof and fences a late completion', async () => {
  const f = await fixture();
  let signal: AbortSignal | undefined;
  let release!: (value: null) => void;
  const proof = new Promise<null>(resolve => { release = resolve; });
  const held = spyOn(harness.core.pullRequests, 'proveMerged').mockImplementation((_thread, ownerSignal) => { signal = ownerSignal; return proof; });
  const pass = service.sweep();
  let closed = false;
  try {
    await waitFor(() => signal !== undefined, 500);
    const closing = service.close().then(() => { closed = true; });
    await waitFor(() => closed, 500);
    expect(signal!.aborted).toBe(true);
    release(null);
    await Promise.all([pass, closing]);
    expect(harness.core.threads.require(f.threadId).archived).toBe(false);
    expect(archiveState(harness.core.journal, f.threadId).binding).toBeUndefined();
  } finally { release(null); held.mockRestore(); await pass; }
});

test('canceling one proof consumer preserves the coalesced consumer and its owning process', async () => {
  const f = await fixture();
  f.holdGh();
  const thread = harness.core.threads.require(f.threadId);
  const first = new AbortController(), second = new AbortController();
  const a = harness.core.pullRequests.proveMerged(thread, first.signal).catch(() => null);
  const subscriptions = spyOn(second.signal, 'addEventListener');
  let b: ReturnType<typeof harness.core.pullRequests.proveMerged> | undefined;
  try {
    await waitFor(() => f.ghCalls() === 1);
    b = harness.core.pullRequests.proveMerged(thread, second.signal);
    // Status, remote, then the shared proof lease have each registered cancellation.
    await waitFor(() => subscriptions.mock.calls.length >= 3);
    first.abort();
    expect(await a).toBeNull();
    f.releaseGh();
    expect((await b)?.number).toBe(7);
    expect(f.ghCalls()).toBe(1);
  } finally { f.releaseGh(); first.abort(); second.abort(); subscriptions.mockRestore(); await a; await b?.catch(() => null); }
});

test('archive close cancels its last proof consumer and captured GitHub process', async () => {
  const f = await fixture();
  f.holdGh();
  const pass = service.sweep();
  let closed = false;
  try {
    await waitFor(() => f.ghCalls() === 1);
    const scopes = harness.core.procs.liveThreads().filter(scope => scope.startsWith(`pull-request:${f.threadId}:`));
    expect(scopes).toHaveLength(1);
    const closing = service.close().then(() => { closed = true; });
    await waitFor(() => closed, 500);
    expect(harness.core.procs.liveCount(scopes[0]!)).toBe(0);
    expect(await pass).toBe(0);
    expect(harness.core.threads.require(f.threadId).archived).toBe(false);
    expect(archiveState(harness.core.journal, f.threadId).binding).toBeUndefined();
    await closing;
  } finally { f.releaseGh(); await service.close(); await pass; }
});

test('archive close during validation cannot archive or write after the Journal closes', async () => {
  const f = await fixture();
  let signal: AbortSignal | undefined;
  let release!: (value: boolean) => void;
  const validation = new Promise<boolean>(resolve => { release = resolve; });
  const held = spyOn(harness.core.pullRequests, 'validateMergedCheckout').mockImplementation((_thread, _proof, ownerSignal) => { signal = ownerSignal; return validation; });
  const pass = service.sweep();
  let closed = false;
  try {
    await waitFor(() => signal !== undefined);
    const closing = service.close().then(() => { closed = true; });
    await waitFor(() => closed, 500);
    expect(signal!.aborted).toBe(true);
    expect(harness.core.threads.require(f.threadId).archived).toBe(false);
    await harness.stop();
    expect(harness.core.journal.isClosed()).toBe(true);
    release(true);
    expect(await pass).toBe(0);
    await closing;
    expect(await service.sweep()).toBe(0);
  } finally { release(true); held.mockRestore(); await pass; }
});

test('merged archive retains checkout and reason, and restored exact PR stays dismissed after restart', async () => {
  const f = await fixture();
  const secondOwner = await harness.connect();
  // Older clients omit input leases and clear parked drafts on archive events.
  await f.client.call('threads.focus', { threadId: null });
  expect(await service.sweep()).toBe(0);
  expect(harness.core.threads.require(f.threadId).archived).toBe(false);
  await f.client.call('threads.focus', { threadId: null, protectedThreadIds: [f.threadId] });
  await secondOwner.call('threads.focus', { threadId: null, protectedThreadIds: [f.threadId] });
  expect(await service.sweep()).toBe(0);
  await f.client.call('threads.focus', { threadId: null, protectedThreadIds: [] });
  await f.client.call('threads.focus', { threadId: null });
  expect(await service.sweep()).toBe(0);
  await expect(secondOwner.call('threads.focus', { threadId: null, protectedThreadIds: Array.from({ length: 257 }, (_, index) => `id-${index}`) })).rejects.toMatchObject({ rpc: { code: RpcErrorCode.InvalidParams, data: { field: 'protectedThreadIds' } } });
  expect(await service.sweep()).toBe(0);
  await f.client.call('threads.focus', { threadId: null, protectAllThreads: true });
  secondOwner.close();
  expect(await service.sweep()).toBe(0);
  await f.client.call('threads.focus', { threadId: null, protectedThreadIds: [] });
  expect(await service.sweep()).toBe(0);
  const legacyOwner = await harness.connect();
  await legacyOwner.call('threads.focus', { threadId: null });
  await f.client.call('threads.focus', { threadId: null, protectAllThreads: false });
  expect(await service.sweep()).toBe(0);
  legacyOwner.close();
  let archiveCount = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    archiveCount += await service.sweep();
    if (archiveCount) break;
    await Bun.sleep(5);
  }
  expect(archiveCount).toBe(1);
  const archived = await f.client.call('threads.get', { threadId: f.threadId });
  expect(archived.archiveReason).toMatchObject({ type: 'pr-merged', number: 7, url: 'https://github.com/example/repo/pull/7' });
  expect(existsSync(join(f.checkout, '.git'))).toBe(true);
  expect(git(f.repo, 'show-ref', '--verify', 'refs/heads/topic')).toContain(f.sha);
  await f.client.call('threads.archive', { threadId: f.threadId, archived: false });
  expect(await service.sweep()).toBe(0);
  expect(archiveState(harness.core.journal, f.threadId).dismissed).toEqual([archived.archiveReason!.url]);
  const restartDir = join(harness.dataDir, 'restart');
  mkdirSync(restartDir);
  harness.core.journal.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  copyFileSync(join(harness.dataDir, 'journal.db'), join(restartDir, 'journal.db'));
  const restarted = new Core({ dataDir: restartDir, token: harness.token });
  try {
    expect(restarted.threads.require(f.threadId).archived).toBe(false);
    expect(archiveState(restarted.journal, f.threadId).dismissed).toEqual([archived.archiveReason!.url]);
    await restarted.mergedPrArchive.close();
    const resumed = new MergedPrArchive(restarted, restarted.pullRequests, 0, 0);
    Object.defineProperty(restarted, 'mergedPrArchive', { value: resumed });
    const proof = archiveState(restarted.journal, f.threadId).binding!;
    const held = spyOn(restarted.pullRequests, 'proveMerged').mockResolvedValue(proof);
    try { expect(await resumed.sweep()).toBe(0); }
    finally { held.mockRestore(); }
  }
  finally { await restarted.close(); }
});

test('dirty, advanced or wrong checkout and duplicate root holders never archive', async () => {
  const f = await fixture();
  writeFileSync(join(f.checkout, 'dirty'), 'changes');
  expect(await service.sweep()).toBe(0);
  git(f.checkout, 'add', 'dirty'); git(f.checkout, 'commit', '-q', '-m', 'advanced');
  expect(await service.sweep()).toBe(0);
  git(f.checkout, 'reset', '--hard', f.sha);
  git(f.checkout, 'checkout', '-q', '-b', 'wrong');
  expect(await service.sweep()).toBe(0);
  git(f.checkout, 'checkout', '-q', 'topic');
  const thread = harness.core.threads.require(f.threadId);
  harness.core.journal.putThread({ ...thread, id: 'other-holder', archived: true });
  expect(await service.sweep()).toBe(0);
});

test('busy, viewed, paused workflow, child and stale opt-out or restore leave the root visible', async () => {
  const f = await fixture();
  const original = harness.core.threads.require(f.threadId);
  for (const patch of [{ status: 'waiting' as const }, { unread: true }, { pinned: true }]) {
    harness.core.journal.putThread({ ...original, ...patch }); expect(await service.sweep()).toBe(0);
  }
  harness.core.journal.putThread(original);
  harness.core.threads.focus.set('fixture-viewer', f.threadId, [], false);
  expect(await service.sweep()).toBe(0);
  harness.core.threads.focus.set('fixture-viewer', null);
  harness.core.journal.db.query("INSERT INTO workflow_runs (id,root_id,status,created_at,updated_at,data) VALUES ('paused',?,'paused',0,0,'{}')").run(f.threadId);
  expect(await service.sweep()).toBe(0);
  harness.core.journal.db.query("DELETE FROM workflow_runs WHERE id='paused'").run();
  harness.core.journal.db.query("INSERT INTO workflow_runs (id,root_id,status,created_at,updated_at,data) VALUES ('undelivered',?,'done',0,0,'{\"delivered\":false}')").run(f.threadId);
  expect(await service.sweep()).toBe(0);
  harness.core.journal.db.query("DELETE FROM workflow_runs WHERE id='undelivered'").run();
  harness.core.journal.putThread({ ...original, id: 'child', parentThreadId: original.id });
  expect(await service.sweep()).toBe(0);
  harness.core.journal.deleteThreads(['child']);
  const prove = harness.core.pullRequests.proveMerged.bind(harness.core.pullRequests);
  let duringProof = () => { harness.core.projects.setAutoArchiveMergedPr(f.project.id, false); };
  const replacement = spyOn(harness.core.pullRequests, 'proveMerged').mockImplementation(async thread => { const proof = await prove(thread); duringProof(); return proof; });
  try {
    expect(await service.sweep()).toBe(0);
    harness.core.projects.setAutoArchiveMergedPr(f.project.id, true);
    duringProof = () => { harness.core.threads.archive(f.threadId, false); };
    expect(await service.sweep()).toBe(0);
    expect(await service.sweep()).toBe(0);
  } finally { replacement.mockRestore(); }
});

test('a stale proof cannot archive a moved or deleted root', async () => {
  const f = await fixture();
  const original = harness.core.threads.require(f.threadId);
  const prove = harness.core.pullRequests.proveMerged.bind(harness.core.pullRequests);
  let action = () => { harness.core.journal.putThread({ ...original, cwd: f.repo, branch: null }); };
  const replacement = spyOn(harness.core.pullRequests, 'proveMerged').mockImplementation(async thread => { const proof = await prove(thread); action(); return proof; });
  try {
    expect(await service.sweep()).toBe(0);
    expect(harness.core.threads.require(f.threadId).cwd).toBe(f.repo);
    harness.core.journal.putThread(original);
    action = () => { harness.core.journal.deleteThreads([f.threadId]); };
    expect(await service.sweep()).toBe(0);
    expect(harness.core.journal.getThread(f.threadId)).toBeNull();
  } finally { replacement.mockRestore(); }
});


test('project opt-out survives other policy writers and default access denies devices and agents', async () => {
  const f = await fixture();
  expect((await f.client.call('projects.list', {})).find(project => project.id === f.project.id)?.autoArchiveMergedPr).toBe(true);
  await f.client.call('projects.setAutoArchiveMergedPr', { projectId: f.project.id, enabled: false });
  await f.client.call('projects.setWorktreeDefault', { projectId: f.project.id, enabled: false });
  await f.client.call('projects.archive', { projectId: f.project.id, archived: true });
  await f.client.call('projects.archive', { projectId: f.project.id, archived: false });
  expect(harness.core.projects.require(f.project.id).autoArchiveMergedPr).toBe(false);
  for (const principal of ['session', 'agent'] as const) expect(() => assertAllowed('projects.setAutoArchiveMergedPr', { identity: { principal, threadId: f.threadId, sessionId: 'fixture' } } as never, { projectId: f.project.id, enabled: true })).toThrow();
  await expect(f.client.call('projects.setAutoArchiveMergedPr', { projectId: f.project.id, enabled: 'yes' as never })).rejects.toThrow('boolean');
  expect(await service.sweep()).toBe(0);
});
