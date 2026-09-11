import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@boite/contracts';
import type { Channel, CoreInfo, ThreadId } from '@boite/contracts';
import pkg from '../package.json';
import { AccountStore } from './accounts.ts';
import { Bus } from './bus.ts';
import { shutdownDrivers } from './drivers/index.ts';
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

export const CORE_VERSION: string = pkg.version;

/** The server tells the core which threads a live socket is watching, and closes sockets on request. */
export interface SubscriptionSink {
  hasSubscribers(threadId: ThreadId): boolean;
  /** Every socket a revoked session holds goes, with the close code the client reads as "pair again". */
  closeSession(sessionId: string): void;
}

export interface CoreOptions {
  dataDir: string;
  token: string;
  /** Which install this core belongs to. Absent means the stable one. */
  channel?: Channel;
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

  subscribers: SubscriptionSink = { hasSubscribers: () => false, closeSession: () => undefined };

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

  /** A fresh one-time pairing link: what the ready line prints and the Settings page mints. */
  pairingUrl(): string {
    return this.sessions.grant().url;
  }

  info(): CoreInfo {
    return {
      version: this.version,
      protocolVersion: PROTOCOL_VERSION,
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

  async close(): Promise<void> {
    await this.plugins.close();
    await this.scheduler.drain();
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
