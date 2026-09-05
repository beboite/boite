import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree, removeDirectory } from '../../tests/e2e/lib/core.ts';

const SAMPLER = join(import.meta.dir, '..', 'sample-rss.ps1');

export interface ProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  workingSetBytes: number;
  executablePath: string | null;
}

export interface Sample {
  at: number;
  procs: { pid: number; name: string; ws: number }[];
  totalBytes: number;
}

function powershell(script: string): string {
  const run = Bun.spawnSync({
    cmd: ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return run.stdout.toString();
}

/** One Win32_Process pass. Everything else here reads from this snapshot. */
export function snapshot(): Map<number, ProcessInfo> {
  const raw = powershell(
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,ExecutablePath | ConvertTo-Json -Compress',
  );
  const parsed = JSON.parse(raw === '' ? '[]' : raw) as {
    ProcessId: number;
    ParentProcessId: number;
    Name: string;
    WorkingSetSize: number | null;
    ExecutablePath: string | null;
  }[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const map = new Map<number, ProcessInfo>();
  for (const row of rows) {
    map.set(row.ProcessId, {
      pid: row.ProcessId,
      parentPid: row.ParentProcessId,
      name: row.Name,
      workingSetBytes: row.WorkingSetSize ?? 0,
      executablePath: row.ExecutablePath,
    });
  }
  return map;
}

export function workingSet(pid: number, from?: Map<number, ProcessInfo>): number {
  const table = from ?? snapshot();
  return table.get(pid)?.workingSetBytes ?? 0;
}

/** The pid plus every descendant reachable through ParentProcessId. */
export function tree(rootPid: number, from?: Map<number, ProcessInfo>): ProcessInfo[] {
  const table = from ?? snapshot();
  const children = new Map<number, number[]>();
  for (const info of table.values()) {
    const list = children.get(info.parentPid);
    if (list === undefined) children.set(info.parentPid, [info.pid]);
    else list.push(info.pid);
  }
  const found: ProcessInfo[] = [];
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    if (seen.has(current)) continue;
    seen.add(current);
    const info = table.get(current);
    if (info === undefined) continue;
    found.push(info);
    for (const child of children.get(current) ?? []) stack.push(child);
  }
  return found;
}

export function treeBytes(rootPid: number, from?: Map<number, ProcessInfo>): number {
  return tree(rootPid, from).reduce((total, info) => total + info.workingSetBytes, 0);
}

export function sumByName(procs: ProcessInfo[], name: string): { count: number; bytes: number } {
  const matching = procs.filter((info) => info.name.toLowerCase() === name.toLowerCase());
  return {
    count: matching.length,
    bytes: matching.reduce((total, info) => total + info.workingSetBytes, 0),
  };
}

export function findByExecutable(path: string, from?: Map<number, ProcessInfo>): ProcessInfo[] {
  const wanted = path.toLowerCase();
  return [...(from ?? snapshot()).values()].filter(
    (info) => (info.executablePath ?? '').toLowerCase() === wanted,
  );
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Samples the working set of a pid and its descendants until `stop()`. */
export class RssSampler {
  #directory: string;
  #file: string;
  #pid: number;

  private constructor(directory: string, file: string, pid: number) {
    this.#directory = directory;
    this.#file = file;
    this.#pid = pid;
  }

  static start(rootPid: number, intervalMs = 200): RssSampler {
    const directory = mkdtempSync(join(tmpdir(), 'boite-bench-rss-'));
    const file = join(directory, 'samples.jsonl');
    const proc = Bun.spawn({
      cmd: [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        SAMPLER,
        '-Root',
        String(rootPid),
        '-Out',
        file,
        '-IntervalMs',
        String(intervalMs),
      ],
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    });
    return new RssSampler(directory, file, proc.pid);
  }

  /** Async because the sampler still holds the file handle for a moment after the kill. */
  async stop(): Promise<Sample[]> {
    killProcessTree(this.#pid);
    let text = '';
    try {
      text = readFileSync(this.#file, 'utf8');
    } catch {
      text = '';
    }
    await removeDirectory(this.#directory);
    const samples: Sample[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: { t: number; procs: { pid: number; name: string; ws: number }[] | null };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        continue;
      }
      const procs = parsed.procs ?? [];
      samples.push({
        at: parsed.t,
        procs,
        totalBytes: procs.reduce((total, entry) => total + entry.ws, 0),
      });
    }
    return samples;
  }
}

/** What the sampler actually managed, which is never exactly the interval asked for. */
export function cadenceMs(samples: Sample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0] as Sample;
  const last = samples[samples.length - 1] as Sample;
  return (last.at - first.at) / (samples.length - 1);
}

export function peakOf(samples: Sample[]): { bytes: number; at: number } {
  let best = { bytes: 0, at: 0 };
  for (const sample of samples) {
    if (sample.totalBytes > best.bytes) best = { bytes: sample.totalBytes, at: sample.at };
  }
  return best;
}

export function peakOfName(samples: Sample[], name: string): { bytes: number; at: number } {
  const wanted = name.toLowerCase();
  let best = { bytes: 0, at: 0 };
  for (const sample of samples) {
    const bytes = sample.procs
      .filter((entry) => entry.name.toLowerCase() === wanted)
      .reduce((total, entry) => total + entry.ws, 0);
    if (bytes > best.bytes) best = { bytes, at: sample.at };
  }
  return best;
}
