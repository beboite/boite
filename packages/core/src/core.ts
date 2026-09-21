import { existsSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PROTOCOL_VERSION } from '@boite/contracts';
import type { Channel, CoreInfo, ThreadId } from '@boite/contracts';
import pkg from '../package.json';
import { AccountStore } from './accounts.ts';
import { AgentTokens } from './agent.ts';
import { FileTickets } from './workdir.ts';
import { Bus } from './bus.ts';
import { shutdownDrivers } from './drivers/index.ts';
import { ImportStore } from './imports.ts';
import { Journal } from './journal.ts';
import { KeybindingStore } from './keybindings.ts';
import { registerModules } from './modules.ts';
import { currentOs } from './paths.ts';
import { ProcRegistry } from './procs.ts';
import { ProjectStore } from './projects.ts';
import { ProviderRegistry } from './providers/loader.ts';
import { Router } from './router.ts';
import { Scheduler } from './scheduler.ts';
import { SessionStore } from './sessions.ts';
import { SettingsStore } from './settings.ts';
import { ThreadStore } from './threads.ts';
import { QuotaStore } from './quotas.ts';
import { PluginStore } from './plugins.ts';
import { Worktrees } from './worktree.ts';
import { ActivityStore } from './activity.ts';
import { PushStore } from './push.ts';
import { SpeechStore } from './speech.ts';
import { HarnessUpdates } from './providers/updates.ts';
import { Coordination } from './coordination.ts';

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
  dataDir: string;
  token: string;
  /** Which install this core belongs to. Absent means the stable one. */
  channel?: Channel;
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
  readonly updates: HarnessUpdates;
  readonly coordination: Coordination;

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

  constructor(options: CoreOptions) {
    this.dataDir = options.dataDir;
    this.token = options.token;
    this.channel = options.channel ?? 'stable';
    mkdirSync(this.dataDir, { recursive: true });

    this.bus = new Bus();
    this.journal = new Journal(join(this.dataDir, 'journal.db'));
    this.router = new Router();
    this.settings = new SettingsStore(this);
    this.providers = new ProviderRegistry(this.dataDir);
    this.accounts = new AccountStore(this);
    this.projects = new ProjectStore(this);
    this.procs = new ProcRegistry(this.journal, this.bus);
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
    this.updates = new HarnessUpdates(this);
    this.coordination = new Coordination(this);

    registerModules(this);
    this.procs.applySettings(this.settings.get());
    this.accounts.ensureDefaults();
    // The journal is open and no socket is accepted yet: whatever a dead core
    // left running or queued is closed here, or nothing ever would.
    this.threads.recoverStuckTurns();
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

  info(): CoreInfo {
    return {
      version: this.version,
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
  async drain(timeoutMs?: number): Promise<void> {
    this.coordination.beginClose();
    this.#drained = true;
    await this.scheduler.drain(timeoutMs);
  }

  /** Whether the wait above has already been spent, so `close()` does not spend a second one. */
  #drained = false;

  async close(): Promise<void> {
    this.updates.close();
    this.coordination.beginClose();
    // Reuse the shutdown wait already spent by drain(), while stopping late arrivals.
    await this.scheduler.drain(this.#drained ? 0 : undefined);
    await this.coordination.close();
    await this.speech.close();
    await this.push.close();
    this.activity.close();
    await this.plugins.close();
    this.providers.installs.stop();
    shutdownDrivers();
    await this.accounts.closeLogins();
    this.procs.killAll();
    this.procs.close();
    this.keybindings.close();
    this.bus.dispose();
    this.journal.close();
  }
}
