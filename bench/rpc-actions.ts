/**
 * Times every RPC the UI makes on boot and on a thread, plus the common
 * writes, against a core running as a child process.
 *
 *   bun bench/rpc-actions.ts [--journal <journal.db>] [--runs 8] [--out <file.json>]
 *
 * `--journal` copies a journal into a fresh data directory first, so the core
 * reads realistic history; the copy is deleted afterwards. Without it the core
 * starts empty. The copy is taken with `VACUUM INTO`, which is consistent on a
 * journal a running core still writes, and then cut off from the machine:
 * projects, thread folders and account directories point into the temporary
 * directory, paired sessions go, and the push, coordination, brain, telemetry,
 * collaboration and quota settings are deleted. The original is only read.
 *
 * Linux only: core CPU and memory come from /proc. CPU has 10 ms resolution,
 * so each row reports the total over its runs divided by the run count.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { RpcMethodName, RpcMethods } from '../packages/contracts/src/index.ts';
import { connect, type CoreClient } from '../packages/core/src/client.ts';
import { startCore } from '../tests/e2e/lib/core.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const journal = flag('--journal');
const runs = Number(flag('--runs') ?? 8);
const out = flag('--out');
if (process.platform !== 'linux') throw new Error('rpc-actions reads /proc: Linux only');

const TICK_MS = 1000 / 100;

function cpuMs(pid: number): number {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
  return (Number(fields[11]) + Number(fields[12])) * TICK_MS;
}

function memory(pid: number): { rssMiB: number; peakMiB: number } {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (key: string): number => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(status)?.[1] ?? 0);
  return { rssMiB: kb('VmRSS') / 1024, peakMiB: kb('VmHWM') / 1024 };
}

const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

interface Row {
  action: string;
  runs: number;
  medianMs: number;
  p95Ms: number;
  coreCpuMsPerCall: number;
  responseKiB: number;
  rssAfterMiB: number;
  error?: string;
}

const rows: Row[] = [];
let pid = 0;

async function time(action: string, call: () => Promise<unknown>, count = runs): Promise<unknown> {
  const samples: number[] = [];
  let bytes = 0;
  let last: unknown;
  const cpu = cpuMs(pid);
  try {
    for (let index = 0; index < count; index += 1) {
      const started = performance.now();
      last = await call();
      samples.push(performance.now() - started);
      bytes = JSON.stringify(last ?? null).length;
    }
  } catch (error) {
    rows.push({ action, runs: samples.length, medianMs: NaN, p95Ms: NaN, coreCpuMsPerCall: NaN, responseKiB: NaN, rssAfterMiB: memory(pid).rssMiB, error: String(error).slice(0, 160) });
    process.stdout.write(`${action.padEnd(44)} error ${String(error).slice(0, 120)}\n`);
    return null;
  }
  const row: Row = {
    action,
    runs: samples.length,
    medianMs: quantile(samples, 0.5),
    p95Ms: quantile(samples, 0.95),
    coreCpuMsPerCall: (cpuMs(pid) - cpu) / samples.length,
    responseKiB: bytes / 1024,
    rssAfterMiB: memory(pid).rssMiB,
  };
  rows.push(row);
  process.stdout.write(
    `${action.padEnd(44)} med ${row.medianMs.toFixed(1).padStart(8)} ms  p95 ${row.p95Ms.toFixed(1).padStart(8)} ms  cpu ${row.coreCpuMsPerCall.toFixed(1).padStart(7)} ms  ${row.responseKiB.toFixed(1).padStart(9)} KiB  rss ${row.rssAfterMiB.toFixed(0)} MiB\n`,
  );
  return last;
}

const call = <M extends RpcMethodName>(client: CoreClient, method: M, params: RpcMethods[M]['params']) =>
  () => client.call(method, params);

const dataDir = mkdtempSync(join(tmpdir(), 'boite-bench-rpc-'));
let heavy: { threadId: string; mib: number }[] = [];
if (journal !== undefined) {
  const started = performance.now();
  const copy = join(dataDir, 'journal.db');
  const source = new Database(journal, { readonly: true });
  source.query('VACUUM INTO ?').run(copy);
  source.close();
  const db = new Database(copy);
  for (const { id } of db.query('SELECT id FROM projects').all() as { id: string }[]) {
    const folder = join(dataDir, 'projects', id);
    mkdirSync(folder, { recursive: true });
    db.query('UPDATE projects SET path = ? WHERE id = ?').run(folder, id);
    db.query('UPDATE threads SET cwd = ? WHERE project_id = ?').run(folder, id);
  }
  db.query("UPDATE accounts SET isolation_dir = ? || '/accounts/' || id").run(dataDir);
  db.exec('DELETE FROM sessions');
  db.exec(`DELETE FROM settings WHERE key LIKE 'push%' OR key LIKE 'coordination%' OR key LIKE 'brain%'
    OR key LIKE 'telemetry%' OR key LIKE 'collaboration%' OR key LIKE 'quota%'`);
  heavy = db
    .query(`SELECT m.thread_id AS threadId, SUM(LENGTH(m.parts)) / 1048576.0 AS mib FROM messages m
            JOIN threads t ON t.id = m.thread_id WHERE t.archived = 0 GROUP BY m.thread_id ORDER BY mib DESC LIMIT 3`)
    .all() as { threadId: string; mib: number }[];
  db.close();
  process.stdout.write(`copied and isolated the journal in ${(performance.now() - started).toFixed(0)} ms\n`);
}

const spawned = performance.now();
const core = await startCore({ dataDir });
const readyMs = performance.now() - spawned;
const client = await connect(core.url, core.token, { client: { name: 'bench', version: '0' } });
pid = client.core.pid;
const startup = { readyMs, cpuMs: cpuMs(pid), ...memory(pid) };
process.stdout.write(`core ready in ${readyMs.toFixed(0)} ms, ${startup.cpuMs} ms CPU, rss ${startup.rssMiB.toFixed(0)} MiB, peak ${startup.peakMiB.toFixed(0)} MiB\n`);

try {
  // What a UI sends on boot, all at once, then each call alone.
  const boot = (): Promise<unknown[]> =>
    Promise.all([
      client.call('settings.get', {}),
      client.call('keybindings.get', {}),
      client.call('projects.list', {}),
      client.call('threads.list', {}),
      client.call('accounts.list', {}),
      client.call('accounts.logins', {}),
      client.call('providers.list', {}),
      client.call('permissions.list', {}),
      client.call('questions.list', {}),
      client.call('scheduler.get', {}),
    ]);
  await time('boot burst (10 calls together)', boot);
  for (const method of ['settings.get', 'keybindings.get', 'projects.list', 'accounts.list', 'accounts.logins', 'providers.list', 'permissions.list', 'questions.list', 'scheduler.get', 'resources.list', 'threads.deleted', 'sessions.list', 'plugins.list', 'brain.status', 'hooks.status', 'speech.status', 'telemetry.state', 'usage.get'] as const) {
    await time(method, call(client, method, {} as never));
  }
  await time('threads.list', call(client, 'threads.list', {}));
  await time('threads.list includeArchived', call(client, 'threads.list', { includeArchived: true }));
  const day = 86_400_000;
  const now = Date.now();
  await time('usage.history 30 days', call(client, 'usage.history', { edges: Array.from({ length: 31 }, (_, i) => now - (30 - i) * day) }));
  await time('usage.history 365 days', call(client, 'usage.history', { edges: Array.from({ length: 366 }, (_, i) => now - (365 - i) * day) }));
  await time('agents.snapshot', call(client, 'agents.snapshot', {}));

  // A fresh project and echo thread, so the thread rows exist with an empty core too.
  // Inside the data directory, which the core's stop removes with everything else.
  const folder = join(dataDir, 'projects', 'bench');
  mkdirSync(folder, { recursive: true });
  const project = await client.call('projects.add', { path: folder, name: 'bench' });
  const echo = (await client.call('accounts.list', {})).find((account) => account.providerId === 'echo');
  if (echo === undefined) throw new Error('no echo account');
  const thread = await time('threads.create', () => client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: echo.id, title: 'bench' }), 1) as { id: string };
  const finished = (threadId: string): Promise<void> =>
    new Promise((resolve) => {
      const off = client.on('turn.finished', (event) => {
        if (event.threadId === threadId) {
          off();
          resolve();
        }
      });
    });
  await client.call('threads.subscribe', { threadId: thread.id });
  await time('echo turn round trip', async () => {
    const done = finished(thread.id);
    await client.call('turns.start', { threadId: thread.id, prompt: 'hello '.repeat(200) });
    await done;
  });

  const targets = [{ threadId: thread.id, mib: 0, label: 'echo thread' }, ...heavy.map((entry, index) => ({ ...entry, label: `heavy #${index + 1} (${entry.mib.toFixed(0)} MiB)` }))];
  for (const target of targets) {
    // What the chat asks for when it opens a thread, then the full page `reload` and an agent's view ask for.
    const light = { compactTools: true, compactFiles: true, compactImages: true } as const;
    const shown = await time(`threads.get open ${target.label}`, call(client, 'threads.get', { threadId: target.threadId, limit: 40, ...light })) as { messages: { id: string }[]; messagesBefore?: string | null } | null;
    if (shown?.messagesBefore) await time(`messages.list open ${target.label}`, call(client, 'messages.list', { threadId: target.threadId, before: shown.messagesBefore, limit: 40, ...light }));
    const opened = await time(`threads.get full ${target.label}`, call(client, 'threads.get', { threadId: target.threadId })) as { messages: { id: string }[]; messagesBefore?: string | null } | null;
    if (opened === null) continue;
    const last = opened.messages.at(-1)?.id;
    if (last !== undefined) await time(`threads.get after ${target.label}`, call(client, 'threads.get', { threadId: target.threadId, after: last }));
    const before = opened.messages[0]?.id;
    if (before !== undefined && opened.messagesBefore != null) await time(`messages.list full ${target.label}`, call(client, 'messages.list', { threadId: target.threadId, before, limit: 40 }));
    await time(`trace.get ${target.label}`, call(client, 'trace.get', { threadId: target.threadId }));
    await time(`usage.get ${target.label}`, call(client, 'usage.get', { threadId: target.threadId }));
    await time(`todos.list ${target.label}`, call(client, 'todos.list', { threadId: target.threadId }));
    await time(`delegation.get ${target.label}`, call(client, 'delegation.get', { threadId: target.threadId }));
    await time(`collaboration.get ${target.label}`, call(client, 'collaboration.get', { threadId: target.threadId }));
    await time(`files.list ${target.label}`, call(client, 'files.list', { threadId: target.threadId }));
    await time(`threads.markRead ${target.label}`, call(client, 'threads.markRead', { threadId: target.threadId }));
    await time(`threads.pin ${target.label}`, async () => {
      await client.call('threads.pin', { threadId: target.threadId, pinned: true });
      return client.call('threads.pin', { threadId: target.threadId, pinned: false });
    });
    await time(`threads.retitle ${target.label}`, call(client, 'threads.retitle', { threadId: target.threadId }), 2);
    const middle = opened.messages[Math.floor(opened.messages.length / 2)]?.id;
    if (middle !== undefined) await time(`threads.fork ${target.label}`, call(client, 'threads.fork', { threadId: target.threadId, messageId: middle }), 1);
    await time(`threads.archive+restore ${target.label}`, async () => {
      await client.call('threads.archive', { threadId: target.threadId, archived: true });
      return client.call('threads.archive', { threadId: target.threadId, archived: false });
    }, 2);
  }
  await time('settings.set', call(client, 'settings.set', { asyncQuestions: false }));

  // Idle after the work above.
  const idleCpu = cpuMs(pid);
  await Bun.sleep(10_000);
  const idle = { cpuMsPer10s: cpuMs(pid) - idleCpu, ...memory(pid) };
  process.stdout.write(`idle 10 s after load: ${idle.cpuMsPer10s} ms CPU, rss ${idle.rssMiB.toFixed(0)} MiB, peak ${idle.peakMiB.toFixed(0)} MiB\n`);
  const report = { date: new Date().toISOString(), journal: journal ?? null, bun: Bun.version, runs, startup, idle, rows };
  if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 2));
} finally {
  client.close();
  await core.stop();
}
