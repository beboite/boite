import { spawn as spawnNodeChild } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { AgentResourceSnapshot, ProcessRecord, Settings, ThreadId, ThreadLoad, ThreadSummary, TraceCapability, Turn } from '@boite/contracts';
import type { Bus } from './bus.ts';
import type { Journal } from './journal.ts';
import { MemoryGuard } from './memory-guard.ts';
import type { MemoryProcess } from './memory-guard-logic.ts';
import { processPlatform } from './platform/index.ts';
import { stopGroup } from './platform/posix-kill.ts';
import type { GuardStatus, NativeProcessExit, NativeProcessInfo, ProcessPlatform } from './platform/types.ts';
import { ResourceCollection } from './resource-usage.ts';

export interface SpawnOptions {
  /** Bounded normal-priority initialization, ended explicitly when the agent is ready. */
  startup?: boolean;
  /** Direct spawns are agent roots unless the caller identifies a tool process. */
  agentRoot?: boolean;
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

export interface TerminalSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
  onData(bytes: Uint8Array): void;
}

export interface SpawnedTerminal {
  record: ProcessRecord;
  terminal: Bun.Terminal;
  exited: Promise<number>;
}

interface Entry {
  record: ProcessRecord;
  identity: ProcessIdentity;
  root: boolean;
  startup?: boolean;
  /** Off Windows, the group stop that follows: resolved once the group is gone or SIGKILLed. */
  kill(): void | Promise<void>;
  usage(): { cpuMs: number; peakMemoryBytes: number } | null;
}

interface ProcessIdentity {
  startedAt: number | null;
  incarnation: string | null;
}

interface KnownProcess {
  identity: ProcessIdentity;
  incarnations: Set<string>;
  recordedAt: number;
}

/** How far a value moves before the load is worth another `thread.updated`. */
const CPU_EPSILON_PERCENT = 1;
const MEMORY_EPSILON_BYTES = 1024 * 1024;
const LOAD_INTERVAL_MS = 1000;
export const STARTUP_PRIORITY = { ms: 30_000 };
/** How long a thread with nothing running keeps its pid history, for a late job event. */
const FORGET_DELAY_MS = 30_000;
/**
 * How long a thread stays idle after its turn before what it left behind is
 * stopped, and how old such a process must be. A launcher handing over to a
 * child it means to keep does so well inside that.
 */
const ORPHAN_GRACE_MS = 10_000;
/**
 * Off Windows each child leads a process group of its own, so its kill reaches
 * what it started (platform/posix-kill.ts). On Windows the thread's job does that.
 */
const OWN_GROUP = process.platform !== 'win32';

export interface ProcRegistryOptions {
  orphanGraceMs?: number;
  /** How long an idle thread is kept before it is forgotten. Tests shorten it. */
  forgetDelayMs?: number;
  /**
   * The row a load tick hands the clients. A client replaces its row with it,
   * so it has to carry what the stored summary lacks (the running clock, the
   * background work); the core passes its own builder.
   */
  summarize?: (thread: ThreadSummary) => ThreadSummary;
}

/**
 * The one launcher. Nothing in the core reaches `Bun.spawn` directly: a child
 * that skips this registry is invisible to the trace and survives killTree.
 * On Windows the thread's Job Object reports the rest of the tree, so a
 * grandchild nobody here spawned is registered from a job event.
 */
