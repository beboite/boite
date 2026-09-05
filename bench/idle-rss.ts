/**
 * Idle working set of the core against a bare Bun process, on the same machine
 * and in the same second. What the core carries above bare Bun is the number
 * that matters: everything a fresh core loads before a thread ever runs. The
 * three ways to run it are measured side by side, because the gap between the
 * sources and the bundle is what `bun run build` buys.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SETTLE_MS = 4_500;
const BARE_SLEEP_MS = 9_000;
const RUNS = 3;
const CORE_DIR = join(import.meta.dir, '..', 'packages', 'core');
const DIST = join(CORE_DIR, 'dist');
const BUNDLE = join(DIST, 'main.js');
const EXE = join(DIST, 'boite-core.exe');
const MB = 1024 * 1024;

interface Subject {
  label: string;
  cmd: string[];
  missing: string | null;
}

function subjects(): Subject[] {
  return [
    { label: 'bare bun', cmd: [process.execPath, '-e', `await Bun.sleep(${BARE_SLEEP_MS})`], missing: null },
    { label: 'core from sources', cmd: [process.execPath, 'run', join(CORE_DIR, 'src', 'main.ts')], missing: null },
    {
      label: 'core from dist/main.js',
      cmd: [process.execPath, 'run', BUNDLE],
      missing: existsSync(BUNDLE) ? null : 'bun run build:core',
    },
    {
      label: 'core as dist/boite-core.exe',
      cmd: [EXE],
      missing: existsSync(EXE) ? null : 'bun run build:core:exe',
    },
  ];
}

function workingSets(pids: number[]): Map<number, number> {
  const list = pids.join(',');
  const script = `Get-Process -Id ${list} | ForEach-Object { "$($_.Id) $($_.WorkingSet64)" }`;
  const read = Bun.spawnSync({
    cmd: ['powershell', '-NoProfile', '-Command', script],
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const sets = new Map<number, number>();
  for (const line of read.stdout.toString().split('\n')) {
    const [pid, bytes] = line.trim().split(' ');
    if (pid === undefined || bytes === undefined) continue;
    const id = Number(pid);
    const size = Number(bytes);
    if (Number.isFinite(id) && Number.isFinite(size)) sets.set(id, size);
  }
  return sets;
}

function megabytes(bytes: number | undefined): string {
  return bytes === undefined ? 'unread' : `${(bytes / MB).toFixed(1)} MB`;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function oneRun(live: Subject[]): Promise<Map<string, number>> {
  const dataDirs: string[] = [];
  const started = live.map((subject) => {
    const isCore = subject.label !== 'bare bun';
    const dataDir = isCore ? mkdtempSync(join(tmpdir(), 'boite-idle-')) : '';
    if (isCore) dataDirs.push(dataDir);
    const proc = Bun.spawn({
      cmd: isCore ? [...subject.cmd, '--port', '0'] : subject.cmd,
      env: isCore ? { ...process.env, BOITE_DATA_DIR: dataDir } : { ...process.env },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    });
    return { subject, proc };
  });

  try {
    await Bun.sleep(SETTLE_MS);
    const sets = workingSets(started.map((entry) => entry.proc.pid));
    const measured = new Map<string, number>();
    for (const entry of started) {
      const bytes = sets.get(entry.proc.pid);
      if (bytes !== undefined) measured.set(entry.subject.label, bytes);
    }
    return measured;
  } finally {
    for (const entry of started) entry.proc.kill();
    await Promise.all(started.map((entry) => entry.proc.exited));
    for (const dataDir of dataDirs) rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const all = subjects();
  const live = all.filter((subject) => subject.missing === null);
  const reads = new Map<string, number[]>();

  for (let run = 0; run < RUNS; run += 1) {
    const measured = await oneRun(live);
    const line = live
      .map((subject) => `${subject.label} ${megabytes(measured.get(subject.label))}`)
      .join(', ');
    process.stdout.write(`run ${run + 1}: ${line}\n`);
    for (const [label, bytes] of measured) {
      const seen = reads.get(label) ?? [];
      seen.push(bytes);
      reads.set(label, seen);
    }
  }

  process.stdout.write(`\nmedian of ${RUNS} runs\n`);
  const bare = median(reads.get('bare bun') ?? []);
  for (const subject of all) {
    if (subject.missing !== null) {
      process.stdout.write(`${subject.label.padEnd(28)} not built, run ${subject.missing}\n`);
      continue;
    }
    const value = median(reads.get(subject.label) ?? []);
    const above =
      value === undefined || bare === undefined || subject.label === 'bare bun'
        ? ''
        : `  (+${((value - bare) / MB).toFixed(1)} MB)`;
    process.stdout.write(`${subject.label.padEnd(28)} ${megabytes(value)}${above}\n`);
  }
}

await main();
