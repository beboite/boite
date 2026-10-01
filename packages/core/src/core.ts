import { existsSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PROTOCOL_VERSION } from '@boite/contracts';
import type { Channel, CoreInfo, ThreadId } from '@boite/contracts';
import pkg from '../package.json';
import { AccountStore } from './accounts.ts';
import { AgentStore } from './agents/store.ts';
import { AgentRuntime } from './agents/runtime.ts';
import { AgentTokens } from './agent.ts';
import { FileTickets } from './workdir.ts';
import { Bus } from './bus.ts';
import { shutdownDrivers } from './drivers/index.ts';
import { ImportStore } from './imports.ts';
import { Journal, scheduleEventRetention } from './journal.ts';
import { KeybindingStore } from './keybindings.ts';
import { registerModules } from './modules.ts';
import { currentOs } from './paths.ts';
import { lanAddress } from './server/lan.ts';
import { ProcRegistry } from './procs.ts';
import { withLoad } from './threads/records.ts';
import { ProjectStore } from './projects.ts';
import { ProviderRegistry } from './providers/loader.ts';
import { Router } from './router.ts';
import { Scheduler } from './scheduler.ts';
import { SessionStore } from './sessions.ts';
import { SettingsStore } from './settings.ts';
import { ThreadStore } from './threads.ts';
import { scheduleThreadDeletionRetention } from './threads/deletion-retention.ts';
import { QuotaStore } from './quotas.ts';
import { PluginStore } from './plugins.ts';
import { Worktrees } from './worktree.ts';
import { ActivityStore } from './activity.ts';
import { PushStore } from './push.ts';
import { SpeechStore } from './speech.ts';
import { Telemetry } from './telemetry.ts';
import { HarnessUpdates } from './providers/updates.ts';
import { Coordination } from './coordination.ts';
import { Delegation } from './delegation.ts';
import { Workflows } from './workflows.ts';
import { BrainStore } from './brain.ts';
import { HookLedger } from './hooks.ts';
import { TerminalStore } from './terminals.ts';
import { ServerUpdates, type ServerUpdateOptions } from './server-update.ts';

export const CORE_VERSION: string = pkg.version;

/** The server tells the core which threads a live socket is watching, and closes sockets on request. */
export interface SubscriptionSink {
  hasSubscribers(threadId: ThreadId): boolean;
  /** Every socket a revoked session holds goes, with the close code the client reads as "pair again". */
  closeSession(sessionId: string): void;
  /** Every socket an agent of this thread holds goes: the thread was archived or removed under it. */
  closeAgents(threadId: ThreadId): void;
}

export interface CoreOptions {
  serverUpdates?: ServerUpdateOptions;
  bundleHash?: string;
  dataDir: string;
  token: string;
  /** Which install this core belongs to. Absent means the stable one. */
  channel?: Channel;
  /** The executable owns process exit; embedded cores may omit it. */
  onShutdown?: () => void;
}

/**
 * Where the `boite` shim a thread's processes find on their PATH lives.
 * `BOITE_CLI_DIR` decides when it is set. An installed core is the compiled
 * `boite-core`, and the shim is staged beside it. Desktop packages whose
 * resources live elsewhere set BOITE_CLI_DIR from the shell. From the sources, it is
 * `packages/core/bin`, which is one directory up from here whether this runs
 * from `src` or from `dist`. Anything else has no CLI to offer and says so
 * with null rather than putting a directory that holds nothing on PATH. A
 * `BOITE_CLI_DIR` that holds no shim is a mistake somebody made on purpose, so
 * it stops the core instead of giving every agent a PATH that finds nothing.
 */
export function resolveCliDir(
  env: Record<string, string | undefined> = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const shim = platform === 'win32' ? 'boite.cmd' : 'boite';
  const named = env.BOITE_CLI_DIR;
  if (named !== undefined && named.length > 0) {
    if (!existsSync(join(named, shim))) {
      throw new Error(`BOITE_CLI_DIR is ${named}, which holds no ${shim}: expected the directory of the boite shims`);
    }
    return named;
  }
  if (basename(execPath).startsWith('boite-core')) {
    const beside = dirname(execPath);
    return existsSync(join(beside, shim)) ? beside : null;
  }
  const fromSources = join(import.meta.dir, '..', 'bin');
  return existsSync(join(fromSources, shim)) ? fromSources : null;
}

export class Core {
  readonly version = CORE_VERSION;
  readonly bundleHash: string | undefined;
  readonly dataDir: string;
  readonly token: string;
  readonly channel: Channel;
  readonly startedAt = Date.now();

