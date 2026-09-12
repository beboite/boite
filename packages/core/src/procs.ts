import { spawn as spawnNodeChild } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { ProcessRecord, Settings, ThreadId, ThreadLoad, TraceCapability } from '@boite/contracts';
import type { Bus } from './bus.ts';
import type { Journal } from './journal.ts';
import {
  assignToThreadJob,
  jobsCapability,
  releaseJobs,
  retainJobs,
  sampleThreadJob,
  setJobLimits,
  terminateThreadJob,
} from './platform/jobs.ts';
import type { JobProcessExit, JobProcessInfo } from './platform/jobs.ts';
import {
  guardPidAdded,
  guardPidRemoved,
  guardStatus,
  releaseGuard,
  retainGuard,
  setGuardEnabled,
  setGuardMute,
} from './platform/guard.ts';
import type { GuardStatus } from './platform/guard.ts';

export interface SpawnOptions {
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export type ChildProcess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

/** A child whose stdin stays open: the account login writes a pasted code into it. */
export type PipedChildProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

/** What `spawnChild` returns: node's own child, which satisfies the SDK's `SpawnedProcess`. */
export type SpawnedChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface SpawnedProcess {
  record: ProcessRecord;
  proc: ChildProcess;
  exited: Promise<number>;
}

export interface SpawnedPipedProcess {
  record: ProcessRecord;
  proc: PipedChildProcess;
  exited: Promise<number>;
}

interface Entry {
  record: ProcessRecord;
  kill(): void;
  usage(): { cpuMs: number; peakMemoryBytes: number } | null;
}

/** How far a value moves before the load is worth another `thread.updated`. */
const CPU_EPSILON_PERCENT = 1;
const MEMORY_EPSILON_BYTES = 1024 * 1024;
const LOAD_INTERVAL_MS = 1000;
/** How long a thread with nothing running keeps its pid history, for a late job event. */
const FORGET_DELAY_MS = 30_000;

/**
 * The one launcher. Nothing in the core reaches `Bun.spawn` directly: a child
 * that skips this registry is invisible to the trace and survives killTree.
 * On Windows the thread's Job Object reports the rest of the tree, so a
 * grandchild nobody here spawned is registered from a job event.
 */
export class ProcRegistry {
  private readonly unassigned = new Set<number>();
  private readonly exitTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly live = new Map<ThreadId, Map<number, Entry>>();
  /** Every pid this thread ever registered. A job event for one of them is a repeat, not a grandchild. */
  private readonly known = new Map<ThreadId, Set<number>>();
  /** Forgetting a thread whose last process exited, once a late job event can no longer arrive. */
  private readonly forgetTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  private readonly lastLoad = new Map<ThreadId, ThreadLoad>();
  /** What was last sent as `thread.updated`. A plain read must never move it. */
  private readonly lastPushed = new Map<ThreadId, ThreadLoad>();
  private readonly loadTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly journal: Journal,
    private readonly bus: Bus,
  ) {
    retainJobs({
      started: (threadId, pid, info) => {
        this.onJobStarted(threadId, pid, info);
      },
      exited: (threadId, pid, exit) => {
        this.onJobExited(threadId, pid, exit);
      },
      note: (threadId, message) => {
        this.bus.emit('core.log', { level: 'warn', message: `thread ${threadId}: ${message}`, at: Date.now() });
      },
    });
    retainGuard({
      pushed: (threadId, pid, title, restored) => {
        this.bus.emit('process.focusPushed', { threadId, pid, title, restored, at: Date.now() });
        this.bus.emit('core.log', {
          level: 'info',
          message: `thread ${threadId}: a window of pid ${pid} (${title}) was pushed back`,
          at: Date.now(),
        });
      },
      muted: (threadId, pid) => {
        this.bus.emit('process.muted', { threadId, pid, at: Date.now() });
        this.bus.emit('core.log', {
          level: 'info',
          message: `thread ${threadId}: the audio of pid ${pid} is muted`,
          at: Date.now(),
        });
      },
      note: (message) => {
        this.bus.emit('core.log', { level: 'warn', message, at: Date.now() });
      },
    });
    this.loadTimer = setInterval(() => {
      this.sampleLoad();
    }, LOAD_INTERVAL_MS);
    if (typeof this.loadTimer.unref === 'function') this.loadTimer.unref();
  }

  capability(): TraceCapability {
    return jobsCapability();
  }

  applySettings(settings: Settings): void {
    setJobLimits({
      agentCpuCapPercent: settings.agentCpuCapPercent,
      threadMemoryCapMb: settings.threadMemoryCapMb,
    });
    setGuardEnabled(settings.focusGuard);
    setGuardMute(settings.muteAgents);
  }

  /** What the guard Worker is doing, focus and audio. Read by the tests, not by a client. */
  guardStatus(): GuardStatus {
    return guardStatus();
  }

