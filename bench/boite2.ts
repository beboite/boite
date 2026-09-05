import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, ThreadSummary } from '../packages/contracts/src/index.ts';
import { connect, type CoreClient } from '../packages/core/src/client.ts';
import {
  CORE_SOURCE_COMMAND,
  freshDataDir,
  killProcessTree,
  removeDirectory,
  startCore,
  type RunningCore,
} from '../tests/e2e/lib/core.ts';
import {
  cadenceMs,
  peakOf,
  peakOfName,
  RssSampler,
  snapshot,
  sumByName,
  tree,
  workingSet,
} from './lib/proc.ts';

const CLIENT = { name: 'bench', version: '2.0.0-alpha.1' };
const ROOT = join(import.meta.dir, '..');
const SHELL_EXE = join(ROOT, 'apps', 'shell', 'src-tauri', 'target', 'release', 'boite-shell.exe');
const CORE_BUNDLE = join(ROOT, 'packages', 'core', 'dist', 'main.js');
const CORE_EXE = join(ROOT, 'packages', 'core', 'dist', 'boite-core.exe');
const HEALTH_TIMEOUT_MS = 30_000;

/** What the core rows measure: the build when there is one, the sources otherwise. */
export const CORE_COMMAND: readonly string[] = existsSync(CORE_BUNDLE)
  ? ['bun', 'run', CORE_BUNDLE]
  : CORE_SOURCE_COMMAND;
export const CORE_ENTRY = existsSync(CORE_BUNDLE)
  ? 'packages/core/dist/main.js'
  : 'packages/core/src/main.ts';

export function words(count: number): string {
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) parts.push(`word${index}`);
  return parts.join(' ');
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`${url}/health never answered`);
    await Bun.sleep(5);
  }
}

export interface ColdStart {
  readyMs: number[];
  healthMs: number[];
}

export async function coreColdStart(runs = 5): Promise<ColdStart> {
  const readyMs: number[] = [];
  const healthMs: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    const core = await startCore({ command: CORE_COMMAND });
    readyMs.push(performance.now() - startedAt);
    await waitForHealth(core.url);
    healthMs.push(performance.now() - startedAt);
    await core.stop();
  }
  return { readyMs, healthMs };
}

async function openCore(
  command: readonly string[] = CORE_COMMAND,
): Promise<{ core: RunningCore; client: CoreClient; pid: number }> {
  const core = await startCore({ command });
  const client = await connect(core.url, core.token, { client: CLIENT });
  return { core, client, pid: client.core.pid };
}

async function closeCore(opened: { core: RunningCore; client: CoreClient }): Promise<void> {
  opened.client.close();
  await opened.core.stop();
}

export async function coreIdleRss(): Promise<number> {
  const opened = await openCore();
  await Bun.sleep(3_000);
  const bytes = workingSet(opened.pid);
  await closeCore(opened);
  return bytes;
}

/** The same measurement on `bun build --compile` output, which carries its own runtime. */
export async function compiledCoreIdleRss(): Promise<number | null> {
  if (!existsSync(CORE_EXE)) return null;
  const opened = await openCore([CORE_EXE]);
  await Bun.sleep(3_000);
  const bytes = workingSet(opened.pid);
  await closeCore(opened);
  return bytes;
}

async function echoAccount(client: CoreClient): Promise<Account> {
  const accounts = await client.call('accounts.list', {});
  const account = accounts.find((entry) => entry.providerId === 'echo');
  if (account === undefined) throw new Error('the core has no echo account');
  return account;
}

async function benchProject(client: CoreClient): Promise<{ projectId: string; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'boite-bench-project-'));
  const project = await client.call('projects.add', { path: directory, name: 'bench' });
  return { projectId: project.id, directory };
}

export interface IdleThreads {
  baseBytes: number;
  at50Bytes: number;
  at100Bytes: number;
  perThreadBytes: number;
  /** Spread of the five baseline reads, the floor under which a delta means nothing. */
  noiseBytes: number;
}

/** Five reads, median kept: one working set read jitters by more than a thread costs. */
async function settledWorkingSet(pid: number): Promise<{ value: number; spread: number }> {
  const reads: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    reads.push(workingSet(pid));
    await Bun.sleep(300);
  }
  const sorted = [...reads].sort((left, right) => left - right);
  return {
    value: sorted[Math.floor(sorted.length / 2)] as number,
    spread: (sorted[sorted.length - 1] as number) - (sorted[0] as number),
  };
}

