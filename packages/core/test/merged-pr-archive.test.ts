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
import { fetchedRepositories, githubRepository, parseMergedPrProof } from '../src/pull-requests.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { rejection, thrown } from './settle.ts';

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
  let candidates = [{ title: 'Merged change', baseRefName: 'main', number: 7, url: 'https://github.com/example/repo/pull/7', state: 'MERGED', headRefName: 'topic', headRefOid: sha, headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'example' }, isCrossRepository: false, mergedAt: '2026-10-01T12:00:00Z' }];
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  let ghGate: string | undefined;
  let hideList = false;
  let unavailableView: string | undefined;
  let ghCalls = 0;
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
    if (command !== 'gh') return spawn(scope, command, args, options);
    ghCalls++;
    const wait = ghGate ? `while (!require('node:fs').existsSync(${JSON.stringify(ghGate)})) await Bun.sleep(5);` : '';
    // `gh pr view <url>` answers one object, or fails for an unknown PR.
    if (args[1] === 'view') {
      if (args[2] === unavailableView) return spawn(scope, process.execPath, ['-e', 'console.error("HTTP 502: Bad Gateway"); process.exit(1)'], options);
      const found = candidates.find(candidate => candidate.url === args[2]);
      return spawn(scope, process.execPath, ['-e', found ? `${wait}console.log(${JSON.stringify(JSON.stringify(found))})` : 'console.error("no pull requests found"); process.exit(1)'], options);
    }
    return spawn(scope, process.execPath, ['-e', `${wait}console.log(${JSON.stringify(JSON.stringify(hideList ? [] : candidates))})`], options);
  });
  restoreSpawn = () => replacement.mockRestore();
  await harness.core.mergedPrArchive.close();
  service = new MergedPrArchive(harness.core, harness.core.pullRequests, 0, 0);
  Object.defineProperty(harness.core, 'mergedPrArchive', { value: service });
  return { client, threadId, repo, checkout, project, sha, setCandidates: (value: typeof candidates) => { candidates = value; }, candidates,
    holdGh: () => { ghGate = join(harness.dataDir, 'gh-gate'); },
    releaseGh: () => { if (ghGate) writeFileSync(ghGate, 'ready'); },
    ghCalls: () => ghCalls,
    hideList: () => { hideList = true; },
    failView: (url: string) => { unavailableView = url; },
    /** Every process the core spawned since the fixture started, as `<command> <first argument>`. */
    spawned: () => replacement.mock.calls.map(([, command, args]) => `${command} ${args[0]}`),
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
  // Both finished and told their parent: they are put away as done.
  expect(children.map(child => [child.archived, child.doneAt != null])).toEqual([[true, true], [true, true]]);
  for (const thread of [harness.core.threads.require(f.threadId), ...children]) await f.client.call('threads.markRead', { threadId: thread.id });
  return { ...f, children, runId: run.id };
}

