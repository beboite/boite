import { spawn as spawnNodeChild } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentResourceSnapshot, ProcessRecord, Settings, ThreadId, ThreadLoad, TraceCapability, Turn } from '@boite/contracts';
import type { Bus } from './bus.ts';
import type { Journal } from './journal.ts';
import { MemoryGuard } from './memory-guard.ts';
import { currentOs } from './paths.ts';
import type { MemoryProcess } from './memory-guard-logic.ts';
import { registryPlatform } from './platform/index.ts';
import { type KnownProcess, type ProcessIdentity, unseenIdentity } from './process-identity.ts';
import { killBunChild, stopGroup } from './platform/posix-kill.ts';
import type { GuardStatus, NativeProcessExit, NativeProcessInfo, ProcessPlatform } from './platform/types.ts';
import { bunUsage, ResourceCollection } from './resource-usage.ts';
import { traceWrite } from './trace-writes.ts';
import { orphansOf, parentAtStart } from './process-orphans.ts';
import { forgetOnMissing, resolveSpawnCommand, startResolved } from './spawn-command.ts';
import { BUSY_CPU_PERCENT, IDLE_LOAD_INTERVAL_MS, LOAD_INTERVAL_MS, LoadPace, worthPushing } from './load-pace.ts';
import { launchOf } from './git/command.ts';
import { ExecutionProtections } from './execution-protection.ts';
import { closeProcessResources, protectionRunner } from './protection-runner.ts';
import { processEventDiagnostic } from './process-event-diagnostics.ts';

import type { ChildProcess, ManagedStop, ProcessEntry as Entry, SpawnedChild, SpawnedPipedProcess, SpawnedProcess, SpawnedTerminal, SpawnOptions, TerminalSpawnOptions } from './process-spawn-types.ts';
export type { ChildProcess, ManagedStop, PipedChildProcess, SpawnedChild, SpawnedPipedProcess, SpawnedProcess, SpawnedTerminal, SpawnOptions, TerminalSpawnOptions } from './process-spawn-types.ts';

export const STARTUP_PRIORITY = { ms: 30_000 };
/** How long an exited pid stays in its thread's history, for a late job event. */
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
  /** How long an idle thread, or an exited pid of a busy one, is kept before it is forgotten. Tests shorten it. */
  forgetDelayMs?: number;
  /** The load tick while something works, and while everything is idle. Tests shorten them. */
  loadIntervalMs?: number;
  idleLoadIntervalMs?: number;
  /** Persists what the platform and the guards say, which the live log only names. */
  diagnostic?: (message: string, context: { event: string; threadId?: ThreadId; data?: Record<string, string | number | null> }) => void;
}

/**
 * The one launcher. Nothing in the core reaches `Bun.spawn` directly: a child
 * that skips this registry is invisible to the trace and survives killTree.
 * On Windows the thread's Job Object reports the rest of the tree, so a
 * grandchild nobody here spawned is registered from a job event.
 */
export class ProcRegistry {
  readonly memory: MemoryGuard;
  readonly protection: ExecutionProtections;
  mask = (_threadId: ThreadId, text: string): string => text; // secrets: a shell can expand `boite secret run`'s variable into a traced command line
  admitCwd = (_cwd: string): void => {}; // worktrees: no process starts in a checkout a removal holds (`checkouts.ts`)
  private readonly unassigned = new Set<number>();
  readonly #startups = new Map<ThreadId, { pid: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly exitTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly #live = new Map<ThreadId, Map<number, Entry>>();
  /** Captured incarnations of each pid, retained to reject delayed native events. */
  private readonly known = new Map<ThreadId, Map<number, KnownProcess>>();
  readonly #shown = new Set<ThreadId>(); // spawned with `showWindow`: no guard
  /** Forgetting a thread whose last process exited, once a late job event can no longer arrive. */
  private readonly forgetTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  readonly #lastLoad = new Map<ThreadId, ThreadLoad>();
  readonly #resources: ResourceCollection;
  /**
   * What was last sent as `thread.load`. A plain read must never move it. A
   * scope with no thread behind it (a terminal, the devices) records its load
   * here too, so the thread table is asked again only when the load moves.
   */
  readonly #lastPushed = new Map<ThreadId, ThreadLoad>();
  readonly #loadPace: LoadPace;
  /** Threads between `turn.started` and `turn.finished`: the tick stays fast for them. */
  readonly #running = new Set<ThreadId>();
  /** The previous tick saw a thread above `BUSY_CPU_PERCENT` or a process count change. */
  #loadBusy = false;
  /** When exited pids were last dropped from `known`. */
  #knownSweptAt = 0;
  /** A sweep waiting for the thread to stay idle, cancelled by its next turn. */
  readonly #sweepTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  /** Group stops still inside their grace off Windows, and taskkill fallbacks on it: what `killAll` waits for. */
  readonly #stops = new Set<Promise<void>>();
  readonly #childStops = new WeakMap<SpawnedChild, ManagedStop>();
  #reapOrphans = true;
  readonly #orphanGraceMs: number;
  readonly #forgetDelayMs: number;
  readonly #stopListening: () => void;
  #closing: Promise<void> | null = null;
  #accepting = true;