export async function idleThreads(): Promise<IdleThreads> {
  const opened = await openCore();
  const { client, pid } = opened;
  const project = await benchProject(client);
  const account = await echoAccount(client);

  const create = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      await client.call('threads.create', {
        projectId: project.projectId,
        providerId: 'echo',
        accountId: account.id,
        title: `idle ${index}`,
      });
    }
  };

  await Bun.sleep(1_500);
  const base = await settledWorkingSet(pid);
  await create(50);
  await Bun.sleep(1_500);
  const at50 = await settledWorkingSet(pid);
  await create(50);
  await Bun.sleep(1_500);
  const at100 = await settledWorkingSet(pid);

  await closeCore(opened);
  await removeDirectory(project.directory);
  return {
    baseBytes: base.value,
    at50Bytes: at50.value,
    at100Bytes: at100.value,
    perThreadBytes: (at100.value - base.value) / 100,
    noiseBytes: base.spread,
  };
}

export interface EchoRun {
  cap: number;
  perAccountCap: number;
  threads: number;
  wallMs: number;
  firstDeltaMs: number[];
  peakBytes: number;
  queuedAtPeak: number;
  maxQueued: number;
  samples: number;
  cadenceMs: number;
}

export async function echoTurns(cap: number, threads = 50, promptWords = 300): Promise<EchoRun> {
  const opened = await openCore();
  const { client, pid } = opened;
  // Every thread here holds the one echo account, so perAccountConcurrency (2 by
  // default) binds before maxConcurrentTurns and the cap under test would do
  // nothing. Both are raised together.
  const settings = await client.call('settings.set', {
    maxConcurrentTurns: cap,
    perAccountConcurrency: cap,
  });
  const project = await benchProject(client);
  const account = await echoAccount(client);

  const created: ThreadSummary[] = [];
  for (let index = 0; index < threads; index += 1) {
    const thread = await client.call('threads.create', {
      projectId: project.projectId,
      providerId: 'echo',
      accountId: account.id,
      title: `turn ${index}`,
    });
    await client.call('threads.subscribe', { threadId: thread.id });
    created.push(thread);
  }

  const startedAt = new Map<string, number>();
  const firstDelta = new Map<string, number>();
  const queuedTimeline: { at: number; queued: number }[] = [];
  const offDelta = client.on('message.delta', (event) => {
    if (!firstDelta.has(event.threadId)) firstDelta.set(event.threadId, performance.now());
  });
  const offScheduler = client.on('scheduler.updated', (state) => {
    queuedTimeline.push({ at: Date.now(), queued: state.queued.length });
  });

  let finished = 0;
  const allDone = new Promise<void>((resolve) => {
    const offFinished = client.on('turn.finished', () => {
      finished += 1;
      if (finished >= threads) {
        offFinished();
        resolve();
      }
    });
  });

  const prompt = words(promptWords);
  const sampler = RssSampler.start(pid);
  await Bun.sleep(400);

  const wallStart = performance.now();
  const requests = created.map((thread) => {
    startedAt.set(thread.id, performance.now());
    return client.call('turns.start', { threadId: thread.id, prompt });
  });
  await Promise.all(requests);
  await allDone;
  const wallMs = performance.now() - wallStart;

  const samples = await sampler.stop();
  offDelta();
  offScheduler();

  const peak = peakOf(samples);
  let queuedAtPeak = 0;
  for (const entry of queuedTimeline) {
    if (entry.at <= peak.at) queuedAtPeak = entry.queued;
  }
  const maxQueued = queuedTimeline.reduce((most, entry) => Math.max(most, entry.queued), 0);

  const firstDeltaMs: number[] = [];
  for (const thread of created) {
    const begin = startedAt.get(thread.id);
    const seen = firstDelta.get(thread.id);
    if (begin !== undefined && seen !== undefined) firstDeltaMs.push(seen - begin);
  }

  await closeCore(opened);
  await removeDirectory(project.directory);
  return {
    cap: settings.maxConcurrentTurns,
    perAccountCap: settings.perAccountConcurrency,
    threads,
    wallMs,
    firstDeltaMs,
    peakBytes: peak.bytes,
    queuedAtPeak,
    maxQueued,
    samples: samples.length,
    cadenceMs: cadenceMs(samples),
  };
}