test.each(['badge', 'linked PR'] as const)('a merge detected by the %s moves directly to Done and lets the current prompt finish', async source => {
  const f = await fixture();
  const core = harness.core;
  const original = core.threads.require(f.threadId);
  for (let index = 0; index < 300; index++) core.journal.putThread({ ...original, id: `retained-${index}`, branch: `retained-${index}`, archived: true });
  core.journal.putThread(original); // Beyond the next periodic scan's 128 rows.
  await service.close();
  service = new MergedPrArchive(core, core.pullRequests); // Normal startup grace and settling delay.
  Object.defineProperty(core, 'mergedPrArchive', { value: service });
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let stops = 0;
  restoreDriver = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    return { stop() { stops++; finish(); }, done: gate.then(() => {
      const message = ctx.emit.startMessage('assistant');
      ctx.emit.part(message, 0, { type: 'text', text: 'Final answer after the merge.' });
      ctx.emit.complete(message, 'complete');
      return { status: 'done' as const, sessionId: null, usage: null };
    }) };
  } });
  const turn = await f.client.call('turns.start', { threadId: f.threadId, prompt: 'Finish reporting the merged change.' });
  const token = core.agents.tokenFor(f.threadId);
  const agent = await connect(harness.url, token);
  const owned = core.procs.spawn(f.threadId, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.checkout });
  try {
    await waitFor(() => core.threads.runner.handles.has(f.threadId));
    if (source === 'badge') expect(await f.client.call('threads.pullRequest', { threadId: f.threadId })).toMatchObject({ state: 'MERGED' });
    else await f.client.call('threads.linkPullRequest', { threadId: f.threadId, url: f.candidates[0]!.url });
    await waitFor(() => core.threads.require(f.threadId).doneAt != null, 1500);
    expect(core.threads.require(f.threadId)).toMatchObject({ archived: true, status: 'running' });
    // Done only hides the row: what the finishing prompt still runs in the background stays on it.
    const running = core.threads.require(f.threadId);
    const owner = { providerId: running.providerId, sessionGeneration: running.sessionGeneration ?? 0, parentTurnId: turn.id };
    core.threads.agentState.noteBackground(f.threadId, [{ id: 'merged-task', kind: 'shell', description: 'Native work', toolId: null, startedAt: Date.now() }], owner);
    expect(await f.client.call('threads.get', { threadId: f.threadId })).toMatchObject({ archived: true, backgroundWork: { kinds: ['shell'] } });
    core.threads.agentState.noteBackground(f.threadId, [], owner);
    expect(stops).toBe(0);
    expect(core.procs.liveCount(f.threadId)).toBe(1);
    expect(await agent.call('agent.where', { threadId: f.threadId })).toMatchObject({ threadId: f.threadId });
    finish();
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done');
    const saved = await f.client.call('threads.get', { threadId: f.threadId });
    expect(saved).toMatchObject({ archived: true, status: 'idle', archiveReason: { type: 'pr-merged', number: 7 } });
    expect(saved.messages.flatMap(message => message.parts).some(part => part.type === 'text' && part.text === 'Final answer after the merge.')).toBe(true);
    await waitFor(() => core.agents.authenticate(token) === null);
    expect(stops).toBe(0);
  } finally { finish(); agent.close(); core.procs.killTree(f.threadId); await owned.exited; }
});

test.each(['before Done', 'after Done', 'scheduled turn'] as const)('Done stops compaction: %s', async timing => {
  const f = await fixture();
  const core = harness.core;
  let report!: () => void;
  let finish!: () => void;
  let stops = 0;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  restoreDriver = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    const message = ctx.emit.startMessage('assistant');
    ctx.emit.part(message, 0, { type: 'text', text: 'The change has merged.' });
    ctx.emit.complete(message, 'complete');
    report = () => ctx.reportProgress?.('compacting');
    return {
      stop() { stops++; finish(); },
      done: gate.then(() => ({ status: 'stopped' as const, sessionId: null, usage: null })),
    };
  } });
  const turn = core.threads.startTurn(f.threadId, 'Finish reporting the merged change.',
    timing === 'scheduled turn' ? { kind: 'compact', automatic: false } : undefined);
  try {
    await waitFor(() => core.threads.runner.handles.has(f.threadId));
    if (timing === 'before Done') report();
    expect(await f.client.call('threads.pullRequest', { threadId: f.threadId })).toMatchObject({ state: 'MERGED' });
    await waitFor(() => core.threads.require(f.threadId).doneAt != null, 1500);
    if (timing === 'after Done') {
      expect(stops).toBe(0); // The final answer can still finish until compaction starts.
      report();
    }
    expect(stops).toBe(1);
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'stopped', 1500);
    expect(core.threads.require(f.threadId)).toMatchObject({ archived: true, status: 'idle', doneAt: expect.any(Number) });
    const saved = await f.client.call('threads.get', { threadId: f.threadId });
    expect(saved.messages.flatMap(message => message.parts)).toContainEqual({ type: 'text', text: 'The change has merged.' });
  } finally { finish(); }
});