export class ProcRegistry {
  readonly memory: MemoryGuard;
  private readonly unassigned = new Set<number>();
  private readonly startups = new Map<ThreadId, { pid: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly exitTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly live = new Map<ThreadId, Map<number, Entry>>();
  /** Captured incarnations of each pid, retained to reject delayed native events. */
  private readonly known = new Map<ThreadId, Map<number, KnownProcess>>();
  /** Forgetting a thread whose last process exited, once a late job event can no longer arrive. */
  private readonly forgetTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  private readonly lastLoad = new Map<ThreadId, ThreadLoad>();
  private readonly resources: ResourceCollection;
  /** What was last sent as `thread.updated`. A plain read must never move it. */
  private readonly lastPushed = new Map<ThreadId, ThreadLoad>();
  private readonly loadTimer: ReturnType<typeof setInterval>;
  /** A sweep waiting for the thread to stay idle, cancelled by its next turn. */
  private readonly sweepTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  /** Group stops still inside their grace, off Windows: what `killAll` waits for. */
  private readonly stops = new Set<Promise<void>>();
  private reapOrphans = true;
  private readonly orphanGraceMs: number;
  private readonly forgetDelayMs: number;
  private readonly summarize: (thread: ThreadSummary) => ThreadSummary;
  private readonly stopListening: () => void;
  private closing: Promise<void> | null = null;
  private accepting = true;

  stopAccepting(): void { this.accepting = false; }
  private assertAccepting(): void {
    if (!this.accepting || this.closing !== null) throw new Error('the core is stopping; no new process may start');
  }

  constructor(
    private readonly journal: Journal,
    private readonly bus: Bus,
    private readonly platform: ProcessPlatform = processPlatform,
    options: ProcRegistryOptions = {},
  ) {
    this.memory = new MemoryGuard(bus, platform);
    this.resources = new ResourceCollection(platform);
    this.orphanGraceMs = options.orphanGraceMs ?? ORPHAN_GRACE_MS;
    this.forgetDelayMs = options.forgetDelayMs ?? FORGET_DELAY_MS;
    this.summarize = options.summarize ?? ((thread) => thread);
    this.stopListening = this.bus.onAny((name, payload) => {
      if (name === 'turn.started') {
        this.cancelSweep((payload as Turn).threadId);
        this.platform.warm();
      }
      else if (name === 'turn.finished') this.scheduleSweep((payload as Turn).threadId);
    });
    this.platform.retain({
      started: (threadId, pid, info) => {
        this.onJobStarted(threadId, pid, info);
      },
      exited: (threadId, pid, exit) => {
        this.onJobExited(threadId, pid, exit);
      },
      note: (threadId, _message) => {
        this.bus.emit('core.log', { level: 'warn', message: 'the process platform reported a warning', source: 'process', event: 'platform.warning', threadId, at: Date.now() });
      },
      memoryLimit: (threadId, kind) => {
        this.memory.memoryLimit(threadId, kind);
        const message = kind === 'thread-cap'
          ? `thread ${threadId}: the thread reached its memory cap`
          : 'the agents reached their memory budget';
        this.bus.emit('core.log', { level: 'warn', message, source: 'process', event: 'memory.limit', ...(threadId === null ? {} : { threadId }), at: Date.now() });
      },
    }, {
      pushed: (threadId, pid, title, restored) => {
        this.bus.emit('process.focusPushed', { threadId, pid, title, restored, at: Date.now() });
        this.bus.emit('core.log', {
          level: 'info',
          message: `a window of pid ${pid} was pushed back; restored=${restored}`,
          source: 'process', event: 'process.focus-pushed', threadId,
          at: Date.now(),
        });
      },
      muted: (threadId, pid) => {
        this.bus.emit('process.muted', { threadId, pid, at: Date.now() });
        this.bus.emit('core.log', {
          level: 'info',
          message: `the audio of pid ${pid} is muted`,
          source: 'process', event: 'process.muted', threadId,
          at: Date.now(),
        });
      },
      note: (_message) => {
        this.bus.emit('core.log', { level: 'warn', message: 'the process guard reported a warning', source: 'process', event: 'guard.warning', at: Date.now() });
      },
    });
    this.loadTimer = setInterval(() => {
      this.sampleLoad();
    }, LOAD_INTERVAL_MS);
    if (typeof this.loadTimer.unref === 'function') this.loadTimer.unref();
  }

  capability(): TraceCapability {
    return this.platform.capability();
  }

  watchResources(connectionId: string, watch: boolean | undefined): void {
    this.resources.watch(connectionId, watch);
  }

  unwatchResources(connectionId: string): void {
    this.resources.unwatch(connectionId);
  }

  /** Paths, commands and account identifiers never enter this paired-device DTO. */
  resourceUsage(): AgentResourceSnapshot {
    return this.resources.snapshot(this.liveThreads(), id => this.journal.getThread(id), id => this.loadOf(id));
  }

  applySettings(settings: Settings): void {
    this.memory.applySettings(settings);
    this.platform.applySettings(settings);
    this.reapOrphans = settings.reapOrphans !== false;
    if (!this.reapOrphans) for (const threadId of [...this.sweepTimers.keys()]) this.cancelSweep(threadId);
  }

  /** What the guard Worker is doing, focus and audio. Read by the tests, not by a client. */
  guardStatus(): GuardStatus {
    return this.platform.guardStatus();
  }

  /**
   * Resolves once the platform let go of everything native, the guard's muted
   * sessions included. Closing twice waits on the same release.
   */
  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.stopListening();
    for (const threadId of this.startups.keys()) this.finishStartup(threadId);
    for (const timer of this.sweepTimers.values()) clearTimeout(timer);
    this.sweepTimers.clear();
    clearInterval(this.loadTimer);
    this.resources.close();
    for (const timer of this.exitTimers.values()) clearTimeout(timer);
    this.exitTimers.clear();
    for (const timer of this.forgetTimers.values()) clearTimeout(timer);
    this.forgetTimers.clear();
    this.closing = this.platform.release();
    return this.closing;
  }

