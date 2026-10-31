import { PolicyStore, policyFileFor } from './policy.ts';
import { MergedPrArchive } from './merged-pr-archive.ts';
import { PullRequests } from './pull-requests.ts';
import { LinkedPullRequests } from './linked-pull-requests.ts';
import { PullRequestWatches, type WatchTiming } from './pull-request-watch.ts';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PROTOCOL_VERSION } from '@boite/contracts';
import type { Channel, CoreInfo, CoreLogContext, ThreadId, UiRevealTarget } from '@boite/contracts';
import { CORE_VERSION } from './version.ts';
import { AccountStore } from './accounts.ts';
import { AgentStore } from './agents/store.ts';
import { AgentRuntime } from './agents/runtime.ts';
import { AgentTokens } from './agent.ts';
import { FileTickets } from './workdir.ts';
import { MediaPreviews } from './media.ts';
import { Bus } from './bus.ts';
import { shutdownDrivers } from './drivers/index.ts';
import { ImportStore } from './imports.ts';
import { Journal } from './journal.ts';
import { scheduleEventRetention, scheduleInlineValueMoves } from './journal/retention.ts';
import { KeybindingStore } from './keybindings.ts';
import { DiagnosticLogs, type ThreadIdentity } from './logs.ts';
import { Diagnostics } from './diagnostics.ts';
import { registerModules } from './modules.ts';
import { currentOs, machineName } from './paths.ts';
import { lanAddress } from './server/lan.ts';
import { ProcRegistry } from './procs.ts';
import { attachResourceLog } from './resource-log.ts';
import { ProjectStore } from './projects.ts';
import { PROVIDER_SWITCHES, ProviderRegistry } from './providers/loader.ts';
import { Router } from './router.ts';
import { Scheduler } from './scheduler.ts';
import { SessionStore } from './sessions.ts';
import { SettingsStore } from './settings.ts';
import { ClientPreferencesBook } from './client-preferences.ts';
import { eraseIncognitoRoot } from './threads/incognito.ts';
import { removeTranscripts } from './threads/transcript-purge.ts';
import { ThreadStore } from './threads.ts';
import { DraftPreparations } from './threads/draft-preparations.ts';
import { AttachmentUploads } from './attachment-uploads.ts';
import { scheduleThreadDeletionRetention } from './threads/deletion-retention.ts';
import { scheduleDoneRetention } from './threads/done-retention.ts';
import { WorktreeCleanup } from './worktree-cleanup.ts';
import { scheduleArtifactRetention } from './artifact-retention.ts';
import { ArtifactPreviews } from './artifact-preview.ts';
import { AgentBrowser, BROWSER_SCOPE } from './browser.ts';
import { MobileDevices } from './devices/control.ts';
import { VirtualDesktops } from './desktop/service.ts';
import { DesktopWindows } from './windows/service.ts';
import { LazyMcp } from './mcp/lazy.ts';
import { QuotaStore } from './quotas.ts';
import { dropRetiredAccounts } from './account-retirement.ts';
import { PluginStore } from './plugins.ts';
import { Worktrees } from './worktree.ts';
import { ActivityStore } from './activity.ts';
import { PushStore } from './push.ts';
import { SpeechStore } from './speech.ts';
import { Telemetry } from './telemetry.ts';
import { HarnessUpdates } from './providers/updates.ts';
import { Coordination } from './coordination.ts';
import { GroupStore, type NetworkSink } from './group.ts';
import { ContactStore } from './contacts/store.ts';
import { SharedProjects } from './contacts/projects.ts';
import { SharedBoard } from './contacts/board.ts';
import type { RelaySink } from './group/relay.ts';
import { Delegation } from './delegation.ts';
import { SharedCompute } from './contacts/compute.ts';
import { SharedAccess } from './contacts/access-policy.ts';
import { SharedReview } from './contacts/review.ts';
import { Workflows } from './workflows.ts';
import { BrainStore } from './brain.ts';
import { HookLedger } from './hooks.ts';
import { TerminalStore } from './terminals.ts';
import { openSecretVault } from './platform/secret-vault.ts';
import type { SecretVault } from './platform/types.ts';
import { SecretStore } from './secrets/store.ts';
import { ServerUpdates, type ServerUpdateOptions } from './server-update.ts';
import { DesktopUpdates } from './desktop-update.ts';
import { Composer } from './composer.ts';