test.each(['restore', 'draft'] as const)('detected merges respect a late %s during checkout validation', async change => {
  const f = await fixture();
  const core = harness.core;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let validating = false;
  let validated = false;
  const validate = core.pullRequests.validateMergedCheckout.bind(core.pullRequests);
  const held = spyOn(core.pullRequests, 'validateMergedCheckout').mockImplementation(async (...args) => {
    validating = true;
    await gate;
    return validate(...args).finally(() => { validated = true; });
  });
  try {
    await f.client.call('threads.pullRequest', { threadId: f.threadId });
    await waitFor(() => validating);
    if (change === 'restore') core.threads.archive(f.threadId, false);
    else core.threads.focus.set('typing-device', null, [f.threadId]);
    release();
    await waitFor(() => validated);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(core.threads.require(f.threadId).archived).toBe(false);
  } finally { release(); held.mockRestore(); }
});

test('a merge observed as the last detection finishes is processed without another notification', async () => {
  const f = await fixture();
  const journal = harness.core.journal;
  const read = journal.getThread.bind(journal);
  const get = spyOn(journal, 'getThread').mockImplementation(id => {
    if (id === 'deleted-merge-detection') {
      // A badge result queued behind the final read runs before the drain's cleanup.
      queueMicrotask(() => service.observe(f.threadId));
      return null;
    }
    return read(id);
  });
  try {
    service.observe('deleted-merge-detection');
    await waitFor(() => harness.core.threads.require(f.threadId).archived, 1500);
  } finally { get.mockRestore(); }
});

test('a failed detected conversation read leaves it visible and continues with the next merge', async () => {
  const f = await fixture();
  const core = harness.core, journal = core.journal;
  const broken = 'unreadable-detected-thread';
  journal.putThread({ ...core.threads.require(f.threadId), id: broken, branch: 'unreadable' });
  const read = journal.getThread.bind(journal);
  const warning = spyOn(core, 'log');
  const get = spyOn(journal, 'getThread').mockImplementation(id => {
    if (id === broken) throw new Error('fixture journal read failed');
    return read(id);
  });
  try {
    service.observe(broken);
    service.observe(f.threadId);
    await waitFor(() => core.threads.require(f.threadId).archived, 1500);
    expect(warning.mock.calls.some(([, , context]) => context?.event === 'archive.detectionFailed' && context.threadId === broken)).toBe(true);
  } finally { get.mockRestore(); warning.mockRestore(); }
  expect(core.threads.require(broken).archived).toBe(false);
});