  readonly bus: Bus;
  readonly journal: Journal;
  readonly router: Router;
  readonly settings: SettingsStore;
  readonly providers: ProviderRegistry;
  readonly accounts: AccountStore;
  readonly workforce: AgentStore;
  readonly agentRuntime: AgentRuntime;
  readonly projects: ProjectStore;
  readonly procs: ProcRegistry;
  readonly scheduler: Scheduler;
  readonly threads: ThreadStore;
  readonly quotas: QuotaStore;
  readonly plugins: PluginStore;
  readonly sessions: SessionStore;
  readonly worktrees: Worktrees;
  readonly keybindings: KeybindingStore;
  readonly imports: ImportStore;
  readonly activity: ActivityStore;
  readonly push: PushStore;
  /** The per-thread tokens the agents of this core say hello with. */
  readonly agents = new AgentTokens();
  /** The one-shot urls `files.read` hands out for what it cannot send inline. */
  readonly fileTickets = new FileTickets();
  /** Where the `boite` shim is, prepended to the PATH of every process a thread launches. */
  readonly cliDir: string | null = resolveCliDir();
  readonly speech: SpeechStore;
  readonly telemetry: Telemetry;
  readonly updates: HarnessUpdates;
  readonly serverUpdates: ServerUpdates;
  readonly coordination: Coordination;
  readonly delegation: Delegation;
  readonly workflows: Workflows;
  readonly brain: BrainStore;
  /** What the user's own hooks did since this core started, for Settings. */
  readonly hooks: HookLedger;
  readonly terminals: TerminalStore;

  /**
   * The server tells the core what it alone can know. The default answers no
   * to everything, which is what a core with no socket open should say:
   * `panel.open` then reports that nobody saw the request.
   */
  subscribers: SubscriptionSink = {
    hasSubscribers: () => false,
    closeSession: () => undefined,
    closeAgents: () => undefined,
  };

  private endpoint = { host: '127.0.0.1', port: 0 };
  #onShutdown: (() => void) | undefined;
  #shutdownRequested = false;
  #idleShutdownAdmitted = false;