export { CORE_VERSION } from './version.ts';

/** The server tells the core which threads a live socket is watching, and closes sockets on request. */
export interface SubscriptionSink {
  /** A window of the owner or a paired device has the thread open; an agent's or a plugin's subscription is no reader. */
  hasSubscribers(threadId: ThreadId): boolean;
  /** Every socket a revoked session holds goes, with the close code the client reads as "pair again". */
  closeSession(sessionId: string): void;
  /** Every socket an agent of this thread holds goes: the thread was archived or removed under it. */
  closeAgents(threadId: ThreadId): void;
  /** Sends `ui.reveal` to every owner connection; returns how many it reached. */
  reveal(target: UiRevealTarget): number;
}

export interface CoreOptions {
  serverUpdates?: ServerUpdateOptions;
  /** Tests shorten the pull request watch loop's waits. */
  pullRequestWatches?: Partial<WatchTiming>;
  bundleHash?: string;
  dataDir: string;
  token: string;
  /** Which install this core belongs to. Absent means the stable one. */
  channel?: Channel;
  /** The executable owns process exit; embedded cores may omit it. */
  onShutdown?: () => void;
  /** Whether the data directory is the channel's default or one a flag or BOITE_DATA_DIR named; the log never holds the path. */
  dataDirKind?: 'default' | 'custom';
  /** How often a resident core runs its retention passes; a test shortens the minute. */
  retentionPassMs?: number;
  /** Legacy vault cleanup only; tests substitute it so no system store is touched. */
  secretVault?: (dir: string) => Promise<SecretVault>;
  /** The admin policy file this core reads instead of the machine's (`policy.ts`); tests point it inside their data directory. */
  policyFile?: string;
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
  readonly logs: DiagnosticLogs;
  /** The administrator's policy file, read before anything it locks starts. */
  readonly policy: PolicyStore;
  readonly diagnostics: Diagnostics;
  readonly pullRequests: PullRequests;
  readonly linkedPullRequests: LinkedPullRequests;
  readonly mergedPrArchive: MergedPrArchive;
  readonly worktreeCleanup: WorktreeCleanup;
  readonly pullRequestWatches: PullRequestWatches;
  readonly journal: Journal;
  readonly router: Router;
  readonly settings: SettingsStore;
  /** What the user's apps say of themselves: language, experiments, the names they give settings. */
  readonly clients: ClientPreferencesBook;
  readonly providers: ProviderRegistry;
  readonly accounts: AccountStore;
  readonly workforce: AgentStore;
  readonly agentRuntime: AgentRuntime;
  readonly projects: ProjectStore;
  readonly procs: ProcRegistry;
  readonly scheduler: Scheduler;
  readonly threads: ThreadStore;
  readonly drafts: DraftPreparations;
  readonly composer: Composer;
  readonly attachmentUploads: AttachmentUploads;
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
  /** The blurs deferred pictures are drawn with before their bytes arrive. */
  readonly media = new MediaPreviews(this);
  /** Where the `boite` shim is, prepended to the PATH of every process a thread launches. */
  readonly cliDir: string | null = resolveCliDir();
  readonly speech: SpeechStore;
  readonly telemetry: Telemetry;
  readonly updates: HarnessUpdates;
  readonly serverUpdates: ServerUpdates;
  /** The desktop app's updater as this machine's own window reports it. */
  readonly desktopUpdates: DesktopUpdates;
  readonly coordination: Coordination;
  /** The machines this core trusts as one owner's, and what it hands their clients. */
  readonly group: GroupStore;
  /** Other owners' Boites linked for agent work on the projects each side opens. */
  readonly contacts: ContactStore;
  readonly sharedProjects: SharedProjects;
  readonly sharedBoard: SharedBoard;
  readonly sharedCompute: SharedCompute;
  readonly sharedAccess: SharedAccess;
  readonly sharedReview: SharedReview;
  readonly delegation: Delegation;
  readonly workflows: Workflows;
  readonly brain: BrainStore;
  /** What the user's own hooks did since this core started, for Settings. */
  readonly hooks: HookLedger;
  readonly terminals: TerminalStore;
  readonly secrets: SecretStore;
  readonly stopArtifactRetention: () => Promise<void>;
  readonly artifactPreviews = new ArtifactPreviews(this);
  readonly browser = new AgentBrowser(this);
  /** Simulators and emulators open in conversations' Device panels. */
  readonly devices = new MobileDevices(this);
  readonly windows = new DesktopWindows(this);
  /** Conversations' private X desktops for GUI apps (docs/desktop.md). */
  readonly desktops = new VirtualDesktops(this);
  /** The user's stdio MCP servers, started when a conversation first calls one (`mcp/lazy.ts`). */
  readonly lazyMcp = new LazyMcp(this);