test('detected proof failures back off independently of history scans and retry after expiry or a thread change', async () => {
  const f = await fixture();
  const journal = harness.core.journal;
  const original = harness.core.threads.require(f.threadId);
  const proof = spyOn(harness.core.pullRequests, 'proveMerged').mockResolvedValue(null);
  const now = Date.now.bind(Date);
  let elapsed = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
  const observe = async () => {
    service.observe(f.threadId);
    // A null proof settles within the detection turn, including its promise callbacks.
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  try {
    expect(await service.sweep()).toBe(0);
    expect(proof).toHaveBeenCalledTimes(1);
    elapsed = 30_000;
    await observe(); // A scan's negative proof cannot delay newly detected work.
    expect(proof).toHaveBeenCalledTimes(2);
    for (let read = 0; read < 3; read++) await observe();
    expect(proof).toHaveBeenCalledTimes(2);
    elapsed = 60_001;
    expect(await service.sweep()).toBe(0);
    expect(proof).toHaveBeenCalledTimes(3);
    await observe();
    expect(proof).toHaveBeenCalledTimes(3);
    elapsed = 90_001;
    await observe();
    expect(proof).toHaveBeenCalledTimes(4);
    journal.putThread({ ...original, updatedAt: original.updatedAt + 1 });
    await observe();
    expect(proof).toHaveBeenCalledTimes(5);
    expect(harness.core.threads.require(f.threadId).archived).toBe(false);
  } finally { proof.mockRestore(); clock.mockRestore(); }
});

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

test('unmerged worktree threads share repository reads and check again once a minute', async () => {
  const f = await fixture();
  const journal = harness.core.journal;
  const original = harness.core.threads.require(f.threadId);
  const ids = [f.threadId];
  for (let index = 1; index < 4; index++) {
    const checkout = join(harness.dataDir, `worktree-${index}`);
    git(f.repo, 'worktree', 'add', '-q', '-b', `topic-${index}`, checkout);
    journal.putThread({ ...original, id: `unmerged-${index}`, cwd: checkout, branch: `topic-${index}` });
    ids.push(`unmerged-${index}`);
  }
  const open = ['topic', 'topic-1', 'topic-2', 'topic-3'].map((branch, index) => ({ ...f.candidates[0]!, number: 10 + index, url: `https://github.com/example/repo/pull/${10 + index}`, state: 'OPEN', headRefName: branch }));
  f.setCandidates(open);
  const proved = spyOn(harness.core.pullRequests, 'proveMerged');
  const now = Date.now.bind(Date);
  let elapsed = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
  const passes: { proofs: number; spawned: string[] }[] = [];
  const sweep = async (expected = 0) => {
    const proofs = proved.mock.calls.length, spawned = f.spawned().length;
    expect(await service.sweep()).toBe(expected);
    passes.push({ proofs: proved.mock.calls.length - proofs, spawned: f.spawned().slice(spawned) });
    return passes.at(-1)!;
  };
  try {
    // Four open pull requests: one remote read and one list for the repository, no status walk.
    expect(await sweep()).toEqual({ proofs: 4, spawned: ['git remote', 'gh api'] });
    expect(await sweep()).toEqual({ proofs: 0, spawned: [] });
    expect(await sweep()).toEqual({ proofs: 0, spawned: [] });
    // An updated thread is proved again at once, from what the repository reads kept.
    journal.putThread({ ...journal.getThread(ids[1]!)!, updatedAt: original.updatedAt + 1 });
    const updated = await sweep();
    expect(updated.proofs).toBe(1);
    expect(updated.spawned).not.toContain('git status');
    // Each minute asks again, sharing the cached remotes and one fresh repository list.
    elapsed = 60_001;
    expect(await sweep()).toEqual({ proofs: 4, spawned: ['gh api'] });
    elapsed += 30_000;
    expect((await sweep()).proofs).toBe(0);
    elapsed += 30_001;
    expect((await sweep()).proofs).toBe(4);
    // A merge is found once the thread changes, and only that checkout's status is walked.
    f.setCandidates([{ ...open[0]!, state: 'MERGED' }, ...open.slice(1)]);
    journal.putThread({ ...journal.getThread(f.threadId)!, updatedAt: original.updatedAt + 2 });
    elapsed += 15_001;
    const merged = await sweep(1);
    expect(merged.proofs).toBe(1);
    expect(merged.spawned.filter(command => command === 'git status')).toHaveLength(2);
    expect(merged.spawned.filter(command => command === 'gh api')).toHaveLength(1);
    console.log('archive-spawn-measurement', JSON.stringify({ threads: 4, passes }));
  } finally { proved.mockRestore(); clock.mockRestore(); }
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
  const now = Date.now.bind(Date);
  let elapsed = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
  try {
    expect(await service.sweep()).toBe(0);
    expect(proved).toEqual(ids.slice(0, 8));
    // A replaced row receives a new rowid outside the current cycle boundary.
    journal.putThread({ ...original, id: ids[0]!, branch: ids[0]!, cwd: join(f.checkout, ids[0]!) });
    for (let index = 0; index < 32; index++) journal.putThread({ ...original, id: `append-${index}`, archived: true });
    expect(await service.sweep()).toBe(0);
    expect(proved.slice(8)).toEqual([ids[8]!]);
    for (let index = 32; index < 64; index++) journal.putThread({ ...original, id: `append-${index}`, archived: true });
    // Threads proved unmerged wait five minutes before the next proof.
    elapsed = 5 * 60_000 + 1;
    const secondCycle = proved.length;
    expect(await service.sweep()).toBe(0);
    expect(proved.slice(secondCycle)).toHaveLength(8);
    for (let index = 64; index < 96; index++) journal.putThread({ ...original, id: `append-${index}`, archived: true });
    expect(await service.sweep()).toBe(0);
    expect(proved.slice(secondCycle)).toContain(ids[0]!);
  } finally { proof.mockRestore(); clock.mockRestore(); }
});

test('a PR merging outside Boite is archived on the next minute without a thread mutation', async () => {
  const f = await fixture();
  f.setCandidates([{ ...f.candidates[0]!, state: 'OPEN' }]);
  expect(await service.sweep()).toBe(0);
  f.setCandidates([{ ...f.candidates[0]!, state: 'MERGED' }]);
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now + 61_000);
  try { expect(await service.sweep()).toBe(1); }
  finally { clock.mockRestore(); }
});

