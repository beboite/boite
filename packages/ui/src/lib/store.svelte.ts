import type { PermissionMode, ProjectId, ProviderId } from '@boite/contracts';
import type { Client } from './client';
import { readModelDefaults } from './model-defaults';
import { readFavorites } from './model-order';
import { readLayout, readPrefs } from './prefs';
import type { Accounts } from './store/accounts.svelte';
import type { Composer } from './store/composer.svelte';
import type { Connection } from './store/connection.svelte';
import { StoreContext } from './store/context';
import type { Delegation } from './store/delegation.svelte';
import { listen } from './store/events';
import type { Imports } from './store/imports.svelte';
import type { Layout } from './store/layout.svelte';
import type { Models } from './store/models.svelte';
import type { Pairing } from './store/pairing.svelte';
import type { Projects } from './store/projects.svelte';
import type { Requests } from './store/requests.svelte';
import type { CoreSettings } from './store/settings.svelte';
import type { Terminals } from './store/terminals.svelte';
import type { Threads } from './store/threads.svelte';
import type { Workbench } from './store/workbench.svelte';

export type Page = 'chat' | 'settings' | 'agents';
export type SettingsTab = 'brain' | 'voice' | 'general' | 'machines' | 'appearance' | 'keyboard' | 'accounts' | 'plugins' | 'usage' | 'limits' | 'resources' | 'experiments';

/** A login process the core runs for one account, as `account.login` reports it. */
export interface LoginState {
  state: 'running' | 'failed';
  /** The last line the provider CLI printed. */
  output: string;
  /** The first https link it printed, once there is one. */
  url: string | null;
  exitCode: number | null;
}

/** A thread that exists only in the UI until its first message is sent. */
export interface Draft {
  /**
   * Null is the drafts project before the core made it: the first send asks
   * for it with `projects.drafts`, so opening the app writes nothing to disk.
   */
  projectId: ProjectId | null;
  /** The first send starts the thread in a git worktree of the project, on a branch of its own. */
  worktree: boolean;
}

/** What the composer sends a message with. */
export interface Choice {
  providerId: ProviderId;
  accountId: string;
  permissionMode: PermissionMode;
  model: string | null;
  /** A level id of that model, or null for the model's own default. */
  effort: string | null;
  speed?: string | null;
}

/** What the picker hands back: the instance and model together, or an effort alone. */
export interface PickPatch {
  providerId?: ProviderId;
  accountId?: string;
  model?: string | null;
  effort?: string | null;
  speed?: string | null;
}

/**
 * What one `files.*` call answers with: the value, or the sentence the surface
 * that asked prints instead. A refused path belongs to that surface, not to the
 * app's toast, so these calls hand the message back rather than raising it.
 */
export type FileAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The state of one machine's UI and every action on it, the object components
 * read. It holds no domain logic of its own: each property and method below
 * reads or calls the part of `store/` that owns it, which keeps the `$state`
 * of that part reactive through these accessors. The parts call each other's
 * public methods through this facade, so a spy on the Store sees them.
 */
export class Store {
  readonly #ctx = new StoreContext(this);
  machineId = '';
  visible = true;
  error = $state<string | null>(null);

  threadKey(id: string): string { return this.machineId ? JSON.stringify([this.machineId, id]) : id; }