  /**
   * The server tells the core what it alone can know. The default answers no
   * to everything, which is what a core with no socket open should say:
   * `panel.open` then reports that nobody saw the request.
   */
  subscribers: SubscriptionSink = {
    hasSubscribers: () => false,
    closeSession: () => undefined,
    closeAgents: () => undefined,
    reveal: () => 0,
  };

  /** The server answers on one more address when a group asks; a core with no server answers on none. */
  network: NetworkSink = { also: () => false };

  /** The clients this core carries to other members of its group (`group/relay.ts`); none without a server. */
  relays: RelaySink = { size: 0, sweep: () => undefined };

  private endpoint = { host: '127.0.0.1', port: 0 };
  #onShutdown: (() => void) | undefined;
  #shutdownRequested = false;
  #idleShutdownAdmitted = false;

  /** An update may stop only between executions. Admission and the gates share one event-loop turn. */
  requestIdleShutdown(beforeShutdown?: () => void): 'accepted' | 'busy' | 'unsupported' {
    if (!this.#onShutdown) return 'unsupported';
    if (this.#idleShutdownAdmitted) return 'accepted';
    if (this.#shutdownRequested || this.#stopping) return 'busy';
    if (!this.idle()) return 'busy';
    // Persist an updater's acknowledgement before closing admission or scheduling exit.
    beforeShutdown?.();
    this.logs.info('Idle shutdown accepted: no turn, request or agent process is running', { source: 'core', event: 'core.idle-shutdown.accepted' });
    this.#idleShutdownAdmitted = true;
    this.#stopping = true;
    this.threads.focus.close();
    this.router.stopAccepting();
    this.procs.stopAccepting();
    this.requestShutdown();
    return 'accepted';
  }

  /**
   * The server update's way out when the machine never goes idle: a busy
   * server (an agent working for hours, a resident agent) held the idle gate
   * shut for good. An agent install still half-written refuses, since the
   * restart would replace the core under it; anything else is handed to the
   * next core (`requestHandoffShutdown`), which resumes the running turns.
   */
  requestUpdateHandoff(beforeShutdown?: () => void): 'accepted' | 'busy' | 'unsupported' {
    if (!this.#onShutdown) return 'unsupported';
    if (this.#idleShutdownAdmitted) return 'accepted';
    if (this.#shutdownRequested || this.#stopping || this.updates.busy) return 'busy';
    beforeShutdown?.();
    this.logs.info('Update handoff accepted: running turns end their tool call, then resume after the restart', { source: 'core', event: 'core.update-handoff.accepted' });
    this.#idleShutdownAdmitted = true;
    this.requestHandoffShutdown();
    return 'accepted';
  }

  /** No turn, request, agent process, background task or agent install is under way. */
  private idle(): boolean {
    const scheduler = this.scheduler.state();
    const threads = this.threads;
    if (this.router.activeRequests > 0 || scheduler.running.length > 0 || scheduler.queued.length > 0
      // An agent's open tab is not work under way: its browser stays up after the turn and would hold an
      // update back for good. Closing saves each profile's cookies; a browser command in flight is an active request.
      || this.agentRuntime.busy || this.procs.liveThreads().some(scope => scope !== BROWSER_SCOPE)
      || threads.sideQuestions.busy || this.sharedReview.busy || this.updates.busy
      || threads.runner.handles.size > 0 || threads.runner.steering.size > 0
      || threads.deferred.pendingWakes.size > 0 || threads.deferred.deferredAnswers.size > 0 || threads.deferred.consumed.size > 0
      || [...threads.agentState.background.values()].some(tasks => tasks.length > 0)) return false;
    return true;
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
    const running = this.scheduler.state().running.length;
    this.logs.info(`Restart handoff started: ${running} running turns end their tool call, then stop`, { source: 'core', event: 'core.handoff.started', data: { running, graceMs: graceMs ?? null } });
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
    this.logs = new DiagnosticLogs(this.dataDir, [this.token]);
    this.logs.attach(this.bus);
    this.bus.onError = (message) => this.log('error', message);
    this.policy = new PolicyStore(policyFileFor(options.policyFile), {
      log: (level, message, data) => this.logs[level](message, { source: 'policy', event: 'policy.read', data }),
      changed: (state) => this.bus.emit('policy.changed', state),
    });
    let phaseAt = performance.now();
    const phase = (event: string, message: string, data?: Record<string, string | number | boolean | null>): void => {
      const now = performance.now();
      this.logs.info(`${message} in ${Math.round(now - phaseAt)} ms`, { source: 'startup', event, durationMs: now - phaseAt, ...(data ? { data } : {}) });
      phaseAt = now;
    };
    this.journal = new Journal(join(this.dataDir, 'journal.db'), { onError: (message) => this.log('error', message) });
    const schema = this.journal.schema;
    phase('startup.journal-opened', schema.from === schema.to ? `Journal opened at schema ${schema.to}` : `Journal opened and migrated from schema ${schema.from} to ${schema.to}`,
      { schemaFrom: schema.from, schemaTo: schema.to, dataDir: options.dataDirKind ?? 'custom', channel: this.channel });
    this.logs.describeThread = threadIdentities(this.journal);
    this.diagnostics = new Diagnostics(this);
    this.stopArtifactRetention = scheduleArtifactRetention(this);
    // The journal just erased every incognito conversation; their folders follow.
    eraseIncognitoRoot(this.dataDir, (message) => console.error(message));
    this.#stopRetention = scheduleEventRetention(this.journal, (message) => this.log('error', message));
    this.#stopMoves = scheduleInlineValueMoves(this.journal, (message) => this.log('error', message));
    this.router = new Router();
    this.settings = new SettingsStore(this);
    this.clients = new ClientPreferencesBook(
      (preferences, before) => this.threads.cards.settleClient(preferences, before),
      (experiments) => this.bus.emit('client.desktopExperiments', { experiments }),
    );
    this.providers = new ProviderRegistry(this.dataDir);
    this.providers.loadSwitches(this.journal.getSetting(PROVIDER_SWITCHES));
    this.providers.policyBlock = (id) => {
      const key = this.policy.providerBlock(id);
      return key === null ? null : { policy: key, file: this.policy.file };
    };
    this.accounts = new AccountStore(this);
    this.projects = new ProjectStore(this);
    this.procs = new ProcRegistry(this.journal, this.bus, undefined, {
      diagnostic: (message, context) => this.logs.warn(message, { source: 'guards', ...context }),
    });
    attachResourceLog(this);
    this.scheduler = new Scheduler(this);
    this.threads = new ThreadStore(this);
    // Read before any recovery writes, the team and workflow ones included: whether the previous core died at work within the hour.
    this.threads.autoContinue.previousRunCut();
    this.drafts = new DraftPreparations(this);
    this.attachmentUploads = new AttachmentUploads(this.dataDir);
    this.quotas = new QuotaStore(this);
    this.plugins = new PluginStore(this);
    this.sessions = new SessionStore(this);
    this.worktrees = new Worktrees(this);
    // No thread row lands and no process starts in a checkout a removal holds, whichever path asks (`checkouts.ts`).
    this.journal.admitThread = (thread) => this.worktrees.reservations.admit(thread);
    this.procs.admitCwd = (cwd) => this.worktrees.reservations.assertFree(cwd, 'a process');
    this.keybindings = new KeybindingStore(this);
    this.imports = new ImportStore(this);
    // The journal erased the incognito conversations the last core left behind; their transcripts follow.
    this.threads.transcriptPurge = removeTranscripts(this, this.journal.takeIncognitoSessions());
    // One scan of visible thread JSON serves activity and coordination recovery. It runs
    // where activity's own check ran, so a corrupt thread still fails before any recovery write.
    this.journal.validateVisibleThreadJson();
    this.activity = new ActivityStore(this, true);
    this.push = new PushStore(this);
    this.speech = new SpeechStore(this);
    this.telemetry = new Telemetry(this);
    this.updates = new HarnessUpdates(this);
    this.serverUpdates = new ServerUpdates(this, options.serverUpdates);
    this.desktopUpdates = new DesktopUpdates(this);
    this.coordination = new Coordination(this, true);
    this.group = new GroupStore(this);
    this.group.restore();
    this.contacts = new ContactStore(this);
    this.sharedProjects = new SharedProjects(this);
    this.sharedBoard = new SharedBoard(this);
    this.delegation = new Delegation(this);
    this.sharedCompute = new SharedCompute(this);
    this.sharedAccess = new SharedAccess(this);
    this.sharedReview = new SharedReview(this);
    this.workflows = new Workflows(this);
    this.brain = new BrainStore(this);
    this.hooks = new HookLedger(this);
    this.terminals = new TerminalStore(this);
    this.secrets = new SecretStore(this, options.secretVault ?? openSecretVault);
    this.logs.mask = text => this.secrets.maskAll(text);
    this.procs.mask = (threadId, text) => this.secrets.mask(threadId, text);

    this.workforce = new AgentStore(this);
    this.pullRequests = new PullRequests(this);
    this.linkedPullRequests = new LinkedPullRequests(this, (threadId, url, refresh) => this.pullRequests.detail(threadId, url, refresh));
    this.pullRequestWatches = new PullRequestWatches(this, (threadId, args) => this.pullRequests.gh(threadId, args), options.pullRequestWatches);
    registerModules(this);
    this.composer = new Composer(this);
    phase('startup.stores-ready', 'Stores and RPC handlers ready', { methods: this.router.methods().length });
    this.#onShutdown = options.onShutdown;
    this.router.register('core.shutdown', () => {
      if (!this.requestShutdown()) throw new Error('This embedded core does not support process shutdown.');
      return { ok: true as const };
    });
    this.router.register('core.restart', () => {
      if (this.requestHandoffShutdown() === 'unsupported') throw new Error('This embedded core does not support process shutdown.');
      return { ok: true as const };
    });
    this.procs.applySettings(this.settings.get());
    dropRetiredAccounts(this);
    this.accounts.ensureDefaults();
    this.accounts.recheckSignedOut();
    this.#stopDeletionRetention = scheduleThreadDeletionRetention(this, options.retentionPassMs);
    this.#stopDoneRetention = scheduleDoneRetention(this);
    // The journal is open and no socket is accepted yet: whatever a dead core
    // left running or queued is closed here, or nothing ever would.
    const interrupted = this.threads.agentState.backgroundHistory.interruptLive();
    const recovered = this.threads.recoverStuckTurns();
    // After recovery: a resume planned before the previous core stopped, a usage limit's among them, goes on.
    this.threads.resumes.start();
    // Watched limits are read on their own, so an alert reaches a phone with no window open.
    this.quotas.alerts.start();
    // What a dead core cut, and any resume planned before it died, goes on (`threads/auto-continue.ts`).
    this.threads.autoContinue.start(interrupted);
    this.threads.cards.restoreAsyncQuestions();
    this.secrets.start();
    phase('startup.recovered', `Previous run recovered, ${recovered} unfinished turns`, { stuckTurns: recovered });
    queueMicrotask(() => {
      void this.drafts.recover().catch(error => this.log('warn', `draft recovery failed: ${String(error)}`));
      void this.attachmentUploads.recover().catch(error => this.log('warn', `attachment recovery failed: ${String(error)}`));
    });
    queueMicrotask(() => this.threads.titles.recover());
    this.agentRuntime = new AgentRuntime(this);
    queueMicrotask(() => this.composer.start());
    this.brain.start();
    this.mergedPrArchive = new MergedPrArchive(this, this.pullRequests);
    this.mergedPrArchive.start();
    this.worktreeCleanup = new WorktreeCleanup(this);
    this.worktreeCleanup.start();
    this.pullRequestWatches.start();
    this.delegation.retirements.sweep();
    this.logs.record('info', `Core ${this.version} started in ${Date.now() - this.startedAt} ms, ${process.platform} ${process.arch}, Bun ${process.versions.bun ?? 'unknown'}`, {
      source: 'core', event: 'core.started', durationMs: Date.now() - this.startedAt,
      data: { version: this.version, channel: this.channel, os: process.platform, arch: process.arch, bun: process.versions.bun ?? null, pid: process.pid, cliShim: this.cliDir !== null, trace: this.procs.capability().mode },
    });
  }

  setEndpoint(host: string, port: number): void {
    this.logs.info(`Listening on ${host}:${port}`, { source: 'core', event: 'core.listening', data: { port } });
    this.endpoint = { host, port };
  }

  /** What the server bound, a wildcard included. */
  boundEndpoint(): { host: string; port: number } {
    return { ...this.endpoint };
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
    // A machine of a group gives the address the group gives for it: its
    // tailnet name when it has one, which a phone on the tailnet reaches from anywhere.
    const grouped = this.group.ownAddress();
    if (grouped !== null) return grouped;
    const everywhere = this.endpoint.host === '0.0.0.0' || this.endpoint.host === '::';
    const lan = everywhere ? lanAddress() : null;
    return lan === null ? this.baseUrl() : `http://${lan}:${this.endpoint.port}`;
  }

  info(): CoreInfo {
    return {
      version: this.version,
      ...(this.bundleHash ? { bundleHash: this.bundleHash } : {}),
      protocolVersion: PROTOCOL_VERSION,
      features: { threadSnapshots: true, chunkedAnswers: true, readingPages: true, messagePositions: true, deferredToolParts: true, deviceKeys: true, draftPreparation: true, attachmentUploads: true, composerPersistence: true, revealMachines: true, loadEvents: true, desktopUpdates: true, gatewayMove: true, projectBoard: true, settingsHome: true, listChanges: true },
      coreId: this.coordination.card().coreId,
      hostname: machineName(),
      os: currentOs(),
      channel: this.channel,
      pid: process.pid,
      startedAt: this.startedAt,
      now: Date.now(),
      endpoint: { ...this.endpoint },
      dataDir: this.dataDir,
      trace: this.procs.capability(),
    };
  }

  log(level: 'info' | 'warn' | 'error', message: string, context: CoreLogContext = {}): void {
    this.bus.emit('core.log', { level, message, at: Date.now(), ...context });
  }

  /**
   * Shutdown, first half. The scheduler stops what runs and waits for it while
   * the sockets are still open and the bus still has its listeners, so a turn
   * that ends during shutdown still reaches the clients watching it. Closing
   * the server first emitted `turn.finished` to nobody.
   */
  drain(timeoutMs?: number): Promise<void> {
    if (this.#drainPromise !== null) return this.#drainPromise;
    // Stopped on purpose, not handed over: the next core resumes nothing this one cuts.
    if (!this.threads.handoff.active) this.threads.autoContinue.noteDeliberateStop();
    this.#stopping = true;
    this.delegation.beginClose();
    this.workflows.beginClose();
    this.coordination.beginClose();
    void this.mergedPrArchive.close();
    void this.worktreeCleanup.close();
    void this.pullRequestWatches.close();
    this.group.beginClose();
    this.contacts.beginClose();
    this.sharedProjects.beginClose();
    this.sharedBoard.beginClose();
    this.sharedCompute.beginClose();
    this.sharedReview.beginClose();
    this.activity.close();
    this.threads.autoCompact.close();
    this.threads.backgroundCompact.close();
    this.threads.cacheKeepalive.close();
    this.threads.resumes.close();
    this.threads.autoContinue.close();
    this.quotas.alerts.close();
    this.#drainPromise = this.agentRuntime.close().then(() => this.scheduler.drain(timeoutMs));
    return this.#drainPromise;
  }

  #stopRetention: () => void;
  #stopMoves: () => void;
  #stopDeletionRetention: () => void;
  #stopDoneRetention: () => Promise<void>;

  /** Share both an active wait and its completion across shutdown phases. */
  #drainPromise: Promise<void> | null = null;
  #stopping = false;

  get stopping(): boolean { return this.#stopping; }

  async close(): Promise<void> {
    this.composer.stop();
    const closingAt = performance.now();
    await this.browser.close();
    this.devices.stop();
    this.windows.stop();
    await this.desktops.stopAll();
    this.lazyMcp.close();
    this.artifactPreviews.stop();
    this.threads.sideQuestions.close();
    await this.mergedPrArchive.close();
    await this.worktreeCleanup.close();
    await this.pullRequestWatches.close();
    this.threads.titles.close();
    this.threads.autoCompact.close();
    this.threads.backgroundCompact.close();
    this.threads.cacheKeepalive.close();
    this.threads.resumes.close();
    this.threads.autoContinue.close();
    await this.threads.codeCheckpoints.close();
    await this.agentRuntime.close();
    this.workforce.close();
    this.#stopping = true;
    await this.#stopDoneRetention();
    await this.drafts.close().catch(error => this.log('warn', `draft shutdown cleanup failed: ${String(error)}`));
    await this.attachmentUploads.close().catch(error => this.log('warn', `attachment shutdown cleanup failed: ${String(error)}`));
    await this.brain.close();
    this.updates.close();
    this.providers.close();
    this.serverUpdates.close();
    this.desktopUpdates.close();
    this.policy.close();
    await this.drain();
    await this.delegation.close();
    await this.workflows.close();
    await this.coordination.close();
    await this.group.close();
    await this.contacts.close();
    await this.sharedProjects.close();
    await this.sharedBoard.close();
    await this.sharedCompute.close();
    await this.sharedReview.close();
    await this.delegation.worktrees.close();
    await this.speech.close();
    await this.push.close();
    await this.plugins.close();
    this.providers.installs.stop();
    if (!this.journal.isClosed()) {
      for (const threadId of this.threads.agentState.background.keys()) this.threads.agentState.cancelBackground(threadId);
    }
    shutdownDrivers();
    await this.composer.close();
    this.secrets.stop();
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
    this.#stopMoves();
    this.#stopDeletionRetention();
    await this.stopArtifactRetention();
    if (!this.journal.isClosed()) {
      // Incognito conversations end with the core. Their rows go now, while the
      // journal can still say which transcripts no other thread names.
      await this.threads.transcriptPurge;
      this.journal.purgeIncognitoThreads();
      await removeTranscripts(this, this.journal.takeIncognitoSessions());
    }
    this.journal.close();
    // Every agent is stopped by now, so nothing holds an incognito folder.
    eraseIncognitoRoot(this.dataDir, (message) => console.error(message));
    this.logs.record('info', `Core stopped after ${Math.round((Date.now() - this.startedAt) / 1000)} s up; closing took ${Math.round(performance.now() - closingAt)} ms`, { source: 'core', event: 'core.stopped', durationMs: performance.now() - closingAt, data: { uptimeS: Math.round((Date.now() - this.startedAt) / 1000) } });
    await this.logs.close();
  }
}

/**
 * Who each thread is, for the log records about it. A burst of records about
 * one turn reads the journal once a second, not once a record.
 */
function threadIdentities(journal: Journal): (threadId: string) => ThreadIdentity | null {
  const cache = new Map<string, { at: number; identity: ThreadIdentity | null }>();
  return (threadId) => {
    const now = Date.now();
    const kept = cache.get(threadId);
    if (kept !== undefined && now - kept.at < 1000) return kept.identity;
    const thread = journal.getThread(threadId);
    const identity = thread === null ? null : { providerId: thread.providerId, model: thread.model, parentThreadId: thread.parentThreadId ?? null };
    cache.set(threadId, { at: now, identity });
    if (cache.size > 512) cache.delete(cache.keys().next().value!);
    return identity;
  };
}