test.each(['unread', 'viewed'] as const)('a merged PR puts its %s conversation in Done without manual acknowledgement', async state => {
  const f = await fixture();
  if (state === 'unread') {
    harness.core.journal.putThread({ ...harness.core.threads.require(f.threadId), unread: true });
  } else {
    await f.client.call('threads.focus', { threadId: f.threadId, protectedThreadIds: [] });
  }
  expect(await service.sweep()).toBe(1);
  const saved = await f.client.call('threads.get', { threadId: f.threadId });
  expect(saved).toMatchObject({ archived: true, unread: state === 'unread', archiveReason: { type: 'pr-merged', number: 7 } });
  expect(saved.doneAt).toBeTypeOf('number');
  expect(existsSync(join(f.checkout, '.git'))).toBe(true);
});

test('a delivered merged family reaches Done with unread history and a viewed child', async () => {
  const f = await completedFamily();
  for (const thread of [harness.core.threads.require(f.threadId), ...f.children]) {
    harness.core.journal.putThread({ ...thread, unread: true });
  }
  const child = harness.core.threads.require(f.children[0]!.id);
  const history = harness.core.journal.listTurns(child.id);
  await f.client.call('threads.focus', { threadId: child.id, protectedThreadIds: [] });
  expect(await service.sweep()).toBe(1);
  expect(harness.core.threads.require(f.threadId)).toMatchObject({ archived: true, unread: true, doneAt: expect.any(Number) });
  expect(harness.core.threads.require(child.id)).toEqual(child);
  expect(harness.core.journal.listTurns(child.id)).toEqual(history);
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
    expect((await rejection(f.client.call('turns.start', { threadId: childId, prompt: 'Late child work' }))).reason).toMatchObject({ rpc: { code: RpcErrorCode.Refused } });
    expect((await rejection(f.client.call('threads.btw', { threadId: childId, question: 'Late child question', requestId: 'side_archived_child' }))).reason).toMatchObject({ rpc: { code: RpcErrorCode.Refused } });
    expect(await thrown(stale.call('delegation.send', { threadId: childId, toThreadId: f.threadId, text: 'Late result', requestId: 'late-family-result' }))).toThrow();
    harness.core.threads.deferred.wake(childId, 'Late background wake');
    expect(harness.core.journal.listTurns(childId)).toEqual(history);
    await f.client.call('threads.archive', { threadId: f.threadId, archived: false });
    expect(await service.sweep()).toBe(0);
    const resumed = await f.client.call('turns.start', { threadId: childId, prompt: 'Explicit work after restore' });
    await waitFor(() => harness.core.journal.getTurn(resumed.id)?.status === 'done');
  } finally { stale.close(); }
});