  get client(): Client | null {
    return this.#ctx.client;
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  attach(client: Client): void {
    const ctx = this.#ctx;
    this.detach();
    ctx.threads.readingThreads.clear();
    this.readingPositions.clear();
    ctx.composer.pendingSends.clear();
    this.logins = {};
    ctx.accounts.loginChanges.clear();
    this.terminalThreads = [];
    this.loginTerminals = [];
    ctx.client = client;
    this.probedModels = {};
    ctx.models.probeEpoch++;
    ctx.models.probeAttempts.clear();
    ctx.models.effortAttempts.clear();
    ctx.models.probeRequests.clear();
    this.probingModels = [];
    this.connection = client.state;
    this.prefs = readPrefs();
    this.modelDefaults = readModelDefaults();
    this.favorites = readFavorites();
    const layout = readLayout();
    this.sidebarWidth = layout.sidebarWidth;
    this.sidebarCollapsed = layout.sidebarCollapsed;
    listen(ctx, client);
  }

  detach(): void {
    const ctx = this.#ctx;
    ctx.delegation.coordinationEpoch++;
    this.coordination = null;
    this.coordinationDirectory = null;
    this.coordinationLoading = false;
    this.coordinationSaving = false;
    this.coordinationError = null;
    ctx.delegation.delegationEpoch++;
    ctx.delegation.delegationSelectionEpoch++;
    ctx.delegation.delegationConfigureEpoch++;
    this.delegation = null;
    this.delegationThread = null;
    this.delegationSelectedAgentId = null;
    this.delegationLoading = false;
    this.delegationSaving = false;
    this.delegationError = null;
    for (const off of ctx.off) off();
    ctx.off = [];
    ctx.client = null;
    ctx.threads.subscribedThreadId = null;
    ctx.delegation.delegationSubscribedThreadId = null;
  }

  // -------------------------------------------------------------------------
  // Connection: store/connection.svelte.ts
  // -------------------------------------------------------------------------

  get connection() { return this.#ctx.connection.connection; }
  set connection(value) { this.#ctx.connection.connection = value; }
  get core() { return this.#ctx.connection.core; }
  set core(value) { this.#ctx.connection.core = value; }
  get principal() { return this.#ctx.connection.principal; }
  set principal(value) { this.#ctx.connection.principal = value; }
  get endpointUrl() { return this.#ctx.connection.endpointUrl; }
  set endpointUrl(value) { this.#ctx.connection.endpointUrl = value; }
  get paired() { return this.#ctx.connection.paired; }
  set paired(value) { this.#ctx.connection.paired = value; }
  get localCore() { return this.#ctx.connection.localCore; }
  set localCore(value) { this.#ctx.connection.localCore = value; }
  get localEndpointUrl() { return this.#ctx.connection.localEndpointUrl; }
  set localEndpointUrl(value) { this.#ctx.connection.localEndpointUrl = value; }
  get environments() { return this.#ctx.connection.environments; }
  set environments(value) { this.#ctx.connection.environments = value; }
  get machineStates() { return this.#ctx.connection.machineStates; }
  set machineStates(value) { this.#ctx.connection.machineStates = value; }
  get booted() { return this.#ctx.connection.booted; }
  set booted(value) { this.#ctx.connection.booted = value; }
  get owner(): boolean { return this.#ctx.connection.owner; }
  get pickerAvailable(): boolean { return this.#ctx.connection.pickerAvailable; }

  suspend(...args: Parameters<Connection['suspend']>) { return this.#ctx.connection.suspend(...args); }
  connectEndpoint(...args: Parameters<Connection['connectEndpoint']>) { return this.#ctx.connection.connectEndpoint(...args); }
  boot(...args: Parameters<Connection['boot']>) { return this.#ctx.connection.boot(...args); }
  connect(...args: Parameters<Connection['connect']>) { return this.#ctx.connection.connect(...args); }
  connectTo(...args: Parameters<Connection['connectTo']>) { return this.#ctx.connection.connectTo(...args); }
  switchEnvironment(...args: Parameters<Connection['switchEnvironment']>) { return this.#ctx.connection.switchEnvironment(...args); }
  forgetEnvironment(...args: Parameters<Connection['forgetEnvironment']>) { return this.#ctx.connection.forgetEnvironment(...args); }
  pairWith(...args: Parameters<Connection['pairWith']>) { return this.#ctx.connection.pairWith(...args); }
  useLocalCore(...args: Parameters<Connection['useLocalCore']>) { return this.#ctx.connection.useLocalCore(...args); }
  reload(...args: Parameters<Connection['reload']>) { return this.#ctx.connection.reload(...args); }

  // -------------------------------------------------------------------------
  // Pairing: store/pairing.svelte.ts
  // -------------------------------------------------------------------------

  get pairing() { return this.#ctx.pairing.pairing; }
  set pairing(value) { this.#ctx.pairing.pairing = value; }
  get sessions() { return this.#ctx.pairing.sessions; }
  set sessions(value) { this.#ctx.pairing.sessions = value; }

  mintPairing(...args: Parameters<Pairing['mintPairing']>) { return this.#ctx.pairing.mintPairing(...args); }
  loadSessions(...args: Parameters<Pairing['loadSessions']>) { return this.#ctx.pairing.loadSessions(...args); }
  revokeSession(...args: Parameters<Pairing['revokeSession']>) { return this.#ctx.pairing.revokeSession(...args); }

  // -------------------------------------------------------------------------
  // Layout, navigation and notifications: store/layout.svelte.ts
  // -------------------------------------------------------------------------

  get projectPickerOpen() { return this.#ctx.layout.projectPickerOpen; }
  set projectPickerOpen(value) { this.#ctx.layout.projectPickerOpen = value; }
  get notifications() { return this.#ctx.layout.notifications; }
  set notifications(value) { this.#ctx.layout.notifications = value; }
  get paletteOpen() { return this.#ctx.layout.paletteOpen; }
  set paletteOpen(value) { this.#ctx.layout.paletteOpen = value; }
  get renameRequested() { return this.#ctx.layout.renameRequested; }
  set renameRequested(value) { this.#ctx.layout.renameRequested = value; }
  get page() { return this.#ctx.layout.page; }
  set page(value) { this.#ctx.layout.page = value; }
  get settingsTab() { return this.#ctx.layout.settingsTab; }
  set settingsTab(value) { this.#ctx.layout.settingsTab = value; }
  get settingsSection() { return this.#ctx.layout.settingsSection; }
  set settingsSection(value) { this.#ctx.layout.settingsSection = value; }
  get sidebarOpen() { return this.#ctx.layout.sidebarOpen; }
  set sidebarOpen(value) { this.#ctx.layout.sidebarOpen = value; }
  get sidebarCollapsed() { return this.#ctx.layout.sidebarCollapsed; }
  set sidebarCollapsed(value) { this.#ctx.layout.sidebarCollapsed = value; }
  get sidebarWidth() { return this.#ctx.layout.sidebarWidth; }
  set sidebarWidth(value) { this.#ctx.layout.sidebarWidth = value; }
  get dropping() { return this.#ctx.layout.dropping; }
  set dropping(value) { this.#ctx.layout.dropping = value; }
  get search() { return this.#ctx.layout.search; }
  set search(value) { this.#ctx.layout.search = value; }
  get panel() { return this.#ctx.layout.panel; }
  get panelOpen(): boolean { return this.#ctx.layout.panelOpen; }

  setSidebarWidth(...args: Parameters<Layout['setSidebarWidth']>) { return this.#ctx.layout.setSidebarWidth(...args); }
  toggleSidebar(...args: Parameters<Layout['toggleSidebar']>) { return this.#ctx.layout.toggleSidebar(...args); }
  copy(...args: Parameters<Layout['copy']>) { return this.#ctx.layout.copy(...args); }
  showSettings(...args: Parameters<Layout['showSettings']>) { return this.#ctx.layout.showSettings(...args); }
  showChat(...args: Parameters<Layout['showChat']>) { return this.#ctx.layout.showChat(...args); }
  showAgents(...args: Parameters<Layout['showAgents']>) { return this.#ctx.layout.showAgents(...args); }
  togglePanel(...args: Parameters<Layout['togglePanel']>) { return this.#ctx.layout.togglePanel(...args); }
  setNotifications(...args: Parameters<Layout['setNotifications']>) { return this.#ctx.layout.setNotifications(...args); }

  // -------------------------------------------------------------------------
  // Core settings, keyboard and telemetry: store/settings.svelte.ts
  // -------------------------------------------------------------------------

  get scheduler() { return this.#ctx.settings.scheduler; }
  set scheduler(value) { this.#ctx.settings.scheduler = value; }
  get settings() { return this.#ctx.settings.settings; }
  set settings(value) { this.#ctx.settings.settings = value; }
  get keybindings() { return this.#ctx.settings.keybindings; }
  set keybindings(value) { this.#ctx.settings.keybindings = value; }
  get bindings() { return this.#ctx.settings.bindings; }

  saveSettings(...args: Parameters<CoreSettings['saveSettings']>) { return this.#ctx.settings.saveSettings(...args); }
  commandForKey(...args: Parameters<CoreSettings['commandForKey']>) { return this.#ctx.settings.commandForKey(...args); }
  isKey(...args: Parameters<CoreSettings['isKey']>) { return this.#ctx.settings.isKey(...args); }
  keyLabel(...args: Parameters<CoreSettings['keyLabel']>) { return this.#ctx.settings.keyLabel(...args); }
  setKeybinding(...args: Parameters<CoreSettings['setKeybinding']>) { return this.#ctx.settings.setKeybinding(...args); }
  resetKeybindings(...args: Parameters<CoreSettings['resetKeybindings']>) { return this.#ctx.settings.resetKeybindings(...args); }
  keyHint(...args: Parameters<CoreSettings['keyHint']>) { return this.#ctx.settings.keyHint(...args); }
  telemetryState(...args: Parameters<CoreSettings['telemetryState']>) { return this.#ctx.settings.telemetryState(...args); }
  configureTelemetry(...args: Parameters<CoreSettings['configureTelemetry']>) { return this.#ctx.settings.configureTelemetry(...args); }
  retryTelemetryDeletion(...args: Parameters<CoreSettings['retryTelemetryDeletion']>) { return this.#ctx.settings.retryTelemetryDeletion(...args); }
  exportTelemetry(...args: Parameters<CoreSettings['exportTelemetry']>) { return this.#ctx.settings.exportTelemetry(...args); }

  // -------------------------------------------------------------------------
  // Terminals: store/terminals.svelte.ts
  // -------------------------------------------------------------------------

  get terminalThreads() { return this.#ctx.terminals.terminalThreads; }
  set terminalThreads(value) { this.#ctx.terminals.terminalThreads = value; }
  get loginTerminals() { return this.#ctx.terminals.loginTerminals; }
  set loginTerminals(value) { this.#ctx.terminals.loginTerminals = value; }

  terminalShown(...args: Parameters<Terminals['terminalShown']>) { return this.#ctx.terminals.terminalShown(...args); }
  toggleTerminal(...args: Parameters<Terminals['toggleTerminal']>) { return this.#ctx.terminals.toggleTerminal(...args); }
  hideTerminal(...args: Parameters<Terminals['hideTerminal']>) { return this.#ctx.terminals.hideTerminal(...args); }
  openTerminal(...args: Parameters<Terminals['openTerminal']>) { return this.#ctx.terminals.openTerminal(...args); }
  loginTerminal(...args: Parameters<Terminals['loginTerminal']>) { return this.#ctx.terminals.loginTerminal(...args); }
  showLoginTerminal(...args: Parameters<Terminals['showLoginTerminal']>) { return this.#ctx.terminals.showLoginTerminal(...args); }
  hideLoginTerminal(...args: Parameters<Terminals['hideLoginTerminal']>) { return this.#ctx.terminals.hideLoginTerminal(...args); }
  writeTerminal(...args: Parameters<Terminals['writeTerminal']>) { return this.#ctx.terminals.writeTerminal(...args); }
  resizeTerminal(...args: Parameters<Terminals['resizeTerminal']>) { return this.#ctx.terminals.resizeTerminal(...args); }
  closeTerminal(...args: Parameters<Terminals['closeTerminal']>) { return this.#ctx.terminals.closeTerminal(...args); }

  // -------------------------------------------------------------------------
  // Models and the composer's choice: store/models.svelte.ts
  // -------------------------------------------------------------------------

  get prefs() { return this.#ctx.models.prefs; }
  set prefs(value) { this.#ctx.models.prefs = value; }
  get modelDefaults() { return this.#ctx.models.modelDefaults; }
  set modelDefaults(value) { this.#ctx.models.modelDefaults = value; }
  get draftChoice() { return this.#ctx.models.draftChoice; }
  set draftChoice(value) { this.#ctx.models.draftChoice = value; }
  get favorites() { return this.#ctx.models.favorites; }
  set favorites(value) { this.#ctx.models.favorites = value; }
  get probedModels() { return this.#ctx.models.probedModels; }
  set probedModels(value) { this.#ctx.models.probedModels = value; }
  get probingModels() { return this.#ctx.models.probingModels; }
  set probingModels(value) { this.#ctx.models.probingModels = value; }

  toggleFavorite(...args: Parameters<Models['toggleFavorite']>) { return this.#ctx.models.toggleFavorite(...args); }
  modelsOf(...args: Parameters<Models['modelsOf']>) { return this.#ctx.models.modelsOf(...args); }
  modelOf(...args: Parameters<Models['modelOf']>) { return this.#ctx.models.modelOf(...args); }
  probeModelEffort(...args: Parameters<Models['probeModelEffort']>) { return this.#ctx.models.probeModelEffort(...args); }
  isProbing(...args: Parameters<Models['isProbing']>) { return this.#ctx.models.isProbing(...args); }
  probeModels(...args: Parameters<Models['probeModels']>) { return this.#ctx.models.probeModels(...args); }
  defaultModelOf(...args: Parameters<Models['defaultModelOf']>) { return this.#ctx.models.defaultModelOf(...args); }
  composerChoice(...args: Parameters<Models['composerChoice']>) { return this.#ctx.models.composerChoice(...args); }
  defaultEffortOf(...args: Parameters<Models['defaultEffortOf']>) { return this.#ctx.models.defaultEffortOf(...args); }
  setModelDefault(...args: Parameters<Models['setModelDefault']>) { return this.#ctx.models.setModelDefault(...args); }
  defaultChoice(...args: Parameters<Models['defaultChoice']>) { return this.#ctx.models.defaultChoice(...args); }
  useProvider(...args: Parameters<Models['useProvider']>) { return this.#ctx.models.useProvider(...args); }
  applyProfile(...args: Parameters<Models['applyProfile']>) { return this.#ctx.models.applyProfile(...args); }
  remember(...args: Parameters<Models['remember']>) { return this.#ctx.models.remember(...args); }
  prepareDraftChoice(...args: Parameters<Models['prepareDraftChoice']>) { return this.#ctx.models.prepareDraftChoice(...args); }

  // -------------------------------------------------------------------------
  // Providers, accounts and managed installs: store/accounts.svelte.ts
  // -------------------------------------------------------------------------

  get connectDialog() { return this.#ctx.accounts.connectDialog; }
  set connectDialog(value) { this.#ctx.accounts.connectDialog = value; }
  get providers() { return this.#ctx.accounts.providers; }
  set providers(value) { this.#ctx.accounts.providers = value; }
  get rejectedProviders() { return this.#ctx.accounts.rejectedProviders; }
  set rejectedProviders(value) { this.#ctx.accounts.rejectedProviders = value; }
  get installStates() { return this.#ctx.accounts.installStates; }
  set installStates(value) { this.#ctx.accounts.installStates = value; }
  get harnessUpdates() { return this.#ctx.accounts.harnessUpdates; }
  set harnessUpdates(value) { this.#ctx.accounts.harnessUpdates = value; }
  get accounts() { return this.#ctx.accounts.accounts; }
  set accounts(value) { this.#ctx.accounts.accounts = value; }
  get logins() { return this.#ctx.accounts.logins; }
  set logins(value) { this.#ctx.accounts.logins = value; }

  accountsOf(...args: Parameters<Accounts['accountsOf']>) { return this.#ctx.accounts.accountsOf(...args); }
  providerOf(...args: Parameters<Accounts['providerOf']>) { return this.#ctx.accounts.providerOf(...args); }
  installOf(...args: Parameters<Accounts['installOf']>) { return this.#ctx.accounts.installOf(...args); }
  accountOf(...args: Parameters<Accounts['accountOf']>) { return this.#ctx.accounts.accountOf(...args); }
  openConnect(...args: Parameters<Accounts['openConnect']>) { return this.#ctx.accounts.openConnect(...args); }
  closeConnect(...args: Parameters<Accounts['closeConnect']>) { return this.#ctx.accounts.closeConnect(...args); }
  addAccount(...args: Parameters<Accounts['addAccount']>) { return this.#ctx.accounts.addAccount(...args); }
  removeAccount(...args: Parameters<Accounts['removeAccount']>) { return this.#ctx.accounts.removeAccount(...args); }
  cancelLogin(...args: Parameters<Accounts['cancelLogin']>) { return this.#ctx.accounts.cancelLogin(...args); }
  loginAccount(...args: Parameters<Accounts['loginAccount']>) { return this.#ctx.accounts.loginAccount(...args); }
  sendLoginInput(...args: Parameters<Accounts['sendLoginInput']>) { return this.#ctx.accounts.sendLoginInput(...args); }
  checkAccount(...args: Parameters<Accounts['checkAccount']>) { return this.#ctx.accounts.checkAccount(...args); }
  reloadProviders(...args: Parameters<Accounts['reloadProviders']>) { return this.#ctx.accounts.reloadProviders(...args); }
  loadHarnessUpdates(...args: Parameters<Accounts['loadHarnessUpdates']>) { return this.#ctx.accounts.loadHarnessUpdates(...args); }
  updateHarness(...args: Parameters<Accounts['updateHarness']>) { return this.#ctx.accounts.updateHarness(...args); }
  skipHarnessUpdate(...args: Parameters<Accounts['skipHarnessUpdate']>) { return this.#ctx.accounts.skipHarnessUpdate(...args); }
  installProvider(...args: Parameters<Accounts['installProvider']>) { return this.#ctx.accounts.installProvider(...args); }
  cancelInstall(...args: Parameters<Accounts['cancelInstall']>) { return this.#ctx.accounts.cancelInstall(...args); }
  uninstallProvider(...args: Parameters<Accounts['uninstallProvider']>) { return this.#ctx.accounts.uninstallProvider(...args); }

  // -------------------------------------------------------------------------
  // Projects and the draft: store/projects.svelte.ts
  // -------------------------------------------------------------------------

  get projects() { return this.#ctx.projects.projects; }
  set projects(value) { this.#ctx.projects.projects = value; }
  get draft() { return this.#ctx.projects.draft; }
  set draft(value) { this.#ctx.projects.draft = value; }
  get collapsedProjects() { return this.#ctx.projects.collapsedProjects; }
  set collapsedProjects(value) { this.#ctx.projects.collapsedProjects = value; }
  get openProject() { return this.#ctx.projects.openProject; }
  get draftsProject() { return this.#ctx.projects.draftsProject; }
  get draftInDrafts(): boolean { return this.#ctx.projects.draftInDrafts; }

  isCollapsed(...args: Parameters<Projects['isCollapsed']>) { return this.#ctx.projects.isCollapsed(...args); }
  toggleProject(...args: Parameters<Projects['toggleProject']>) { return this.#ctx.projects.toggleProject(...args); }
  lastProject(...args: Parameters<Projects['lastProject']>) { return this.#ctx.projects.lastProject(...args); }
  openLanding(...args: Parameters<Projects['openLanding']>) { return this.#ctx.projects.openLanding(...args); }
  openWhereLeft(...args: Parameters<Projects['openWhereLeft']>) { return this.#ctx.projects.openWhereLeft(...args); }
  pickProject(...args: Parameters<Projects['pickProject']>) { return this.#ctx.projects.pickProject(...args); }
  browseProjects(...args: Parameters<Projects['browseProjects']>) { return this.#ctx.projects.browseProjects(...args); }
  addProject(...args: Parameters<Projects['addProject']>) { return this.#ctx.projects.addProject(...args); }
  addProjects(...args: Parameters<Projects['addProjects']>) { return this.#ctx.projects.addProjects(...args); }
  removeProject(...args: Parameters<Projects['removeProject']>) { return this.#ctx.projects.removeProject(...args); }
  startDraft(...args: Parameters<Projects['startDraft']>) { return this.#ctx.projects.startDraft(...args); }
  setDraftProject(...args: Parameters<Projects['setDraftProject']>) { return this.#ctx.projects.setDraftProject(...args); }
  setDraftWorktree(...args: Parameters<Projects['setDraftWorktree']>) { return this.#ctx.projects.setDraftWorktree(...args); }

  // -------------------------------------------------------------------------
  // Threads: store/threads.svelte.ts and store/imports.svelte.ts
  // -------------------------------------------------------------------------

  get threads() { return this.#ctx.threads.threads; }
  set threads(value) { this.#ctx.threads.threads = value; }
  get openThread() { return this.#ctx.threads.openThread; }
  set openThread(value) { this.#ctx.threads.openThread = value; }
  get loadingOlder() { return this.#ctx.threads.loadingOlder; }
  set loadingOlder(value) { this.#ctx.threads.loadingOlder = value; }
  get retitling() { return this.#ctx.threads.retitling; }
  set retitling(value) { this.#ctx.threads.retitling = value; }
  get readingPositions() { return this.#ctx.threads.readingPositions; }
  get unreadCount(): number { return this.#ctx.threads.unreadCount; }
  get busy(): boolean { return this.#ctx.threads.busy; }
  get messagesBefore() { return this.#ctx.threads.messagesBefore; }
  get imports() { return this.#ctx.imports.imports; }
  set imports(value) { this.#ctx.imports.imports = value; }

  threadsOf(...args: Parameters<Threads['threadsOf']>) { return this.#ctx.threads.threadsOf(...args); }
  compact(...args: Parameters<Threads['compact']>) { return this.#ctx.threads.compact(...args); }
  open(...args: Parameters<Threads['open']>) { return this.#ctx.threads.open(...args); }
  loadOlder(...args: Parameters<Threads['loadOlder']>) { return this.#ctx.threads.loadOlder(...args); }
  createThread(...args: Parameters<Threads['createThread']>) { return this.#ctx.threads.createThread(...args); }
  update(...args: Parameters<Threads['update']>) { return this.#ctx.threads.update(...args); }
  setPermissionMode(...args: Parameters<Threads['setPermissionMode']>) { return this.#ctx.threads.setPermissionMode(...args); }
  rename(...args: Parameters<Threads['rename']>) { return this.#ctx.threads.rename(...args); }
  retitle(...args: Parameters<Threads['retitle']>) { return this.#ctx.threads.retitle(...args); }
  pin(...args: Parameters<Threads['pin']>) { return this.#ctx.threads.pin(...args); }
  archive(...args: Parameters<Threads['archive']>) { return this.#ctx.threads.archive(...args); }
  openImports(...args: Parameters<Imports['openImports']>) { return this.#ctx.imports.openImports(...args); }
  closeImports(...args: Parameters<Imports['closeImports']>) { return this.#ctx.imports.closeImports(...args); }
  importSession(...args: Parameters<Imports['importSession']>) { return this.#ctx.imports.importSession(...args); }

  // -------------------------------------------------------------------------
  // The composer and the send path: store/composer.svelte.ts
  // -------------------------------------------------------------------------

  get composerStates() { return this.#ctx.composer.composerStates; }
  set composerStates(value) { this.#ctx.composer.composerStates = value; }

  registerComposerInsertion(...args: Parameters<Composer['registerComposerInsertion']>) { return this.#ctx.composer.registerComposerInsertion(...args); }
  editComposerText(...args: Parameters<Composer['editComposerText']>) { return this.#ctx.composer.editComposerText(...args); }
  addPreviewReference(...args: Parameters<Composer['addPreviewReference']>) { return this.#ctx.composer.addPreviewReference(...args); }
  revealPreviewReference(...args: Parameters<Composer['revealPreviewReference']>) { return this.#ctx.composer.revealPreviewReference(...args); }
  appendComposerText(...args: Parameters<Composer['appendComposerText']>) { return this.#ctx.composer.appendComposerText(...args); }
  submit(...args: Parameters<Composer['submit']>) { return this.#ctx.composer.submit(...args); }
  submitAndDraft(...args: Parameters<Composer['submitAndDraft']>) { return this.#ctx.composer.submitAndDraft(...args); }
  send(...args: Parameters<Composer['send']>) { return this.#ctx.composer.send(...args); }
  stop(...args: Parameters<Composer['stop']>) { return this.#ctx.composer.stop(...args); }

  // -------------------------------------------------------------------------
  // Permission and question cards: store/requests.svelte.ts
  // -------------------------------------------------------------------------

  get pendingPermissions() { return this.#ctx.requests.pendingPermissions; }
  set pendingPermissions(value) { this.#ctx.requests.pendingPermissions = value; }
  get permissionRequests() { return this.#ctx.requests.permissionRequests; }
  set permissionRequests(value) { this.#ctx.requests.permissionRequests = value; }
  get pendingQuestions() { return this.#ctx.requests.pendingQuestions; }
  set pendingQuestions(value) { this.#ctx.requests.pendingQuestions = value; }
  get questionRequests() { return this.#ctx.requests.questionRequests; }
  set questionRequests(value) { this.#ctx.requests.questionRequests = value; }

  answerQuestion(...args: Parameters<Requests['answerQuestion']>) { return this.#ctx.requests.answerQuestion(...args); }
  answer(...args: Parameters<Requests['answer']>) { return this.#ctx.requests.answer(...args); }

  // -------------------------------------------------------------------------
  // Coordination and delegation: store/delegation.svelte.ts
  // -------------------------------------------------------------------------

  get coordination() { return this.#ctx.delegation.coordination; }
  set coordination(value) { this.#ctx.delegation.coordination = value; }
  get coordinationDirectory() { return this.#ctx.delegation.coordinationDirectory; }
  set coordinationDirectory(value) { this.#ctx.delegation.coordinationDirectory = value; }
  get coordinationLoading() { return this.#ctx.delegation.coordinationLoading; }
  set coordinationLoading(value) { this.#ctx.delegation.coordinationLoading = value; }
  get coordinationSaving() { return this.#ctx.delegation.coordinationSaving; }
  set coordinationSaving(value) { this.#ctx.delegation.coordinationSaving = value; }
  get coordinationError() { return this.#ctx.delegation.coordinationError; }
  set coordinationError(value) { this.#ctx.delegation.coordinationError = value; }
  get delegation() { return this.#ctx.delegation.delegation; }
  set delegation(value) { this.#ctx.delegation.delegation = value; }
  get delegationThread() { return this.#ctx.delegation.delegationThread; }
  set delegationThread(value) { this.#ctx.delegation.delegationThread = value; }
  get delegationSelectedAgentId() { return this.#ctx.delegation.delegationSelectedAgentId; }
  set delegationSelectedAgentId(value) { this.#ctx.delegation.delegationSelectedAgentId = value; }
  get delegationLoading() { return this.#ctx.delegation.delegationLoading; }
  set delegationLoading(value) { this.#ctx.delegation.delegationLoading = value; }
  get delegationSaving() { return this.#ctx.delegation.delegationSaving; }
  set delegationSaving(value) { this.#ctx.delegation.delegationSaving = value; }
  get delegationError() { return this.#ctx.delegation.delegationError; }
  set delegationError(value) { this.#ctx.delegation.delegationError = value; }

  loadCoordination(...args: Parameters<Delegation['loadCoordination']>) { return this.#ctx.delegation.loadCoordination(...args); }
  configureCoordination(...args: Parameters<Delegation['configureCoordination']>) { return this.#ctx.delegation.configureCoordination(...args); }
  loadDelegation(...args: Parameters<Delegation['loadDelegation']>) { return this.#ctx.delegation.loadDelegation(...args); }
  configureDelegation(...args: Parameters<Delegation['configureDelegation']>) { return this.#ctx.delegation.configureDelegation(...args); }
  selectDelegatedAgent(...args: Parameters<Delegation['selectDelegatedAgent']>) { return this.#ctx.delegation.selectDelegatedAgent(...args); }
  spawnDelegatedAgent(...args: Parameters<Delegation['spawnDelegatedAgent']>) { return this.#ctx.delegation.spawnDelegatedAgent(...args); }
  messageDelegatedAgent(...args: Parameters<Delegation['messageDelegatedAgent']>) { return this.#ctx.delegation.messageDelegatedAgent(...args); }
  stopDelegatedAgent(...args: Parameters<Delegation['stopDelegatedAgent']>) { return this.#ctx.delegation.stopDelegatedAgent(...args); }
  coordinationIdentity(...args: Parameters<Delegation['coordinationIdentity']>) { return this.#ctx.delegation.coordinationIdentity(...args); }
  coordinationPeers(...args: Parameters<Delegation['coordinationPeers']>) { return this.#ctx.delegation.coordinationPeers(...args); }
  checkCoordinationPeer(...args: Parameters<Delegation['checkCoordinationPeer']>) { return this.#ctx.delegation.checkCoordinationPeer(...args); }
  trustCoordinationPeer(...args: Parameters<Delegation['trustCoordinationPeer']>) { return this.#ctx.delegation.trustCoordinationPeer(...args); }
  untrustCoordinationPeer(...args: Parameters<Delegation['untrustCoordinationPeer']>) { return this.#ctx.delegation.untrustCoordinationPeer(...args); }

  // -------------------------------------------------------------------------
  // The workbench: store/workbench.svelte.ts
  // -------------------------------------------------------------------------

  get resources() { return this.#ctx.workbench.resources; }
  set resources(value) { this.#ctx.workbench.resources = value; }
  get trace() { return this.#ctx.workbench.trace; }
  set trace(value) { this.#ctx.workbench.trace = value; }
  get todos() { return this.#ctx.workbench.todos; }
  set todos(value) { this.#ctx.workbench.todos = value; }
  get traceWatched() { return this.#ctx.workbench.traceWatched; }
  set traceWatched(value) { this.#ctx.workbench.traceWatched = value; }

  refreshTrace(...args: Parameters<Workbench['refreshTrace']>) { return this.#ctx.workbench.refreshTrace(...args); }
  gitStatus(...args: Parameters<Workbench['gitStatus']>) { return this.#ctx.workbench.gitStatus(...args); }
  gitDiff(...args: Parameters<Workbench['gitDiff']>) { return this.#ctx.workbench.gitDiff(...args); }
  listFiles(...args: Parameters<Workbench['listFiles']>) { return this.#ctx.workbench.listFiles(...args); }
  readFile(...args: Parameters<Workbench['readFile']>) { return this.#ctx.workbench.readFile(...args); }
  writeFile(...args: Parameters<Workbench['writeFile']>) { return this.#ctx.workbench.writeFile(...args); }
  setTasks(...args: Parameters<Workbench['setTasks']>) { return this.#ctx.workbench.setTasks(...args); }
  loadTodos(...args: Parameters<Workbench['loadTodos']>) { return this.#ctx.workbench.loadTodos(...args); }
  addTodo(...args: Parameters<Workbench['addTodo']>) { return this.#ctx.workbench.addTodo(...args); }
  updateTodo(...args: Parameters<Workbench['updateTodo']>) { return this.#ctx.workbench.updateTodo(...args); }
  removeTodo(...args: Parameters<Workbench['removeTodo']>) { return this.#ctx.workbench.removeTodo(...args); }
  refreshResources(...args: Parameters<Workbench['refreshResources']>) { return this.#ctx.workbench.refreshResources(...args); }
  killTree(...args: Parameters<Workbench['killTree']>) { return this.#ctx.workbench.killTree(...args); }
}

export const store = new Store();