  stopAccepting(): void { this.#accepting = false; }
  /** The options a launch runs with, its folder written as it was checked: `..` read by name, never after a link. */
  #admitted<T extends { cwd?: string }>(opts: T): T {
    if (!this.#accepting || this.#closing !== null) throw new Error('the core is stopping; no new process may start');
    if (opts.cwd === undefined) return opts;
    const cwd = resolve(opts.cwd);
    this.admitCwd(cwd);
    return { ...opts, cwd };
  }

  readonly #journal: Journal;
  readonly #bus: Bus;
  readonly #options: ProcRegistryOptions;
  constructor(
    journal: Journal,
    bus: Bus,
    readonly platform: ProcessPlatform = registryPlatform(),
    options: ProcRegistryOptions = {},
  ) {
    this.#journal = journal;
    this.#bus = bus;
    this.#options = options;
    this.protection = new ExecutionProtections(platform.protectedExecution, protectionRunner(this), id => this.stopAndWait(id), id => (platform.hasProcesses?.(id) ? 1 : 0) + this.liveCount(id));
    this.memory = new MemoryGuard(bus, platform);
    this.#resources = new ResourceCollection(platform);
    this.#orphanGraceMs = options.orphanGraceMs ?? ORPHAN_GRACE_MS;
    this.#forgetDelayMs = options.forgetDelayMs ?? FORGET_DELAY_MS;
    this.#stopListening = this.#bus.onAny((name, payload) => {
      if (name === 'turn.started') {
        const { threadId } = payload as Turn;
        this.#cancelSweep(threadId);
        this.platform.warm();
        this.#running.add(threadId);
        this.#loadPace.hurry();
      }
      else if (name === 'turn.finished') {
        const { threadId } = payload as Turn;
        this.#running.delete(threadId);
        this.#scheduleSweep(threadId);
      }
    });
    this.platform.retain({
      started: (threadId, pid, info) => {
        this.#onJobStarted(threadId, pid, info);
      },
      exited: (threadId, pid, exit) => {
        this.onJobExited(threadId, pid, exit);
      },
      note: (threadId, message) => {
        this.#bus.emit('core.log', { level: 'warn', message: 'the process platform reported a warning', source: 'process', event: 'platform.warning', threadId, at: Date.now() });
        try { options.diagnostic?.(`Process platform: ${message}`, { event: 'platform.warning.detail', threadId }); } catch { /* Observability must not break the platform's callback. */ }
      },
      memoryLimit: (threadId, kind) => {
        this.memory.memoryLimit(threadId, kind);
        const message = kind === 'thread-cap'
          ? `thread ${threadId}: the thread reached its memory cap`
          : 'the agents reached their memory budget';
        this.#bus.emit('core.log', { level: 'warn', message, source: 'process', event: 'memory.limit', ...(threadId === null ? {} : { threadId }), at: Date.now() });
      },
    }, {
      pushed: (threadId, pid, title, restored) => {
        this.#bus.emit('process.focusPushed', { threadId, pid, title, restored, at: Date.now() });
        this.#bus.emit('core.log', {
          level: 'info',
          message: `a window of pid ${pid} was pushed back; restored=${restored}`,
          source: 'process', event: 'process.focus-pushed', threadId,
          at: Date.now(),
        });
      },
      muted: (threadId, pid) => {
        this.#bus.emit('process.muted', { threadId, pid, at: Date.now() });
        this.#bus.emit('core.log', {
          level: 'info',
          message: `the audio of pid ${pid} is muted`,
          source: 'process', event: 'process.muted', threadId,
          at: Date.now(),
        });
      },
      note: (message) => {
        this.#bus.emit('core.log', { level: 'warn', message: 'the process guard reported a warning', source: 'process', event: 'guard.warning', at: Date.now() });
        try { options.diagnostic?.(`Focus and audio guard: ${message}`, { event: 'guard.warning.detail' }); } catch { /* Observability must not break the guard's callback. */ }
      },
    });
    // Fast while a turn runs, a task-manager view leases the numbers, memory is under pressure, a startup is boosted or a process was busy.
    this.#loadPace = new LoadPace(() => this.sampleLoad(), () => this.#running.size > 0 || this.#resources.active
      || this.memory.state !== 'ok' || this.#startups.size > 0 || this.#loadBusy,
    options.loadIntervalMs ?? LOAD_INTERVAL_MS, options.idleLoadIntervalMs ?? IDLE_LOAD_INTERVAL_MS);
  }

  capability(): TraceCapability {
    return this.platform.capability();
  }

  watchResources(connectionId: string, watch: boolean | undefined): void {
    this.#resources.watch(connectionId, watch);
    if (this.#resources.active) this.#loadPace.hurry();
  }

  unwatchResources(connectionId: string): void {
    this.#resources.unwatch(connectionId);
  }

  /** Paths, commands and account identifiers never enter this paired-device DTO. */
  resourceUsage(): AgentResourceSnapshot {
    return this.#resources.snapshot(this.liveThreads(), id => this.#journal.getThread(id), id => this.loadOf(id));
  }

  applySettings(settings: Settings): void {
    this.memory.applySettings(settings);
    this.platform.applySettings(settings);
    this.#reapOrphans = settings.reapOrphans !== false;
    if (!this.#reapOrphans) for (const threadId of [...this.#sweepTimers.keys()]) this.#cancelSweep(threadId);
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
    if (this.#closing !== null) return this.#closing;
    this.#stopListening();
    for (const threadId of this.#startups.keys()) this.finishStartup(threadId);
    for (const timer of this.#sweepTimers.values()) clearTimeout(timer);
    this.#sweepTimers.clear();
    this.#loadPace.close();
    this.#running.clear();
    this.#resources.close();
    for (const timer of this.exitTimers.values()) clearTimeout(timer);
    this.exitTimers.clear();
    for (const timer of this.forgetTimers.values()) clearTimeout(timer);
    this.forgetTimers.clear();
    this.#closing = closeProcessResources(this.protection, this.platform);
    return this.#closing;
  }

  spawn(threadId: ThreadId, cmd: string, args: string[], opts: SpawnOptions = {}): SpawnedProcess {
    opts = this.#admitted(opts);
    const protectedLaunch = this.protection.launch(threadId, cmd, args, opts);
    const [command, env] = launchOf(protectedLaunch?.command ?? cmd, protectedLaunch?.env ?? { ...process.env, ...(opts.env ?? {}) });
    const extra = Math.max(0, Math.floor(opts.extraPipes ?? 0));
    const proc = startResolved(command, env, (executable) => Bun.spawn({
      cmd: [executable, ...(protectedLaunch?.args ?? args)],
      cwd: protectedLaunch?.cwd ?? opts.cwd,
      env,
      ...(extra
        ? { stdio: ['ignore', 'pipe', 'pipe', ...Array.from({ length: extra }, () => 'pipe' as const)] as ['ignore', 'pipe', 'pipe'] }
        : { stdin: 'ignore' as const, stdout: 'pipe' as const, stderr: 'pipe' as const }),
      windowsHide: opts.showWindow !== true,
      detached: OWN_GROUP,
    }) as ChildProcess);
    const fds = extra ? (proc.stdio as unknown[]).slice(3).map(Number) : undefined;
    if (opts.showWindow === true) this.#shown.add(threadId);

    const record = this.#register(threadId, proc.pid, cmd, args, {
      root: opts.agentRoot !== false,
      startup: opts.startup === true,
      kill: () => killBunChild(proc),
      running: running(proc),
      usage: () => bunUsage(proc),
    });

    const exited = proc.exited.then((code) => {
      this.onExit(threadId, record.pid, code, undefined, record);
      return code;
    });

    return { record, proc, exited, stop: this.#managedStop(proc.pid, running(proc), () => killBunChild(proc), exited), ...(fds ? { fds } : {}) };
  }

  /**
   * `spawn` with stdin left open. The account login needs it: a provider CLI
   * that cannot reach a browser asks for a code to be pasted back.
   */
  spawnPiped(threadId: ThreadId, cmd: string, args: string[], opts: SpawnOptions = {}): SpawnedPipedProcess {
    opts = this.#admitted(opts);
    const protectedLaunch = this.protection.launch(threadId, cmd, args, opts);
    const [command, env] = launchOf(protectedLaunch?.command ?? cmd, protectedLaunch?.env ?? opts.env ?? process.env);
    const proc = startResolved(command, env, (executable) => Bun.spawn({
      cmd: [executable, ...(protectedLaunch?.args ?? args)],
      cwd: protectedLaunch?.cwd ?? opts.cwd,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      detached: OWN_GROUP,
    }));

    const record = this.#register(threadId, proc.pid, cmd, args, {
      root: opts.agentRoot !== false,
      startup: opts.startup === true,
      kill: () => killBunChild(proc),
      running: running(proc),
      usage: () => bunUsage(proc),
    });

    const exited = proc.exited.then((code) => { this.onExit(threadId, record.pid, code, undefined, record); return code; });
    return { record, proc, exited, stop: this.#managedStop(proc.pid, running(proc), () => killBunChild(proc), exited) };
  }

  /**
   * `spawn` on a pseudo-terminal: ConPTY on Windows, a pty elsewhere, both
   * through Bun's own. The shell a user types into needs one, a pipe makes it
   * drop its prompt and line editing. The environment is passed as given.
   */
  spawnTerminal(threadId: ThreadId, cmd: string, args: string[], opts: TerminalSpawnOptions): SpawnedTerminal {
    opts = this.#admitted(opts);
    this.protection.assertTerminal(threadId);
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

    const record = this.#register(threadId, proc.pid, cmd, args, {
      root: false,
      running: running(proc),
      kill: () => {
        if (process.platform === 'win32') return proc.kill();
        // Interactive jobs have separate groups: capture their descendants
        // before the shell exits and reparents jobs that ignore its hang-up.
        if (currentOs() === 'linux' && this.platform.terminateProcess(threadId, proc.pid)) return;
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
      usage: () => bunUsage(proc),
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
    opts = this.#admitted(opts);
    const protectedLaunch = this.protection.launch(threadId, cmd, args, opts);
    const [command, env] = launchOf(protectedLaunch?.command ?? cmd, protectedLaunch?.env ?? opts.env);
    const executable = resolveSpawnCommand(command, env ?? process.env);
    const child = spawnNodeChild(executable, protectedLaunch?.args ?? args, {
      cwd: protectedLaunch?.cwd ?? opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: OWN_GROUP,
    });

    const kill = (): Promise<void> | undefined => {
      if (OWN_GROUP) return stopGroup(child.pid ?? -1, running(child));
      child.kill();
      return undefined;
    };
    const record = this.#register(threadId, child.pid ?? -1, cmd, args, {
      root: opts.agentRoot !== false,
      startup: opts.startup === true,
      kill,
      running: running(child),
      usage: () => null,
    });
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    this.#childStops.set(child, this.#managedStop(record.pid, running(child), kill, exited));

    child.once('exit', (code) => {
      this.onExit(threadId, record.pid, code, undefined, record);
    });
    // A child that never starts emits 'error' and no 'exit'; without this it
    // would stay in the live registry for the rest of the session.
    child.once('error', (error) => {
      forgetOnMissing(command, executable, error);
      this.onExit(threadId, record.pid, null, undefined, record);
    });

    return child;
  }

  /**
   * `ManagedStop` for a Bun child: its group off Windows, which outlives a
   * leader that exited; on Windows taskkill's tree first, while the root still
   * names it, then the root, since `proc.kill` reaches no grandchild there.
   * Only while `running`, the spawner's own view: until it reports the exit it
   * holds the process's handle, so the pid is still the root's, and the backend
   * takes its own hold in the same tick; after it the pid may be a stranger's.
   */
  #managedStop(pid: number, running: () => boolean, kill: () => Promise<void> | undefined, exited: Promise<unknown>): ManagedStop {
    return () => {
      const tree = pid > 0 && running() ? this.platform.terminateUnassigned(pid) : undefined;
      const stop = tree instanceof Promise ? tree.then(kill, kill) : kill();
      this.#trackStop(stop);
      return Promise.all([stop, exited.catch(() => null)]).then(() => undefined);
    };
  }

  /** The `ManagedStop` of a child `spawnChild` returned, whose SDK-shaped type has no field for it. */
  stopChild(child: SpawnedChild): Promise<void> {
    return this.#childStops.get(child)?.() ?? Promise.resolve();
  }

  #register(
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
    // The child already runs: a failing log must not leave it unregistered, out of the trace and of killTree.
    if (!attached && this.capability().mode === 'events') {
      try { this.#options.diagnostic?.(`pid ${pid} could not join the job of its thread: no CPU cap, memory cap or tree kill applies to it`, { event: 'job.assign-failed', threadId, data: { pid } }); } catch { /* see above */ }
    }
    if (control.startup && attached && this.platform.startup) {
      this.finishStartup(threadId);
      this.platform.startup(threadId, true);
      const timer = setTimeout(() => this.finishStartup(threadId), STARTUP_PRIORITY.ms);
      timer.unref();
      this.#startups.set(threadId, { pid, timer });
    }
    this.#track(threadId, record, control, { startedAt: nativeStartedAt, incarnation: null });
    return record;
  }

  #track(threadId: ThreadId, record: ProcessRecord, control: Omit<Entry, 'record' | 'identity'>, identity: ProcessIdentity): void {
    if (record.commandLine !== null) record.commandLine = this.mask(threadId, record.commandLine);
    const forgetting = this.forgetTimers.get(threadId);
    if (forgetting !== undefined) {
      clearTimeout(forgetting);
      this.forgetTimers.delete(threadId);
    }
    let byPid = this.#live.get(threadId);
    if (byPid === undefined) {
      byPid = new Map();
      this.#live.set(threadId, byPid);
    }
    const entry: Entry = { record, identity, ...control };
    processEventDiagnostic('registry.start-accepted', {threadId, pid: record.pid, startedAt: identity.startedAt,
      incarnation: identity.incarnation, root: entry.root});
    entry.parent = parentAtStart(byPid, entry);
    byPid.set(record.pid, entry);
    // Both spawn paths and the job's own grandchild events land here, so this is
    // the one place the guard learns a pid whose windows it has to push back.
    this.platform.pidAdded(threadId, record.pid, !this.#shown.has(threadId));

    let seen = this.known.get(threadId);
    if (seen === undefined) {
      seen = new Map();
      this.known.set(threadId, seen);
    }
    const incarnations = seen.get(record.pid)?.incarnations ?? new Set<string>();
    if (identity.incarnation !== null) incarnations.add(identity.incarnation);
    seen.set(record.pid, { identity, incarnations, recordedAt: record.startedAt });

    // The trace row only: a copy in the event log would be read by nothing.
    traceWrite(this.#bus, threadId, () => this.#journal.putProcess(record));
    this.#bus.emit('process.started', { ...record });
  }

  /** A process the job reported that this registry never spawned: a grandchild. */
  #onJobStarted(threadId: ThreadId, pid: number, info: NativeProcessInfo): void {
    if (this.#journal.isClosed()) return;
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
    const replaced = this.#live.get(threadId)?.get(pid);
    if (replaced !== undefined) {
      this.onExit(threadId, pid, null, { exitCode: null, cpuMs: null, peakMemoryBytes: null, ioBytes: null, ...replaced.identity }, replaced.record);
    }
    // SQLite's trace key includes startedAt. Exact native identities can differ
    // within one millisecond, so retain separate rows even when their ms clocks agree.
    const startedAt = Math.max(identity.startedAt ?? Date.now(), (previous?.recordedAt ?? -Infinity) + 1);
    this.#track(
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
        running: () => false,
        usage: () => null,
      },
      identity,
    );
  }

  private onJobExited(threadId: ThreadId, pid: number, exit: NativeProcessExit): void {
    this.onExit(threadId, pid, exit.exitCode, exit);
  }

  liveOf(threadId: ThreadId): ProcessRecord[] {
    const byPid = this.#live.get(threadId);
    if (byPid === undefined) return [];
    return [...byPid.values()].map((entry) => ({ ...entry.record }));
  }

  /** Threads with at least one process running now. */
  liveThreads(): ThreadId[] {
    return [...this.#live].flatMap(([threadId, byPid]) => (byPid.size > 0 ? [threadId] : []));
  }

  liveCount(threadId: ThreadId): number {
    return this.#live.get(threadId)?.size ?? 0;
  }

  /** How many pids the thread's history holds, live and recently exited. Read by the tests. */
  knownCount(threadId: ThreadId): number {
    return this.known.get(threadId)?.size ?? 0;
  }

  finishStartup(threadId: ThreadId): void {
    const startup = this.#startups.get(threadId);
    if (!startup) return;
    clearTimeout(startup.timer);
    this.#startups.delete(threadId);
    this.platform.startup?.(threadId, false);
  }

  /** What `ThreadSummary.load` carries. Null when the thread has no process. */
  loadOf(threadId: ThreadId): ThreadLoad | null {
    const processes = this.liveCount(threadId);
    if (processes === 0) return null;
    const cached = this.#lastLoad.get(threadId);
    if (cached !== undefined) return { ...cached, processes };
    const measured = this.#measure(threadId, processes);
    this.#lastLoad.set(threadId, measured);
    return measured;
  }

  /** When the core last asked each thread's processes to stop: a signal after that is its own stop, not a crash. */
  readonly #stopsAsked = new Map<ThreadId, number>();
  /** Whether the core asked this thread's processes to stop at or after `since` (wall time). */
  stopAskedSince(threadId: ThreadId, since: number): boolean {
    const at = this.#stopsAsked.get(threadId);
    return at !== undefined && at >= since;
  }

  killTree(threadId: ThreadId): number {
    this.#stopsAsked.delete(threadId);
    this.#stopsAsked.set(threadId, Date.now());
    if (this.#stopsAsked.size > 1024) this.#stopsAsked.delete(this.#stopsAsked.keys().next().value!);
    this.finishStartup(threadId);
    const byPid = this.#live.get(threadId);
    const entries = byPid === undefined ? [] : [...byPid.values()];
    processEventDiagnostic('registry.stop-requested', {threadId, registered: entries.length});
    const terminated = this.platform.terminate(threadId);
    for (const entry of entries) {
      if (terminated && !this.unassigned.has(entry.record.pid)) continue;
      if (entry.record.pid <= 0) continue;
      // The own kill waits for the tree kill, which /T needs the root alive for; as in `managedStop`, only while held.
      const fallback = entry.running() ? this.platform.terminateUnassigned(entry.record.pid) : undefined;
      this.#trackStop(fallback instanceof Promise ? fallback.then(() => killEntry(entry), () => killEntry(entry)) : killEntry(entry));
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
    for (const threadId of [...this.#live.keys()]) this.killTree(threadId);
    return Promise.all([...this.#stops]).then(() => undefined);
  }

  #trackStop(stop: Promise<void> | undefined): void {
    if (stop === undefined) return;
    this.#stops.add(stop);
    void stop.finally(() => this.#stops.delete(stop));
  }

  /** Project removal waits for exit records; native admission also drains untraced job members when requested. */
  async stopAndWait(threadId: ThreadId): Promise<void> { this.killTree(threadId); await this.waitForExit(threadId); }
  async waitForExit(threadId: ThreadId, pids?: number[], options: {native?: boolean} = {}): Promise<void> {
    const deadline = Date.now() + 5000;
    while ((pids ? pids.some((pid) => this.#live.get(threadId)?.has(pid)) : this.liveCount(threadId) > 0)
      || options.native && this.platform.hasProcesses?.(threadId)) {
      if (Date.now() >= deadline) throw new Error(`processes of ${threadId} did not exit within five seconds`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Stops what the thread left running with nobody above it: a process the job
   * reported whose parent exited, or whose parent pid now names a younger
   * process, with everything under it. A parent missing from the registry is
   * looked up in the system first, and one found running there keeps its child.
   * A parent that is an exited fork of its own (Git Bash) is passed over for
   * the first live ancestor above it (process-orphans.ts).
   * That is what an interrupted or refused command leaves, since stopping a
   * shell does not stop what it started. The agent and whatever the core spawned
   * have the core as their parent and are never taken. Returns the pids stopped.
   */
  sweepOrphans(threadId: ThreadId, now: number = Date.now()): number[] {
    const byPid = this.#live.get(threadId);
    if (byPid === undefined || this.#journal.isClosed()) return [];
    const stopping = orphansOf(byPid, now, this.#orphanGraceMs, pid => this.platform.runningSince(pid));
    if (stopping.size === 0) return [];
    const stopped: number[] = [];
    for (const { record, identity } of stopping.values()) {
      if (!this.platform.terminateProcess(threadId, record.pid, identity.startedAt)) continue;
      stopped.push(record.pid);
      this.#bus.emit('core.log', {
        level: 'info',
        message: `pid ${record.pid} (${record.exe.split(/[\\/]/).pop() || 'unknown'}) was left running with no parent and was stopped`,
        source: 'process', event: 'process.orphan-stopped', threadId, data: { pid: record.pid, exe: record.exe.split(/[\\/]/).pop() || null },
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
    this.#scheduleSweep(threadId);
  }

  #scheduleSweep(threadId: ThreadId): void {
    this.#cancelSweep(threadId);
    if (!this.#reapOrphans || !this.#live.has(threadId)) return;
    const timer = setTimeout(() => {
      this.#sweepTimers.delete(threadId);
      this.sweepOrphans(threadId);
      // A finished turn bounds the thread's trace too (journal/processes.ts).
      if (!this.#journal.isClosed()) traceWrite(this.#bus, threadId, () => this.#journal.pruneProcesses(threadId));
    }, this.#orphanGraceMs);
    timer.unref();
    this.#sweepTimers.set(threadId, timer);
  }

  #cancelSweep(threadId: ThreadId): void {
    const timer = this.#sweepTimers.get(threadId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#sweepTimers.delete(threadId);
  }

  private onExit(threadId: ThreadId, pid: number, code: number | null, fromJob?: NativeProcessExit, expected?: ProcessRecord): void {
    const entry = this.#live.get(threadId)?.get(pid);
    processEventDiagnostic('registry.exit-received', {threadId, pid, native: fromJob !== undefined, tracked: entry !== undefined,
      recordMatches: expected === undefined || expected === entry?.record, startedAt: fromJob?.startedAt ?? null,
      incarnation: fromJob?.incarnation ?? null, currentStartedAt: entry?.identity.startedAt ?? null,
      currentIncarnation: entry?.identity.incarnation ?? null});
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
    if (this.#startups.get(threadId)?.pid === pid) this.finishStartup(threadId);
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
    this.#live.get(threadId)?.delete(pid);
    processEventDiagnostic('registry.exit-accepted', {threadId, pid, native: fromJob !== undefined, code,
      startedAt: entry.identity.startedAt, incarnation: entry.identity.incarnation});
    const known = this.known.get(threadId)?.get(pid);
    if (known !== undefined && known.identity === entry.identity) known.exitedAt = Date.now();
    if ((this.#live.get(threadId)?.size ?? 0) === 0) {
      this.#lastLoad.delete(threadId); this.#lastPushed.delete(threadId);
      this.#resources.forget(threadId);
    }
    this.#forgetWhenIdle(threadId);
    this.platform.pidRemoved(threadId, pid, !this.#shown.has(threadId));
    if (this.#journal.isClosed()) return;
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
    traceWrite(this.#bus, threadId, () => this.#journal.finishProcess(record));

    this.#bus.emit('process.exited', { ...record });
  }

  /**
   * A thread whose last process exited is forgotten, entry and pid history
   * alike, after a moment: a job event for one of those pids can still be in
   * flight, and `known` tells it from a grandchild. Otherwise every thread the
   * core ran stays in the maps the load tick walks, and a caller minting an id
   * per call (the plugin store) grows them without bound.
   */
  #forgetWhenIdle(threadId: ThreadId): void {
    if ((this.#live.get(threadId)?.size ?? 0) > 0) return;
    if (this.forgetTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.forgetTimers.delete(threadId);
      if ((this.#live.get(threadId)?.size ?? 0) > 0) return;
      this.#live.delete(threadId);
      this.known.delete(threadId); this.#shown.delete(threadId);
      this.#lastLoad.delete(threadId);
      this.memory.forgetThrottle(threadId);
      this.#resources.forget(threadId);
      this.#lastPushed.delete(threadId);
      // The thread's Job Object too: an id minted per call would otherwise hold
      // one kernel handle for the life of the core.
      this.platform.forget(threadId);
      if (!this.#journal.isClosed()) traceWrite(this.#bus, threadId, () => { this.#journal.forgetProcessesWithoutThread(threadId); this.#journal.pruneProcesses(threadId); });
    }, this.#forgetDelayMs);
    timer.unref();
    this.forgetTimers.set(threadId, timer);
  }

  /**
   * A thread that never goes idle (a terminal running a watcher, a persistent
   * agent) would otherwise keep every pid it ever traced. A late job event
   * arrives within seconds, so an exit older than the forget delay is dropped.
   */
  #forgetExited(threadId: ThreadId, byPid: Map<number, Entry>, now: number): void {
    const known = this.known.get(threadId);
    if (known === undefined) return;
    for (const [pid, process] of known) {
      if (process.exitedAt !== undefined && now - process.exitedAt >= this.#forgetDelayMs && !byPid.has(pid)) known.delete(pid);
    }
  }

  #measure(threadId: ThreadId, processes: number, memory?: MemoryProcess[]): ThreadLoad {
    const sample = this.platform.sample(threadId);
    this.#resources.sample(threadId, sample);
    if (sample === null) return { processes, cpuPercent: 0, memoryBytes: 0 };
    for (const measured of sample.workingSets ?? []) {
      const entry = this.#live.get(threadId)?.get(measured.pid);
      if (entry !== undefined) memory?.push({ threadId, pid: measured.pid, exe: entry.record.exe, bytes: measured.committedBytes ?? measured.bytes, root: entry.root });
      else if (this.capability().os !== 'windows') memory?.push({ threadId, pid: measured.pid, exe: measured.exe ?? 'process', bytes: measured.bytes, root: false });
    }
    return { processes, cpuPercent: sample.cpuPercent, memoryBytes: sample.memoryBytes };
  }

  private sampleLoad(): void {
    if (this.#journal.isClosed()) return;
    this.#resources.sync();
    const now = Date.now();
    this.#resources.sampledAt = now;
    const processes: MemoryProcess[] = [];
    const sweepKnown = now - this.#knownSweptAt >= this.#forgetDelayMs;
    if (sweepKnown) this.#knownSweptAt = now;
    let busy = false;
    let live = false;
    for (const [threadId, byPid] of this.#live) {
      if (byPid.size === 0) continue;
      live = true;
      if (sweepKnown) this.#forgetExited(threadId, byPid, now);
      const load = this.#measure(threadId, byPid.size, processes);
      const previous = this.#lastLoad.get(threadId);
      if (previous === undefined || previous.processes !== load.processes || load.cpuPercent >= BUSY_CPU_PERCENT) busy = true;
      this.#lastLoad.set(threadId, load);
      this.memory.sampleThrottle(threadId, byPid.values());
      if (!worthPushing(this.#lastPushed.get(threadId), load)) continue;
      this.#lastPushed.set(threadId, load);
      // A terminal, the devices or the browser have no row to patch.
      if (this.#journal.getThread(threadId) === null) continue;
      this.#bus.emit('thread.load', { threadId, load });
    }
    this.#loadBusy = busy;
    for (const threadId of [...this.#lastLoad.keys()]) {
      if ((this.#live.get(threadId)?.size ?? 0) > 0) continue;
      this.#lastLoad.delete(threadId);
      this.#resources.forget(threadId);
      this.#lastPushed.delete(threadId);
    }
    if (this.#resources.active) this.platform.finishResources?.();
    // No agent process: nothing to kill, and recovery from pressure still gets its samples.
    if (!live && this.memory.state === 'ok') { this.memory.rest(); return; }
    this.memory.sample(processes.reduce((sum, process) => sum + process.bytes, 0), processes, (victim) => {
      const entry = this.#live.get(victim.threadId)?.get(victim.pid);
      if (entry?.root) return false;
      if (this.capability().os === 'windows') return entry !== undefined && this.platform.terminateProcess(victim.threadId, victim.pid);
      try {
        if (entry === undefined) return this.platform.terminateProcess(victim.threadId, victim.pid);
        this.#trackStop(entry.kill() ?? undefined);
        return true;
      } catch {
        return false;
      }
    });
  }
}

/** Whether `proc` runs as its spawner sees it: until it reports the exit it holds the process's handle. */
const running = (proc: { exitCode: number | null; signalCode: unknown }) => () => proc.exitCode === null && proc.signalCode === null;

/** An entry's own kill, and the group stop that may follow it. */
function killEntry(entry: Entry): Promise<void> | undefined {
  try { return entry.kill() ?? undefined; } catch { return undefined; /* already exited */ }
}