test('retained child activity, protected input and undelivered family results prevent archive', async () => {
  const f = await completedFamily();
  const child = harness.core.threads.require(f.children[0]!.id);
  for (const patch of [{ status: 'running' as const }, { pinned: true }, { agentSessionId: 'retained-session' }]) {
    harness.core.journal.putThread({ ...child, ...patch });
    expect(await service.sweep()).toBe(0);
  }
  harness.core.journal.putThread(child);
  const childProcess = harness.core.procs.spawn(child.id, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.checkout });
  try { expect(await service.sweep()).toBe(0); }
  finally { harness.core.procs.killTree(child.id); await childProcess.exited; }
  await f.client.call('threads.focus', { threadId: null, protectedThreadIds: [child.id] });
  expect(await service.sweep()).toBe(0);
  await f.client.call('threads.focus', { threadId: child.id, protectedThreadIds: [child.id] });
  expect(await service.sweep()).toBe(0);
  await f.client.call('threads.focus', { threadId: null, protectedThreadIds: [] });
  harness.core.journal.db.query("UPDATE workflow_runs SET data = json_set(data, '$.delivered', 0) WHERE id = ?").run(f.runId);
  expect(await service.sweep()).toBe(0);
  harness.core.journal.db.query("UPDATE workflow_runs SET data = json_set(data, '$.delivered', 1) WHERE id = ?").run(f.runId);
  const letter = harness.core.delegation.get(f.threadId).messages.find(letter => letter.origin === 'result')!;
  harness.core.journal.db.query("UPDATE delegation_messages SET status = 'uncertain' WHERE id = ?").run(letter.id);
  expect(await service.sweep()).toBe(0);
  harness.core.journal.db.query("UPDATE delegation_messages SET status = 'delivered' WHERE id = ?").run(letter.id);
  // An unread archived child's history survives its parent's move to Done.
  harness.core.journal.putThread({ ...child, archived: true, unread: true });
  expect(await service.sweep()).toBe(1);
  expect(harness.core.threads.require(child.id).unread).toBe(true);
});