export interface ShellRun {
  startMs: number;
  shellBytes: number;
  webviewBytes: number;
  webviewCount: number;
  coreBytes: number;
  otherBytes: number;
  totalBytes: number;
}

export async function shellRun(): Promise<ShellRun | null> {
  if (!existsSync(SHELL_EXE)) return null;
  const dataDir = freshDataDir();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.BOITE_CORE_COMMAND;
  env.BOITE_SHELL_HIDDEN = '1';
  env.BOITE_DATA_DIR = dataDir;

  const startedAt = performance.now();
  const proc = Bun.spawn({
    cmd: [SHELL_EXE],
    env,
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  });

  const corePath = join(dataDir, 'core.json');
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let corePort = 0;
  let corePid = 0;
  for (;;) {
    try {
      const file = JSON.parse(await Bun.file(corePath).text()) as { port: number; pid: number };
      const response = await fetch(`http://127.0.0.1:${file.port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        corePort = file.port;
        corePid = file.pid;
        break;
      }
    } catch {
      /* the shell has not written core.json yet */
    }
    if (Date.now() > deadline) {
      killProcessTree(proc.pid);
      await removeDirectory(dataDir);
      throw new Error(`the shell exe did not answer /health within ${HEALTH_TIMEOUT_MS / 1000} s`);
    }
    await Bun.sleep(10);
  }
  const startMs = performance.now() - startedAt;
  if (corePort === 0) throw new Error('the shell reported no core port');

  await Bun.sleep(5_000);
  const table = snapshot();
  const members = tree(proc.pid, table);
  const shell = sumByName(members, 'boite-shell.exe');
  const webview = sumByName(members, 'msedgewebview2.exe');
  const core = members
    .filter((info) => info.pid === corePid)
    .reduce((total, info) => total + info.workingSetBytes, 0);
  const totalBytes = members.reduce((total, info) => total + info.workingSetBytes, 0);

  killProcessTree(proc.pid);
  killProcessTree(corePid);
  await removeDirectory(dataDir);

  return {
    startMs,
    shellBytes: shell.bytes,
    webviewBytes: webview.bytes,
    webviewCount: webview.count,
    coreBytes: core,
    otherBytes: totalBytes - shell.bytes - webview.bytes - core,
    totalBytes,
  };
}

export interface ClaudeRun {
  firstDeltaMs: number;
  totalMs: number;
  peakBytes: number;
  text: string;
}

export async function claudeTurn(): Promise<ClaudeRun> {
  const opened = await openCore();
  const { client } = opened;
  const project = await benchProject(client);
  const accounts = await client.call('accounts.list', {});
  const account = accounts.find((entry) => entry.providerId === 'claude');
  if (account === undefined) throw new Error('the core has no claude account');

  const thread = await client.call('threads.create', {
    projectId: project.projectId,
    providerId: 'claude',
    accountId: account.id,
    title: 'bench claude',
    permissionMode: 'bypassPermissions',
  });
  await client.call('threads.subscribe', { threadId: thread.id });

  const watched: { sampler: RssSampler | null } = { sampler: null };
  const offProcess = client.on('process.started', (record) => {
    if (watched.sampler === null && record.exe.toLowerCase().includes('claude')) {
      watched.sampler = RssSampler.start(record.pid, 200);
    }
  });

  let firstDeltaMs = 0;
  let text = '';
  const offDelta = client.on('message.delta', (event) => {
    if (firstDeltaMs === 0) firstDeltaMs = performance.now();
    text += event.text;
  });
  const finished = client.next<'turn.finished'>('turn.finished', undefined, 180_000);

  const startedAt = performance.now();
  await client.call('turns.start', { threadId: thread.id, prompt: 'Reply with exactly the word: pong' });
  await finished;
  const totalMs = performance.now() - startedAt;

  offDelta();
  offProcess();
  const samples = watched.sampler === null ? [] : await watched.sampler.stop();
  const peak = peakOfName(samples, 'claude.exe');

  await closeCore(opened);
  await removeDirectory(project.directory);
  return {
    firstDeltaMs: firstDeltaMs === 0 ? 0 : firstDeltaMs - startedAt,
    totalMs,
    peakBytes: peak.bytes > 0 ? peak.bytes : peakOf(samples).bytes,
    text: text.trim(),
  };
}
