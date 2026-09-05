import { spawn as spawnNodeChild } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { ProcessRecord, ThreadId, TraceCapability } from '@boite/contracts';
import type { Bus } from './bus.ts';
import type { Journal } from './journal.ts';
import { currentOs } from './paths.ts';
import { assignToThreadJob, terminateThreadJob } from './platform/jobs.ts';

export interface SpawnOptions {
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export type ChildProcess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

/** What `spawnChild` returns: node's own child, which satisfies the SDK's `SpawnedProcess`. */
export type SpawnedChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface SpawnedProcess {
  record: ProcessRecord;
  proc: ChildProcess;
  exited: Promise<number>;
}

interface Entry {
  record: ProcessRecord;
  kill(): void;
  usage(): { cpuMs: number; peakMemoryBytes: number } | null;
}

/**
 * The one launcher. Nothing in the core reaches `Bun.spawn` directly: a child
 * that skips this registry is invisible to the trace and survives killTree.
 */
export class ProcRegistry {
  private readonly live = new Map<ThreadId, Map<number, Entry>>();

  constructor(
    private readonly journal: Journal,
    private readonly bus: Bus,
  ) {}

  capability(): TraceCapability {
    return {
      os: currentOs(),
      mode: 'poll',
      note: 'direct children only; Job Objects arrive in wave 3',
    };
  }

  spawn(threadId: ThreadId, cmd: string, args: string[], opts: SpawnOptions = {}): SpawnedProcess {
    const env: Record<string, string | undefined> = { ...process.env, ...(opts.env ?? {}) };
    const proc = Bun.spawn({
      cmd: [cmd, ...args],
      cwd: opts.cwd,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });

    const record = this.register(threadId, proc.pid, cmd, args, {
      kill: () => {
        proc.kill();
      },
      usage: () => {
        const usage = proc.resourceUsage();
        if (!usage) return null;
        // Bun reports cpuTime in microseconds, as BigInt on Windows.
        return { cpuMs: Math.round(Number(usage.cpuTime.total) / 1000), peakMemoryBytes: Number(usage.maxRSS) };
      },
    });

    const exited = proc.exited.then((code) => {
      this.onExit(threadId, record, code);
      return code;
    });

    return { record, proc, exited };
  }

  /**
   * The same registry entry as `spawn`, but through `node:child_process` so the
   * caller gets node streams and node events. The Claude SDK spawns its CLI
   * through this and would otherwise leave a process nothing can see or kill.
   * The environment is passed as given: the caller has already merged it.
   */
  spawnChild(threadId: ThreadId, cmd: string, args: string[], opts: SpawnOptions = {}): SpawnedChild {
    const child = spawnNodeChild(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const record = this.register(threadId, child.pid ?? -1, cmd, args, {
      kill: () => {
        child.kill();
      },
      usage: () => null,
    });

    child.once('exit', (code) => {
      this.onExit(threadId, record, code);
    });
    // A child that never starts emits 'error' and no 'exit'; without this it
    // would stay in the live registry for the rest of the session.
    child.once('error', () => {
      this.onExit(threadId, record, null);
    });

    return child;
  }

  private register(
    threadId: ThreadId,
    pid: number,
    cmd: string,
    args: string[],
    control: Omit<Entry, 'record'>,
  ): ProcessRecord {
    const record: ProcessRecord = {
      pid,
      parentPid: process.pid,
      threadId,
      exe: cmd,
      commandLine: [cmd, ...args].join(' '),
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      cpuMs: null,
      peakMemoryBytes: null,
      ioBytes: null,
    };

    assignToThreadJob(threadId, pid);

    let byPid = this.live.get(threadId);
    if (byPid === undefined) {
      byPid = new Map();
      this.live.set(threadId, byPid);
    }
    byPid.set(pid, { record, ...control });

    this.journal.append({ type: 'process.started', threadId, version: 1, payload: record }, () => {
      this.journal.putProcess(record);
    });
    this.bus.emit('process.started', { ...record });
    return record;
  }

  liveOf(threadId: ThreadId): ProcessRecord[] {
    const byPid = this.live.get(threadId);
    if (byPid === undefined) return [];
    return [...byPid.values()].map((entry) => ({ ...entry.record }));
  }

  liveCount(threadId: ThreadId): number {
    return this.live.get(threadId)?.size ?? 0;
  }

  killTree(threadId: ThreadId): number {
    const byPid = this.live.get(threadId);
    if (byPid === undefined || byPid.size === 0) {
      terminateThreadJob(threadId);
      return 0;
    }
    const entries = [...byPid.values()];
    for (const entry of entries) {
      if (process.platform === 'win32') {
        try {
          Bun.spawnSync({
            cmd: ['taskkill', '/T', '/F', '/PID', String(entry.record.pid)],
            stdout: 'ignore',
            stderr: 'ignore',
            windowsHide: true,
          });
        } catch {
          // taskkill fails when the process is already gone; proc.kill() below covers it.
        }
      }
      try {
        entry.kill();
      } catch {
        // already exited
      }
    }
    terminateThreadJob(threadId);
    return entries.length;
  }

  killAll(): void {
    for (const threadId of [...this.live.keys()]) this.killTree(threadId);
  }

  private onExit(threadId: ThreadId, record: ProcessRecord, code: number | null): void {
    const entry = this.live.get(threadId)?.get(record.pid);
    if (entry === undefined) return;
    this.live.get(threadId)?.delete(record.pid);
    if (this.journal.isClosed()) return;
    const usage = entry.usage();
    record.exitedAt = Date.now();
    record.exitCode = code;
    if (usage !== null) {
      record.cpuMs = usage.cpuMs;
      record.peakMemoryBytes = usage.peakMemoryBytes;
    }
    this.journal.append({ type: 'process.exited', threadId, version: 1, payload: record }, () => {
      this.journal.putProcess(record);
    });
    this.bus.emit('process.exited', { ...record });
  }
}