test('pending and retained side answers on a root or retained descendant keep the merged family visible', async () => {
  const f = await completedFamily();
  const child = f.children[0]!;
  // Its finished step was put away as done; the user reopened it.
  await f.client.call('threads.archive', { threadId: child.id, archived: false });
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
  // Its finished step was put away as done; the user reopened it.
  await f.client.call('threads.archive', { threadId: childId, archived: false });
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

test('repository identities normalize slashes around the git suffix', () => {
  for (const remote of ['https://github.com/example/repo.git/', 'git@github.com:example/repo.git//', 'https://github.com/example/repo/.git', 'https://github.com/example/repo/.git/', 'https://github.com/example/repo']) {
    const remotes = `origin ${remote} (fetch)`;
    expect(githubRepository(remotes)).toBe('github.com/example/repo');
    expect([...fetchedRepositories(remotes)]).toEqual(['github.com/example/repo']);
  }
});

test('strict action proof rejects forks, reused branch, wrong tip and repository ambiguity', () => {
  const expected = { repository: 'github.com/example/repo', checkoutRepository: '/repo/.git', branch: 'topic', sha: 'a'.repeat(40) };
  const pr = { number: 7, url: 'https://github.com/example/repo/pull/7', state: 'MERGED', headRefName: 'topic', headRefOid: expected.sha, headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'example' }, isCrossRepository: false, mergedAt: '2026-10-01T12:00:00Z' };
  expect(parseMergedPrProof(JSON.stringify([pr]), expected)?.number).toBe(7);
  for (const candidate of [[pr, pr], [{ ...pr, isCrossRepository: true }], [{ ...pr, headRefOid: 'b'.repeat(40) }], [{ ...pr, headRefName: 'other' }], [{ ...pr, headRepositoryOwner: { login: 'fork' } }], [{ ...pr, mergedAt: null }], [{ ...pr, url: `${pr.url}?token=unsafe` }]]) expect(parseMergedPrProof(JSON.stringify(candidate), expected)).toBeNull();
  // A linked PR names itself; its head may differ from the checkout's branch, but never its tip or repository.
  expect(parseMergedPrProof(JSON.stringify([{ ...pr, headRefName: 'other' }]), expected, true)?.number).toBe(7);
  for (const candidate of [{ ...pr, headRefOid: 'b'.repeat(40) }, { ...pr, isCrossRepository: true }, { ...pr, headRepositoryOwner: { login: 'fork' } }, { ...pr, state: 'OPEN' }]) expect(parseMergedPrProof(JSON.stringify([candidate]), expected, true)).toBeNull();
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
    // The shared remote read, then the shared pull request list have each registered cancellation.
    await waitFor(() => subscriptions.mock.calls.length >= 2);
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
    // Windows exit tracing can settle after the archive loop closes.
    await waitFor(() => harness.core.procs.liveCount(scopes[0]!) === 0);
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
  expect((await rejection(secondOwner.call('threads.focus', { threadId: null, protectedThreadIds: Array.from({ length: 257 }, (_, index) => `id-${index}`) }))).reason).toMatchObject({ rpc: { code: RpcErrorCode.InvalidParams, data: { field: 'protectedThreadIds' } } });
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
  expect(archived.doneAt).toBeTypeOf('number');
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

test('a worktree branch renamed by its agent archives through its own merged PR', async () => {
  const f = await fixture();
  // The agent left the starting branch for one named after its fix, then opened the PR from it.
  git(f.checkout, 'checkout', '-q', '-b', 'fix/topic');
  f.setCandidates([{ ...f.candidates[0]!, headRefName: 'fix/topic' }]);
  expect(await service.sweep()).toBe(1);
  expect(harness.core.threads.require(f.threadId).archived).toBe(true);
  expect(archiveState(harness.core.journal, f.threadId).binding).toMatchObject({ branch: 'fix/topic', sha: f.sha, number: 7 });
});

test('a linked PR pushed under another branch name archives the conversation', async () => {
  const f = await fixture();
  // A repository discovery page cannot disprove an explicit URL, even when it is not full.
  f.hideList();
  const pushed = { ...f.candidates[0]!, headRefName: 'fix/elsewhere' };
  f.setCandidates([pushed]);
  // `git push origin HEAD:fix/elsewhere` leaves no local branch of that name to look up.
  expect(await service.sweep()).toBe(0);
  const link = { url: pushed.url, repository: 'example/repo', number: 7, title: 'Fix', state: 'OPEN', draft: false, head: 'fix/elsewhere', base: 'main', headRepository: 'example/repo', checkedAt: 1 };
  // The newest link no longer resolves; the older one still proves the merge.
  harness.core.journal.setSetting(`linked-pull-requests:${f.threadId}`, [link, { ...link, url: 'https://github.com/example/repo/pull/6', number: 6 }]);
  expect(await service.sweep()).toBe(1);
  expect(archiveState(harness.core.journal, f.threadId).reason).toMatchObject({ type: 'pr-merged', number: 7, url: pushed.url });
});

test('busy, protected input, paused workflow, child and stale opt-out or restore leave the root visible', async () => {
  const f = await fixture();
  const original = harness.core.threads.require(f.threadId);
  for (const patch of [{ status: 'waiting' as const }, { pinned: true }]) {
    harness.core.journal.putThread({ ...original, ...patch }); expect(await service.sweep()).toBe(0);
  }
  harness.core.journal.putThread(original);
  harness.core.threads.focus.set('fixture-viewer', f.threadId, [f.threadId], false);
  expect(await service.sweep()).toBe(0);
  harness.core.threads.focus.set('fixture-viewer', null, []);
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


test('the merged PR filter reveals automatic hides, preserves manual archives and can hide again', async () => {
  const f = await fixture();
  const original = harness.core.threads.require(f.threadId);
  harness.core.journal.putThread({ ...original, id: 'manually-archived', branch: 'manual', archived: true });
  expect(await service.sweep()).toBe(1);
  expect(harness.core.threads.require(f.threadId).archived).toBe(true);
  const project = await f.client.call('projects.setAutoArchiveMergedPr', { projectId: f.project.id, enabled: false });
  expect(project.autoArchiveMergedPr).toBe(false);
  expect(harness.core.threads.require(f.threadId).archived).toBe(false);
  expect(harness.core.threads.require(f.threadId).doneAt).toBeUndefined();
  expect(harness.core.threads.require('manually-archived').archived).toBe(true);
  expect(archiveState(harness.core.journal, f.threadId).dismissed ?? []).toEqual([]);
  expect(await service.sweep()).toBe(0);
  await f.client.call('projects.setAutoArchiveMergedPr', { projectId: f.project.id, enabled: true });
  expect(await service.sweep()).toBe(1);
  expect(harness.core.threads.require(f.threadId).archived).toBe(true);
  // An explicit archive of an automatically hidden thread becomes a manual archive.
  await f.client.call('threads.archive', { threadId: f.threadId, archived: true });
  await f.client.call('projects.setAutoArchiveMergedPr', { projectId: f.project.id, enabled: false });
  expect(harness.core.threads.require(f.threadId).archived).toBe(true);
  f.client.close();
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
  expect(await thrown(f.client.call('projects.setAutoArchiveMergedPr', { projectId: f.project.id, enabled: 'yes' as never }))).toThrow('boolean');
  expect(await service.sweep()).toBe(0);
});

test('foreign fork must not block the local merged PR', async () => {
  const f = await fixture();
  f.setCandidates([f.candidates[0]!, {...f.candidates[0]!, number: 8, url: 'https://github.com/example/repo/pull/8', state: 'OPEN', isCrossRepository: true, headRepositoryOwner: {login: 'foreigner'}}]);
  expect(await service.sweep()).toBe(1);
});

test('an old linked merge must not archive a newer open PR', async () => {
  const f = await fixture();
  const opened = {...f.candidates[0]!, number: 8, url: 'https://github.com/example/repo/pull/8', state: 'OPEN'};
  f.setCandidates([opened, f.candidates[0]!]);
  const link = {url: f.candidates[0]!.url, repository: 'example/repo', number: 7, title: 'Old', state: 'MERGED', draft: false, head: 'topic', base: 'main', headRepository: 'example/repo', checkedAt: 1};
  harness.core.journal.setSetting(`linked-pull-requests:${f.threadId}`, [link, {...link, number: 8, url: opened.url, state: 'OPEN'}]);
  expect(await service.sweep()).toBe(0);
});


test('a new automatic open PR blocks an older linked merge on the same checkout', async () => {
  const f = await fixture();
  const merged = f.candidates[0]!;
  f.setCandidates([{ ...merged, number: 8, url: 'https://github.com/example/repo/pull/8', state: 'OPEN' }, merged]);
  harness.core.journal.setSetting(`linked-pull-requests:${f.threadId}`, [{ url: merged.url }]);
  expect(await service.sweep()).toBe(0);
});


test('an unreadable linked PR keeps the conversation visible despite another merged link', async () => {
  const f = await fixture();
  const unknown = 'https://github.com/example/repo/pull/8';
  f.failView(unknown);
  harness.core.journal.setSetting(`linked-pull-requests:${f.threadId}`, [{ url: f.candidates[0]!.url }, { url: unknown }]);
  expect(await service.sweep()).toBe(0);
});