  spawn(threadId: ThreadId, cmd: string, args: string[], opts: SpawnOptions = {}): SpawnedProcess {
    this.assertAccepting();
    const env: Record<string, string | undefined> = { ...process.env, ...(opts.env ?? {}) };
    const proc = Bun.spawn({
      cmd: [cmd, ...args],
      cwd: opts.cwd,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      detached: OWN_GROUP,
    });

    const record = this.register(threadId, proc.pid, cmd, args, {
      root: opts.agentRoot !== false,
      startup: opts.startup === true,
      kill: () => killBunChild(proc),
      usage: () => {
        const usage = proc.resourceUsage();
        if (!usage) return null;
        // Bun reports cpuTime in microseconds, as BigInt on Windows.
        return { cpuMs: Math.round(Number(usage.cpuTime.total) / 1000), peakMemoryBytes: Number(usage.maxRSS) };
      },
    });

    const exited = proc.exited.then((code) => {
      this.onExit(threadId, record.pid, code, undefined, record);
      return code;
    });

    return { record, proc, exited };
  }

  /**
   * `spawn` with stdin left open. The account login needs it: a provider CLI
   * that cannot reach a browser asks for a code to be pasted back.
   */
  spawnPiped(threadId: ThreadId, cmd: string, args: string[], opts: SpawnOptions = {}): SpawnedPipedProcess {
    this.assertAccepting();
    const env = opts.env ?? process.env;
    const proc = Bun.spawn({
      cmd: [cmd, ...args],
      cwd: opts.cwd,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      detached: OWN_GROUP,
    });

    const record = this.register(threadId, proc.pid, cmd, args, {
      root: opts.agentRoot !== false,
      startup: opts.startup === true,
      kill: () => killBunChild(proc),
      usage: () => {
        const usage = proc.resourceUsage();
        if (!usage) return null;
        return { cpuMs: Math.round(Number(usage.cpuTime.total) / 1000), peakMemoryBytes: Number(usage.maxRSS) };
      },
    });

    const exited = proc.exited.then((code) => {
      this.onExit(threadId, record.pid, code, undefined, record);
      return code;
    });

    return { record, proc, exited };
  }

  /**
   * `spawn` on a pseudo-terminal: ConPTY on Windows, a pty elsewhere, both
   * through Bun's own. The shell a user types into needs one, a pipe makes it
   * drop its prompt and line editing. The environment is passed as given.
   */
  spawnTerminal(threadId: ThreadId, cmd: string, args: string[], opts: TerminalSpawnOptions): SpawnedTerminal {
    this.assertAccepting();
    const proc = Bun.spawn({
      cmd: [cmd, ...args],
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        data: (_terminal, bytes) => {
          opts.onData(bytes);
        },
      },
    });
    const terminal = proc.terminal;
    if (terminal === undefined) {
      proc.kill();
      throw new Error('this Bun gave the process no terminal');
    }