  /** An update may stop only between executions. Admission and the gates share one event-loop turn. */
  requestIdleShutdown(beforeShutdown?: () => void): 'accepted' | 'busy' | 'unsupported' {
    if (!this.#onShutdown) return 'unsupported';
    if (this.#idleShutdownAdmitted) return 'accepted';
    if (this.#shutdownRequested || this.#stopping) return 'busy';
    const scheduler = this.scheduler.state();
    const threads = this.threads;
    if (this.router.activeRequests > 0 || scheduler.running.length > 0 || scheduler.queued.length > 0
      || this.agentRuntime.busy || this.procs.liveThreads().length > 0
      || threads.runner.handles.size > 0 || threads.runner.steering.size > 0
      || threads.deferred.pendingWakes.size > 0 || threads.deferred.deferredAnswers.size > 0
      || [...threads.agentState.background.values()].some(tasks => tasks.length > 0)) return 'busy';
    // Persist an updater's acknowledgement before closing admission or scheduling exit.
    beforeShutdown?.();
    this.#idleShutdownAdmitted = true;
    this.#stopping = true;
    this.threads.focus.close();
    this.router.stopAccepting();
    this.procs.stopAccepting();
    this.requestShutdown();
    return 'accepted';
  }

  /**
   * A restart that does not wait for idle: each running turn ends the tool
   * call it is in, 30 seconds at most, then stops, and the next core resumes
   * those threads (`threads/handoff.ts`). No new turn starts meanwhile; the
   * RPC surface stays open so a tool that calls `boite` can still finish.
   */
  requestHandoffShutdown(graceMs?: number): 'accepted' | 'unsupported' {
    if (!this.#onShutdown) return 'unsupported';
    if (this.#shutdownRequested || this.threads.handoff.active) return 'accepted';
    this.#stopping = true;
    void this.threads.handoff.begin(graceMs).then(() => this.requestShutdown());
    return 'accepted';
  }

  /**
   * Asks the process to stop the way `core.shutdown` does: the answer goes out
   * first, then the process drains and exits. False for an embedded core,
   * which has no process of its own to stop. `POST /shutdown` calls it too,
   * which is how the desktop shell and its installer stop a resident core.
   */
  requestShutdown(): boolean {
    const stop = this.#onShutdown;
    if (!stop) return false;
    if (!this.#shutdownRequested) {
      this.#shutdownRequested = true;
      // Leave time for the acknowledgement before the socket is closed.
      setTimeout(stop, 25).unref();
    }
    return true;
  }

  constructor(options: CoreOptions) {
    this.bundleHash = options.bundleHash;
    this.dataDir = options.dataDir;
    this.token = options.token;
    this.channel = options.channel ?? 'stable';
    mkdirSync(this.dataDir, { recursive: true });

    this.bus = new Bus();
    this.bus.onError = (message) => this.log('error', message);
    this.journal = new Journal(join(this.dataDir, 'journal.db'), { onError: (message) => this.log('error', message) });
    this.#stopRetention = scheduleEventRetention(this.journal, (message) => this.log('error', message));
    this.router = new Router();
    this.settings = new SettingsStore(this);
    this.providers = new ProviderRegistry(this.dataDir);
    this.accounts = new AccountStore(this);
    this.projects = new ProjectStore(this);
    this.procs = new ProcRegistry(this.journal, this.bus, undefined, { summarize: (thread) => withLoad(this, thread) });
    this.scheduler = new Scheduler(this);
    this.threads = new ThreadStore(this);
    this.quotas = new QuotaStore(this);
    this.plugins = new PluginStore(this);
    this.sessions = new SessionStore(this);
    this.worktrees = new Worktrees(this);
    this.keybindings = new KeybindingStore(this);
    this.imports = new ImportStore(this);
    this.activity = new ActivityStore(this);
    this.push = new PushStore(this);
    this.speech = new SpeechStore(this);
    this.telemetry = new Telemetry(this);
    this.updates = new HarnessUpdates(this);
    this.serverUpdates = new ServerUpdates(this, options.serverUpdates);
    this.coordination = new Coordination(this);
    this.delegation = new Delegation(this);
    this.workflows = new Workflows(this);
    this.brain = new BrainStore(this);
    this.hooks = new HookLedger(this);
    this.terminals = new TerminalStore(this);

    this.workforce = new AgentStore(this);
    registerModules(this);
    this.#onShutdown = options.onShutdown;
    this.router.register('core.shutdown', () => {
      if (!this.requestShutdown()) throw new Error('This embedded core does not support process shutdown.');
      return { ok: true as const };
    });
    this.procs.applySettings(this.settings.get());
    this.accounts.ensureDefaults();
    this.#stopDeletionRetention = scheduleThreadDeletionRetention(this);
    // The journal is open and no socket is accepted yet: whatever a dead core
    // left running or queued is closed here, or nothing ever would.
    this.threads.recoverStuckTurns();
    this.threads.cards.restoreAsyncQuestions();
    queueMicrotask(() => this.threads.titles.recover());
    this.agentRuntime = new AgentRuntime(this);
    this.brain.start();
  }

  setEndpoint(host: string, port: number): void {
    this.endpoint = { host, port };
  }

  displayHost(): string {
    return this.endpoint.host === '0.0.0.0' ? '127.0.0.1' : this.endpoint.host;
  }

  baseUrl(): string {
    return `http://${this.displayHost()}:${this.endpoint.port}`;
  }

  /**
   * The address a pairing link names. A core listening on every interface is
   * reached from a phone through this machine's LAN address: 127.0.0.1 on the
   * phone is the phone.
   */
  reachableUrl(): string {
    const everywhere = this.endpoint.host === '0.0.0.0' || this.endpoint.host === '::';
    const lan = everywhere ? lanAddress() : null;
    return lan === null ? this.baseUrl() : `http://${lan}:${this.endpoint.port}`;
  }

  info(): CoreInfo {
    return {
      version: this.version,
      ...(this.bundleHash ? { bundleHash: this.bundleHash } : {}),
      protocolVersion: PROTOCOL_VERSION,
      hostname: hostname(),
      os: currentOs(),
      channel: this.channel,
      pid: process.pid,
      startedAt: this.startedAt,
      endpoint: { ...this.endpoint },
      dataDir: this.dataDir,
      trace: this.procs.capability(),
    };
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.bus.emit('core.log', { level, message, at: Date.now() });
  }

  /**
   * Shutdown, first half. The scheduler stops what runs and waits for it while
   * the sockets are still open and the bus still has its listeners, so a turn
   * that ends during shutdown still reaches the clients watching it. Closing
   * the server first emitted `turn.finished` to nobody.
   */
  drain(timeoutMs?: number): Promise<void> {
    if (this.#drainPromise !== null) return this.#drainPromise;
    this.#stopping = true;
    this.delegation.beginClose();
    this.workflows.beginClose();
    this.coordination.beginClose();
    this.activity.close();
    this.#drainPromise = this.agentRuntime.close().then(() => this.scheduler.drain(timeoutMs));
    return this.#drainPromise;
  }

  #stopRetention: () => void;
  #stopDeletionRetention: () => void;

  /** Share both an active wait and its completion across shutdown phases. */
  #drainPromise: Promise<void> | null = null;
  #stopping = false;

  get stopping(): boolean { return this.#stopping; }

  async close(): Promise<void> {
    this.threads.titles.close();
    await this.agentRuntime.close();
    this.#stopping = true;
    await this.brain.close();
    this.updates.close();
    this.serverUpdates.close();
    await this.drain();
    await this.delegation.close();
    await this.coordination.close();
    await this.speech.close();
    await this.push.close();
    await this.plugins.close();
    this.providers.installs.stop();
    shutdownDrivers();
    await this.accounts.closeLogins();
    await this.terminals.closeAll();
    // Off Windows this waits out the SIGKILL of a group that ignored SIGTERM,
    // two seconds at most: the timer that sends it dies with the process.
    await this.procs.killAll();
    // The guard Worker unmutes what it held on its way out; `main` exits as soon
    // as this resolves, so that has to be over first.
    await this.procs.close();
    this.keybindings.close();
    await this.telemetry.close();
    this.bus.dispose();
    this.#stopRetention();
    this.#stopDeletionRetention();
    this.journal.close();
  }
}