  close(): void {
    clearInterval(this.loadTimer);
    for (const timer of this.exitTimers.values()) clearTimeout(timer);
    this.exitTimers.clear();
    for (const timer of this.forgetTimers.values()) clearTimeout(timer);
    this.forgetTimers.clear();
    releaseJobs();
    releaseGuard();
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
      this.onExit(threadId, record.pid, code);
      return code;
    });

    return { record, proc, exited };
  }

  /**
   * `spawn` with stdin left open. The account login needs it: a provider CLI
   * that cannot reach a browser asks for a code to be pasted back.
   */
  spawnPiped(threadId: ThreadId, cmd: string, args: string[], opts: SpawnOptions = {}): SpawnedPipedProcess {
    const env = opts.env ?? process.env;
    const proc = Bun.spawn({
      cmd: [cmd, ...args],
      cwd: opts.cwd,
      env,
      stdin: 'pipe',
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
        return { cpuMs: Math.round(Number(usage.cpuTime.total) / 1000), peakMemoryBytes: Number(usage.maxRSS) };
      },
    });

    const exited = proc.exited.then((code) => {
      this.onExit(threadId, record.pid, code);
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
      this.onExit(threadId, record.pid, code);
    });
    // A child that never starts emits 'error' and no 'exit'; without this it
    // would stay in the live registry for the rest of the session.
    child.once('error', () => {
      this.onExit(threadId, record.pid, null);
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

    if (!assignToThreadJob(threadId, pid)) this.unassigned.add(pid);
    this.track(threadId, record, control);
    return record;
  }

  private track(threadId: ThreadId, record: ProcessRecord, control: Omit<Entry, 'record'>): void {
    const forgetting = this.forgetTimers.get(threadId);
    if (forgetting !== undefined) {
      clearTimeout(forgetting);
      this.forgetTimers.delete(threadId);
    }
    let byPid = this.live.get(threadId);
    if (byPid === undefined) {
      byPid = new Map();
      this.live.set(threadId, byPid);
    }
    byPid.set(record.pid, { record, ...control });
    // Both spawn paths and the job's own grandchild events land here, so this is
    // the one place the guard learns a pid whose windows it has to push back.
    guardPidAdded(threadId, record.pid);

    let seen = this.known.get(threadId);
    if (seen === undefined) {
      seen = new Set();
      this.known.set(threadId, seen);
    }
    seen.add(record.pid);

    this.journal.append({ type: 'process.started', threadId, version: 1, payload: record }, () => {
      this.journal.putProcess(record);
    });
    this.bus.emit('process.started', { ...record });
  }

  /** A process the job reported that this registry never spawned: a grandchild. */
  private onJobStarted(threadId: ThreadId, pid: number, info: JobProcessInfo): void {
    // A short child can be gone from `live` before its job event is handled, so
    // the guard is on what was ever registered, never on what is still running.
    if (this.known.get(threadId)?.has(pid) === true) return;
    if (this.journal.isClosed()) return;
    this.track(
      threadId,
      {
        pid,
        parentPid: info.parentPid,
        threadId,
        exe: info.exe,
        commandLine: info.commandLine,
        startedAt: Date.now(),
        exitedAt: null,
        exitCode: null,
        cpuMs: null,
        peakMemoryBytes: null,
        ioBytes: null,
      },
      {
        // Nothing to kill by hand: the job owns this process, killTree terminates it.
        kill: () => undefined,
        usage: () => null,
      },
    );
  }

  private onJobExited(threadId: ThreadId, pid: number, exit: JobProcessExit): void {
    this.onExit(threadId, pid, exit.exitCode, exit);
  }

  liveOf(threadId: ThreadId): ProcessRecord[] {
    const byPid = this.live.get(threadId);
    if (byPid === undefined) return [];
    return [...byPid.values()].map((entry) => ({ ...entry.record }));
  }

  liveCount(threadId: ThreadId): number {
    return this.live.get(threadId)?.size ?? 0;
  }

  /** What `ThreadSummary.load` carries. Null when the thread has no process. */
  loadOf(threadId: ThreadId): ThreadLoad | null {
    const processes = this.liveCount(threadId);
    if (processes === 0) return null;
    const cached = this.lastLoad.get(threadId);
    if (cached !== undefined) return { ...cached, processes };
    const measured = this.measure(threadId, processes);
    this.lastLoad.set(threadId, measured);
    return measured;
  }

  killTree(threadId: ThreadId): number {
    const byPid = this.live.get(threadId);
    const entries = byPid === undefined ? [] : [...byPid.values()];
    const terminated = terminateThreadJob(threadId);
    for (const entry of entries) {
      if (terminated && !this.unassigned.has(entry.record.pid)) continue;
      if (entry.record.pid <= 0) continue;
      if (process.platform === 'win32') {
        try {
          Bun.spawnSync({
            cmd: ['taskkill', '/T', '/F', '/PID', String(entry.record.pid)],
            stdout: 'ignore',
            stderr: 'ignore',
            windowsHide: true,
          });
        } catch {
          // taskkill fails when the process is already gone; entry.kill() below covers it.
        }
      }
      try {
        entry.kill();
      } catch {
        // already exited
      }
    }
    return entries.length;
  }

  killAll(): void {
    for (const threadId of [...this.live.keys()]) this.killTree(threadId);
  }

  /** Project removal must wait for exit records before deleting the projection. */
  async stopAndWait(threadId: ThreadId): Promise<void> {
    this.killTree(threadId);
    const deadline = Date.now() + 5000;
    while (this.liveCount(threadId) > 0) {
      if (Date.now() >= deadline) throw new Error(`processes of ${threadId} did not exit within five seconds`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  private onExit(threadId: ThreadId, pid: number, code: number | null, fromJob?: JobProcessExit): void {
    const entry = this.live.get(threadId)?.get(pid);
    if (entry === undefined) return;
    // Node's exit has no usage. Let the completion-port event carry it, while
    // retaining a bounded fallback if the worker missed a short-lived process.
    if (fromJob === undefined && !this.unassigned.has(pid) && this.capability().mode === 'events'
      && !this.exitTimers.has(pid)) {
      const timer = setTimeout(() => this.onExit(threadId, pid, code), 1000);
      timer.unref();
      this.exitTimers.set(pid, timer);
      return;
    }
    const timer = this.exitTimers.get(pid);
    if (timer !== undefined) clearTimeout(timer);
    this.exitTimers.delete(pid);
    this.unassigned.delete(pid);
    this.live.get(threadId)?.delete(pid);
    this.forgetWhenIdle(threadId);
    guardPidRemoved(threadId, pid);
    if (this.journal.isClosed()) return;
    const record = entry.record;
    const usage = entry.usage();
    record.exitedAt = Date.now();
    record.exitCode = code;
    if (usage !== null) {
      record.cpuMs = usage.cpuMs;
      record.peakMemoryBytes = usage.peakMemoryBytes;
    }
    if (fromJob !== undefined) {
      if (fromJob.cpuMs !== null) record.cpuMs = fromJob.cpuMs;
      if (fromJob.peakMemoryBytes !== null) record.peakMemoryBytes = fromJob.peakMemoryBytes;
      if (fromJob.ioBytes !== null) record.ioBytes = fromJob.ioBytes;
    }
    this.journal.append({ type: 'process.exited', threadId, version: 1, payload: record }, () => {
      this.journal.putProcess(record);
    });
    this.bus.emit('process.exited', { ...record });
  }

  /**
   * A thread whose last process exited is forgotten, entry and pid history
   * alike. Kept for a moment first, because a job event for one of those pids
   * can still be in flight and `known` is what tells it from a grandchild.
   * Without this, every thread the core ever ran stays in three maps the load
   * tick walks, and a caller minting an id per call (the plugin store) grows
   * them without bound.
   */
  private forgetWhenIdle(threadId: ThreadId): void {
    if ((this.live.get(threadId)?.size ?? 0) > 0) return;
    if (this.forgetTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.forgetTimers.delete(threadId);
      if ((this.live.get(threadId)?.size ?? 0) > 0) return;
      this.live.delete(threadId);
      this.known.delete(threadId);
      this.lastLoad.delete(threadId);
      this.lastPushed.delete(threadId);
    }, FORGET_DELAY_MS);
    timer.unref();
    this.forgetTimers.set(threadId, timer);
  }

  private measure(threadId: ThreadId, processes: number): ThreadLoad {
    const sample = sampleThreadJob(threadId);
    if (sample === null) return { processes, cpuPercent: 0, memoryBytes: 0 };
    return { processes, cpuPercent: sample.cpuPercent, memoryBytes: sample.memoryBytes };
  }

  private sampleLoad(): void {
    if (this.journal.isClosed()) return;
    for (const [threadId, byPid] of this.live) {
      if (byPid.size === 0) continue;
      const load = this.measure(threadId, byPid.size);
      this.lastLoad.set(threadId, load);
      if (!worthPushing(this.lastPushed.get(threadId), load)) continue;
      const thread = this.journal.getThread(threadId);
      if (thread === null) continue;
      this.lastPushed.set(threadId, load);
      this.bus.emit('thread.updated', { ...thread, load });
    }
    for (const threadId of [...this.lastLoad.keys()]) {
      if ((this.live.get(threadId)?.size ?? 0) > 0) continue;
      this.lastLoad.delete(threadId);
      this.lastPushed.delete(threadId);
    }
  }
}

function worthPushing(previous: ThreadLoad | undefined, next: ThreadLoad): boolean {
  if (previous === undefined) return true;
  if (previous.processes !== next.processes) return true;
  if (Math.abs(previous.cpuPercent - next.cpuPercent) > CPU_EPSILON_PERCENT) return true;
  return Math.abs(previous.memoryBytes - next.memoryBytes) > MEMORY_EPSILON_BYTES;
}