    const record = this.register(threadId, proc.pid, cmd, args, {
      root: false,
      kill: () => {
        if (process.platform === 'win32') {
          proc.kill();
          return;
        }
        // An interactive shell ignores SIGTERM. A hang-up is what closing a
        // terminal sends: the shell exits on it and passes it to its jobs.
        proc.kill('SIGHUP');
        const hard = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // already exited
          }
        }, 2000);
        hard.unref();
        void proc.exited.finally(() => clearTimeout(hard));
      },
      usage: () => {
        const usage = proc.resourceUsage();
        if (!usage) return null;
        return { cpuMs: Math.round(Number(usage.cpuTime.total) / 1000), peakMemoryBytes: Number(usage.maxRSS) };
      },
    });

    const exited = proc.exited.then((code) => {
      this.onExit(threadId, record.pid, code, undefined, record);
      terminal.close();
      return code;
    });

    return { record, terminal, exited };
  }

  /**
   * The same registry entry as `spawn`, but through `node:child_process` so the
   * caller gets node streams and node events. The Claude SDK spawns its CLI
   * through this and would otherwise leave a process nothing can see or kill.
   * The environment is passed as given: the caller has already merged it.
   */
  spawnChild(threadId: ThreadId, cmd: string, args: string[], opts: SpawnOptions = {}): SpawnedChild {
    this.assertAccepting();
    const child = spawnNodeChild(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: OWN_GROUP,
    });

    const record = this.register(threadId, child.pid ?? -1, cmd, args, {
      root: opts.agentRoot !== false,
      startup: opts.startup === true,
      kill: () => {
        if (OWN_GROUP) return stopGroup(child.pid ?? -1, () => child.exitCode === null && child.signalCode === null);
        child.kill();
        return undefined;
      },
      usage: () => null,
    });

    child.once('exit', (code) => {
      this.onExit(threadId, record.pid, code, undefined, record);
    });
    // A child that never starts emits 'error' and no 'exit'; without this it
    // would stay in the live registry for the rest of the session.
    child.once('error', () => {
      this.onExit(threadId, record.pid, null, undefined, record);
    });

    return child;
  }

  private register(
    threadId: ThreadId,
    pid: number,
    cmd: string,
    args: string[],
    control: Omit<Entry, 'record' | 'identity'>,
  ): ProcessRecord {
    const nativeStartedAt = this.platform.startedAt(pid);
    const record: ProcessRecord = {
      pid,
      parentPid: process.pid,
      threadId,
      exe: cmd,
      commandLine: [cmd, ...args].join(' '),
      startedAt: nativeStartedAt ?? Date.now(),
      exitedAt: null,
      exitCode: null,
      cpuMs: null,
      peakMemoryBytes: null,
      ioBytes: null,
    };

    const attached = this.platform.attach(threadId, pid);
    if (!attached) this.unassigned.add(pid);
    if (control.startup && attached && this.platform.startup) {
      this.finishStartup(threadId);
      this.platform.startup(threadId, true);
      const timer = setTimeout(() => this.finishStartup(threadId), STARTUP_PRIORITY.ms);
      timer.unref();
      this.startups.set(threadId, { pid, timer });
    }
    this.track(threadId, record, control, { startedAt: nativeStartedAt, incarnation: null });
    return record;
  }

  private track(threadId: ThreadId, record: ProcessRecord, control: Omit<Entry, 'record' | 'identity'>, identity: ProcessIdentity): void {
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
    byPid.set(record.pid, { record, identity, ...control });
    // Both spawn paths and the job's own grandchild events land here, so this is
    // the one place the guard learns a pid whose windows it has to push back.
    this.platform.pidAdded(threadId, record.pid);

    let seen = this.known.get(threadId);
    if (seen === undefined) {
      seen = new Map();
      this.known.set(threadId, seen);
    }
    const incarnations = seen.get(record.pid)?.incarnations ?? new Set<string>();
    if (identity.incarnation !== null) incarnations.add(identity.incarnation);
    seen.set(record.pid, { identity, incarnations, recordedAt: record.startedAt });

    // The trace row only: a copy in the event log would be read by nothing.
    this.journal.putProcess(record);
    this.bus.emit('process.started', { ...record });
  }

  /** A process the job reported that this registry never spawned: a grandchild. */
  private onJobStarted(threadId: ThreadId, pid: number, info: NativeProcessInfo): void {
    if (this.journal.isClosed()) return;
    const identity = { startedAt: info.startedAt ?? null, incarnation: info.incarnation ?? null };
    const previous = this.known.get(threadId)?.get(pid);
    if (previous !== undefined && !unseenIdentity(identity, previous)) {
      // A direct spawn initially knows only its creation timestamp. Enrich its
      // identity when its corresponding native start arrives, without tracing twice.
      if (previous.identity.incarnation === null && identity.incarnation !== null
        && identity.startedAt !== null && identity.startedAt === previous.identity.startedAt) {
        previous.identity.incarnation = identity.incarnation;
        previous.incarnations.add(identity.incarnation);
      }
      return;
    }
    const replaced = this.live.get(threadId)?.get(pid);
    if (replaced !== undefined) {
      this.onExit(threadId, pid, null, { exitCode: null, cpuMs: null, peakMemoryBytes: null, ioBytes: null, ...replaced.identity }, replaced.record);
    }
    // SQLite's trace key includes startedAt. Exact native identities can differ
    // within one millisecond, so retain separate rows even when their ms clocks agree.
    const startedAt = Math.max(identity.startedAt ?? Date.now(), (previous?.recordedAt ?? -Infinity) + 1);
    this.track(
      threadId,
      {
        pid,
        parentPid: info.parentPid,
        threadId,
        exe: info.exe,
        commandLine: info.commandLine,
        startedAt,
        exitedAt: null,
        exitCode: null,
        cpuMs: null,
        peakMemoryBytes: null,
        ioBytes: null,
      },
      {
        // Nothing to kill by hand: the job owns this process, killTree terminates it.
        root: false,
        kill: () => undefined,
        usage: () => null,
      },
      identity,
    );
  }

  private onJobExited(threadId: ThreadId, pid: number, exit: NativeProcessExit): void {
    this.onExit(threadId, pid, exit.exitCode, exit);
  }

  liveOf(threadId: ThreadId): ProcessRecord[] {
    const byPid = this.live.get(threadId);
    if (byPid === undefined) return [];
    return [...byPid.values()].map((entry) => ({ ...entry.record }));
  }

  /** Threads with at least one process running now. */
  liveThreads(): ThreadId[] {
    return [...this.live].flatMap(([threadId, byPid]) => (byPid.size > 0 ? [threadId] : []));
  }

  liveCount(threadId: ThreadId): number {
    return this.live.get(threadId)?.size ?? 0;
  }

  finishStartup(threadId: ThreadId): void {
    const startup = this.startups.get(threadId);
    if (!startup) return;
    clearTimeout(startup.timer);
    this.startups.delete(threadId);
    this.platform.startup?.(threadId, false);
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
    this.finishStartup(threadId);
    const byPid = this.live.get(threadId);
    const entries = byPid === undefined ? [] : [...byPid.values()];
    const terminated = this.platform.terminate(threadId);
    for (const entry of entries) {
      if (terminated && !this.unassigned.has(entry.record.pid)) continue;
      if (entry.record.pid <= 0) continue;
      this.platform.terminateUnassigned(entry.record.pid);
      try {
        const stop = entry.kill();
        if (stop !== undefined) this.trackStop(stop);
      } catch {
        // already exited
      }
    }
    return entries.length;
  }

  /**
   * Stops every thread's processes. Off Windows it resolves once each group
   * stop has ended, SIGKILL included, which is at most `KILL_GRACE_MS` for a
   * group that ignored SIGTERM: a core that exited first would leave it running
   * in its own session. Stops started earlier, by an interrupt say, are awaited too.
   */
  killAll(): Promise<void> {
    for (const threadId of [...this.live.keys()]) this.killTree(threadId);
    return Promise.all([...this.stops]).then(() => undefined);
  }

  private trackStop(stop: Promise<void>): void {
    this.stops.add(stop);
    void stop.finally(() => this.stops.delete(stop));
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

  /**
   * Stops what the thread left running with nobody above it: a process the job
   * reported whose parent exited, or whose parent pid now names a younger
   * process, with everything under it. A parent missing from the registry is
   * looked up in the system first, and one found running there keeps its child.
   * That is what an interrupted or refused command leaves, since stopping a
   * shell does not stop what it started. The
   * agent itself and anything the core spawned have the core as their parent
   * and are never taken. Returns the pids stopped.
   */
  sweepOrphans(threadId: ThreadId, now: number = Date.now()): number[] {
    const byPid = this.live.get(threadId);
    if (byPid === undefined || this.journal.isClosed()) return [];
    const entries = [...byPid.values()];
    const stopping = new Map<number, Entry>();
    for (const entry of entries) {
      const { record } = entry;
      const parentPid = record.parentPid;
      if (parentPid === null || parentPid === process.pid) continue;
      if (now - nativeBirth(entry) < this.orphanGraceMs) continue;
      const parent = byPid.get(parentPid);
      if (parent !== undefined && !bornAfter(parent, entry)) continue;
      // The registry is a copy, and a missed event leaves it short of a parent.
      // A millisecond lookup must not override a captured newer incarnation.
      if (parent === undefined || parent.identity.startedAt === null || entry.identity.startedAt === null) {
        const running = this.platform.runningSince(parentPid);
        if (running !== null && running <= nativeBirth(entry)) continue;
      }
      stopping.set(record.pid, entry);
    }
    if (stopping.size === 0) return [];
    // An orphan's own children still have a live parent: they go with it. One
    // index by parent, then one walk down, so a deep tree costs its size.
    const children = new Map<number, Entry[]>();
    for (const entry of entries) {
      const { record } = entry;
      if (record.parentPid === null) continue;
      const siblings = children.get(record.parentPid);
      if (siblings === undefined) children.set(record.parentPid, [entry]);
      else siblings.push(entry);
    }
    const pending = [...stopping.values()];
    for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
      for (const child of children.get(parent.record.pid) ?? []) {
        if (stopping.has(child.record.pid) || bornAfter(parent, child)) continue;
        stopping.set(child.record.pid, child);
        pending.push(child);
      }
    }
    const stopped: number[] = [];
    for (const { record } of stopping.values()) {
      if (!this.platform.terminateProcess(threadId, record.pid)) continue;
      stopped.push(record.pid);
      this.bus.emit('core.log', {
        level: 'info',
        message: `pid ${record.pid} was left running with no parent and was stopped`,
        source: 'process', event: 'process.orphan-stopped', threadId,
        at: Date.now(),
      });
    }
    return stopped;
  }

  /**
   * The same sweep a finished turn schedules, for a thread whose agent process
   * the core just released with no turn to finish (`ThreadStore.releaseAgent`:
   * a Stop on an idle thread, an archive, an account switch, a stopped child
   * agent, a provider update). The agent exits on its own inside the grace, and
   * what it ran in the background (a dev server, a watcher) is an orphan then.
   */
  sweepSoon(threadId: ThreadId): void {
    this.scheduleSweep(threadId);
  }

  private scheduleSweep(threadId: ThreadId): void {
    this.cancelSweep(threadId);
    if (!this.reapOrphans || !this.live.has(threadId)) return;
    const timer = setTimeout(() => {
      this.sweepTimers.delete(threadId);
      this.sweepOrphans(threadId);
    }, this.orphanGraceMs);
    timer.unref();
    this.sweepTimers.set(threadId, timer);
  }

  private cancelSweep(threadId: ThreadId): void {
    const timer = this.sweepTimers.get(threadId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.sweepTimers.delete(threadId);
  }

  private onExit(threadId: ThreadId, pid: number, code: number | null, fromJob?: NativeProcessExit, expected?: ProcessRecord): void {
    const entry = this.live.get(threadId)?.get(pid);
    if (entry === undefined) return;
    if (expected !== undefined && entry.record !== expected) return;
    if (fromJob !== undefined) {
      if (fromJob.incarnation != null && entry.identity.incarnation !== null
        && fromJob.incarnation !== entry.identity.incarnation) return;
      if (fromJob.startedAt != null && entry.identity.startedAt !== null
        && fromJob.startedAt !== entry.identity.startedAt) return;
      // A pid-only exit cannot prove it belongs to a captured native incarnation.
      if (fromJob.incarnation == null && fromJob.startedAt == null && entry.identity.incarnation !== null) return;
    }
    if (this.startups.get(threadId)?.pid === pid) this.finishStartup(threadId);
    // Node's exit has no usage. Let the completion-port event carry it, while
    // retaining a bounded fallback if the worker missed a short-lived process.
    if (fromJob === undefined && !this.unassigned.has(pid) && this.capability().mode === 'events'
      && !this.exitTimers.has(pid)) {
      const timer = setTimeout(() => this.onExit(threadId, pid, code, undefined, entry.record), 1000);
      timer.unref();
      this.exitTimers.set(pid, timer);
      return;
    }
    const timer = this.exitTimers.get(pid);
    if (timer !== undefined) clearTimeout(timer);
    this.exitTimers.delete(pid);
    this.unassigned.delete(pid);
    this.live.get(threadId)?.delete(pid);
    if ((this.live.get(threadId)?.size ?? 0) === 0) {
      this.lastLoad.delete(threadId); this.lastPushed.delete(threadId);
      this.resources.forget(threadId);
    }
    this.forgetWhenIdle(threadId);
    this.platform.pidRemoved(threadId, pid);
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
    this.journal.putProcess(record);

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
      this.resources.forget(threadId);
      this.lastPushed.delete(threadId);
      // The thread's Job Object too: an id minted per call would otherwise hold
      // one kernel handle for the life of the core.
      this.platform.forget(threadId);
      if (!this.journal.isClosed()) this.journal.forgetProcessesWithoutThread(threadId);
    }, this.forgetDelayMs);
    timer.unref();
    this.forgetTimers.set(threadId, timer);
  }

  private measure(threadId: ThreadId, processes: number, memory?: MemoryProcess[]): ThreadLoad {
    const sample = this.platform.sample(threadId);
    this.resources.sample(threadId, sample);
    if (sample === null) return { processes, cpuPercent: 0, memoryBytes: 0 };
    for (const measured of sample.workingSets ?? []) {
      const entry = this.live.get(threadId)?.get(measured.pid);
      if (entry !== undefined) memory?.push({ threadId, pid: measured.pid, exe: entry.record.exe, bytes: measured.committedBytes ?? measured.bytes, root: entry.root });
      else if (this.capability().os !== 'windows') memory?.push({ threadId, pid: measured.pid, exe: measured.exe ?? 'process', bytes: measured.bytes, root: false });
    }
    return { processes, cpuPercent: sample.cpuPercent, memoryBytes: sample.memoryBytes };
  }

  private sampleLoad(): void {
    if (this.journal.isClosed()) return;
    this.resources.sync();
    this.resources.sampledAt = Date.now();
    const processes: MemoryProcess[] = [];
    for (const [threadId, byPid] of this.live) {
      if (byPid.size === 0) continue;
      const load = this.measure(threadId, byPid.size, processes);
      this.lastLoad.set(threadId, load);
      if (!worthPushing(this.lastPushed.get(threadId), load)) continue;
      const thread = this.journal.getThread(threadId);
      if (thread === null) continue;
      this.lastPushed.set(threadId, load);
      this.bus.emit('thread.updated', { ...this.summarize(thread), load });
    }
    for (const threadId of [...this.lastLoad.keys()]) {
      if ((this.live.get(threadId)?.size ?? 0) > 0) continue;
      this.lastLoad.delete(threadId);
      this.resources.forget(threadId);
      this.lastPushed.delete(threadId);
    }
    if (this.resources.active) this.platform.finishResources?.();
    this.memory.sample(processes.reduce((sum, process) => sum + process.bytes, 0), processes, (victim) => {
      const entry = this.live.get(victim.threadId)?.get(victim.pid);
      if (entry?.root) return false;
      if (this.capability().os === 'windows') return entry !== undefined && this.platform.terminateProcess(victim.threadId, victim.pid);
      try {
        if (entry === undefined) return this.platform.terminateProcess(victim.threadId, victim.pid);
        const stop = entry.kill();
        if (stop !== undefined) this.trackStop(stop);
        return true;
      } catch {
        return false;
      }
    });
  }
}

