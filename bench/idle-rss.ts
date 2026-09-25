/**
 * Idle working set of the core against a bare Bun process, on the same machine
 * and in the same second. What the core carries above bare Bun is the number
 * that matters: everything a fresh core loads before a thread ever runs. The
 * three ways to run it are measured side by side, because the gap between the
 * sources and the bundle is what `bun run build` buys.
 *
 * Two points per process: `fresh`, 4.5 s after the spawn, and `steady`, 75 s
 * after it, once the first automatic update check (60 s, providers/updates.ts)
 * has read the providers' versions, started the jobs Worker and fetched the
 * registry metadata. Each reports the working set, the private bytes and the
 * thread count. The cores inherit this environment, so the check reads the
 * providers found on this machine's PATH, as an installed core would; set
 * BOITE_HOST_AGENTS=0 to resolve none. `--fresh-only` skips the 75 s wait.
 *
 * Run: bun run bench/idle-rss.ts [--fresh-only]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FRESH_ONLY = process.argv.includes('--fresh-only');
const POINTS = FRESH_ONLY
  ? [{ name: 'fresh', atMs: 4_500 }]
  : [{ name: 'fresh', atMs: 4_500 }, { name: 'steady', atMs: 75_000 }];
const LAST_MS = POINTS[POINTS.length - 1]!.atMs;
const BARE_SLEEP_MS = LAST_MS + 10_000;
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

/** One process at one point: working set, private bytes, threads. */
interface Sample {
  ws: number;
  priv: number;
  threads: number;
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

function samples(pids: number[]): Map<number, Sample> {
  const list = pids.join(',');
  const script = `Get-Process -Id ${list} | ForEach-Object { "$($_.Id) $($_.WorkingSet64) $($_.PrivateMemorySize64) $($_.Threads.Count)" }`;
  // Windows PowerShell cannot load its modules from a PowerShell 7 module path.
  const env = { ...process.env };
  delete env.PSModulePath;
  const read = Bun.spawnSync({
    cmd: ['powershell', '-NoProfile', '-Command', script],
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const sets = new Map<number, Sample>();
  for (const line of read.stdout.toString().split('\n')) {
    const [id, ws, priv, threads] = line.trim().split(' ').map(Number);
    if ([id, ws, priv, threads].every((value) => value !== undefined && Number.isFinite(value))) {
      sets.set(id!, { ws: ws!, priv: priv!, threads: threads! });
    }
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

/** point name, then subject label, then its sample. */
type RunReads = Map<string, Map<string, Sample>>;

async function oneRun(live: Subject[]): Promise<RunReads> {
  const dataDirs: string[] = [];
  const spawnedAt = performance.now();
  const started = live.map((subject) => {
    const isCore = subject.label !== 'bare bun';
    const dataDir = isCore ? mkdtempSync(join(tmpdir(), 'boite-idle-')) : '';
    if (isCore) dataDirs.push(dataDir);
    const proc = Bun.spawn({
      cmd: isCore ? [...subject.cmd, '--port', '0'] : subject.cmd,
      env: isCore ? { ...process.env, BOITE_DATA_DIR: dataDir, BOITE_TELEMETRY_URL: '' } : { ...process.env },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    });
    return { subject, proc };
  });

  try {
    const reads: RunReads = new Map();
    for (const point of POINTS) {
      await Bun.sleep(Math.max(0, point.atMs - (performance.now() - spawnedAt)));
      const sets = samples(started.map((entry) => entry.proc.pid));
      const measured = new Map<string, Sample>();
      for (const entry of started) {
        const sample = sets.get(entry.proc.pid);
        if (sample !== undefined) measured.set(entry.subject.label, sample);
      }
      reads.set(point.name, measured);
    }
    return reads;
  } finally {
    for (const entry of started) entry.proc.kill();
    await Promise.all(started.map((entry) => entry.proc.exited));
    for (const dataDir of dataDirs) rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const all = subjects();
  const live = all.filter((subject) => subject.missing === null);
  const reads = new Map<string, Map<string, Sample[]>>();
  process.stdout.write(`BOITE_HOST_AGENTS=${process.env.BOITE_HOST_AGENTS ?? '(unset: the providers on PATH are read)'}\n`);

  for (let run = 0; run < RUNS; run += 1) {
    const measured = await oneRun(live);
    for (const [point, bySubject] of measured) {
      const line = live.map((subject) => `${subject.label} ${megabytes(bySubject.get(subject.label)?.ws)}`).join(', ');
      process.stdout.write(`run ${run + 1} ${point}: ${line}\n`);
      const pointReads = reads.get(point) ?? new Map<string, Sample[]>();
      for (const [label, sample] of bySubject) pointReads.set(label, [...(pointReads.get(label) ?? []), sample]);
      reads.set(point, pointReads);
    }
  }

  for (const point of POINTS) {
    process.stdout.write(`\n${point.name}, ${point.atMs / 1000} s after the spawn, median of ${RUNS} runs\n`);
    process.stdout.write(`${''.padEnd(28)} ${'working set'.padStart(20)} ${'private'.padStart(10)} ${'threads'.padStart(8)}\n`);
    const pointReads = reads.get(point.name) ?? new Map<string, Sample[]>();
    const bare = median((pointReads.get('bare bun') ?? []).map((sample) => sample.ws));
    for (const subject of all) {
      if (subject.missing !== null) {
        process.stdout.write(`${subject.label.padEnd(28)} not built, run ${subject.missing}\n`);
        continue;
      }
      const seen = pointReads.get(subject.label) ?? [];
      const ws = median(seen.map((sample) => sample.ws));
      const above =
        ws === undefined || bare === undefined || subject.label === 'bare bun' ? '' : ` (+${((ws - bare) / MB).toFixed(1)})`;
      const priv = median(seen.map((sample) => sample.priv));
      const threads = median(seen.map((sample) => sample.threads));
      process.stdout.write(
        `${subject.label.padEnd(28)} ${`${megabytes(ws)}${above}`.padStart(20)} ${megabytes(priv).padStart(10)} ${String(threads ?? 'unread').padStart(8)}\n`,
      );
    }
  }
}

await main();