/** A Bun child's kill: its whole group off Windows, the process itself on Windows. */
function killBunChild(proc: Bun.Subprocess): Promise<void> | undefined {
  if (OWN_GROUP) return stopGroup(proc.pid, () => proc.exitCode === null && proc.signalCode === null);
  proc.kill();
  return undefined;
}

function nativeBirth(entry: Entry): number {
  return entry.identity.startedAt ?? entry.record.startedAt;
}

function bornAfter(parent: Entry, child: Entry): boolean {
  if (parent.identity.incarnation !== null && child.identity.incarnation !== null) {
    try { return BigInt(parent.identity.incarnation) > BigInt(child.identity.incarnation); }
    catch { /* A platform without numeric native identities uses its birth clock. */ }
  }
  return nativeBirth(parent) > nativeBirth(child);
}

function unseenIdentity(next: ProcessIdentity, previous: KnownProcess): boolean {
  if (next.incarnation !== null && previous.identity.incarnation !== null) {
    return !previous.incarnations.has(next.incarnation);
  }
  // An unknown event is kept conservative: today's occupant cannot identify
  // an earlier event for a short-lived process that has already exited.
  return next.startedAt !== null && previous.identity.startedAt !== null && next.startedAt > previous.identity.startedAt;
}

function worthPushing(previous: ThreadLoad | undefined, next: ThreadLoad): boolean {
  if (previous === undefined) return true;
  if (previous.processes !== next.processes) return true;
  if (Math.abs(previous.cpuPercent - next.cpuPercent) > CPU_EPSILON_PERCENT) return true;
  return Math.abs(previous.memoryBytes - next.memoryBytes) > MEMORY_EPSILON_BYTES;
}
