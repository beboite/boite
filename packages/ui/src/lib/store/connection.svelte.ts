import { RELEASE_VERSION } from '../release';
import { parseGroupRelayUrl, RpcErrorCode, type CoreInfo, type Principal, type ThreadId } from '@boite/contracts';
import { RpcFailure, WsClient, type Client, type ClientState, type ObservableClient } from '../client';
import { confirm } from '../confirm.svelte';
import { deviceLabel, noteThisComputer } from '../device';
import { clearStoredEndpoint, droppedSince, relayKeyFor, forgetGroupOf, readStoredEndpoint, rememberSession, refreshLocalEnvironment, removeBrought, fromTauri, shellEndpointError, parsePairingLink, readEnvironments, removeEnvironment, resolveEndpoint, servesThisPage, storeEndpoint, upsertEnvironment, type Endpoint, type StoredEnvironment } from '../endpoint';
import { onboardingSeen } from '../onboarding';
import { rightPanel } from '../right-panel.svelte';
import { fill, strings } from '../strings';
import { reconcileRows, unlistedPanels } from '../thread-rows';
import { work } from '../work-prefs.svelte';
import { installStatesOf } from './accounts.svelte';
import type { StoreContext } from './context';
import { retainRows } from './snapshot-reads';

/**
 * The version a paired device reports in `hello` and Settings lists beside it.
 * A literal here stayed at the last stable version on every nightly.
 */
export const UI_VERSION: string = RELEASE_VERSION;

/**
 * How long the shell's own core may stay unreachable before the shell is asked
 * for it again. A core restarting on its own port is back well within it.
 */
export const LOCAL_RECOVERY_MS = 4_000;

export function observable(client: Client): client is ObservableClient {
  return 'onState' in client;
}

/** A link names a core this device never met: the user says whether to go there. */
function askToFollowLink(url: string): Promise<boolean> {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* the raw text, then */
  }
  return confirm.ask({
    title: strings.machines.linkTitle.replace('{host}', host),
    body: strings.machines.linkBody,
    confirmLabel: strings.machines.linkConfirm,
    cancelLabel: strings.machines.linkCancel,
    danger: true
  });
}

/**
 * Which core this Store talks to and how it got there: boot, the switch between
 * remembered cores, the shell's own core followed when it moves, and the load
 * that fills every list once a client is ready.
 */
export class Connection {
  connection = $state<ClientState>('idle');
  core = $state<CoreInfo | null>(null);
  /** Owner on the core token, session on a paired one; what decides who may pair a phone. */
  principal = $state<Principal | null>(null);
  /** The address of the core this UI talks to; null on the fake client. */
  endpointUrl = $state<string | null>(null);
  /** This UI holds the key a pairing link became, not a token read off the machine. */
  paired = $state(false);
  /** This app needs its own pairing, distinct from a temporary network outage. */
  pairingRequired = $state(false);
  /** The core is the one the shell started on this computer. */
  localCore = $state(false);
  localEndpointUrl = $state<string | null>(null);
  /** The cores this device remembers: pairing or connecting adds one, forgetting removes one. */
  environments = $state<StoredEnvironment[]>([]);
  machineStates = $state<Record<string, { state: ClientState; error?: string }>>({});
  booted = $state(false);
  /** The load in flight and the client it speaks to, so the two callers of `reload()` share one. */
  reloading: { client: Client; generation: number; epoch: number; promise: Promise<void>; essential: Promise<void>; release: () => void } | null = null;
  #readEpoch = 0;
  #localRecovery: ReturnType<typeof setTimeout> | null = null;
  /** The endpoint came with neither a token nor a grant: the page's own origin, asked with nothing. */
  #keyless = false;

  constructor(private readonly ctx: StoreContext) {}

  /**
   * What this client may ask of the core. A paired device reaches the list in
   * `packages/core/src/access.ts` and nothing else, so everything outside it
   * comes off its screen rather than throwing under a finger. The `null` of a
   * `hello` still in flight counts as the owner: the desktop must not blink its
   * own controls away, and a phone showing one for a frame is the cheaper miss.
   */
  get owner(): boolean {
    return this.principal !== 'session';
  }

  /**
   * The native folder dialog names a path on this computer, which is only a
   * path the core can open when the core runs here too. A shell paired with a
   * core on a server types the server's path instead.
   */
  get pickerAvailable(): boolean {
    return window.__TAURI_INTERNALS__ !== undefined && this.localCore;
  }

  /** Stop streaming the hidden conversation while keeping machine summaries live. */
  async suspend(): Promise<void> {
    this.ctx.store.visible = false;
    await this.ctx.threads.unsubscribe();
  }

  async connectEndpoint(endpoint: Endpoint): Promise<void> {
    const s = this.ctx.store;
    s.closePairing();
    this.attachEndpoint(endpoint, false);
    const client = this.ctx.client;
    let timedOut = false;
    // Only a handshake that never finished is given up on. Once the machine
    // said hello, a slow link still loading the lists is waited for: closing
    // it there dropped a working machine for good.
    const timeout = setTimeout(() => {
      if (client === null || client.state === 'ready') return;
      timedOut = true;
      client.close();
    }, 12_000);
    try {
      await s.connect();
    } finally {
      clearTimeout(timeout);
      // Set last: the calls the close dropped report "client closed" first.
      if (timedOut) s.error = strings.machines.timeout;
      this.booted = true;
    }
  }

  /** Picks the transport, connects, loads everything the UI opens on. */
  /** `requested` is a thread a notification link asked for, opened in place of the landing draft. */
  async boot(preferLocal = false, requested: ThreadId | null = null): Promise<void> {
    const s = this.ctx.store;
    const threads = this.ctx.threads;
    try {
      this.environments = readEnvironments();
      const params = new URLSearchParams(window.location.search);
      // `import.meta.env.DEV` is a constant the bundler folds, so a production
      // build drops this branch whole and never carries the fake core, which
      // is a seeded copy of the app's data. It is true under vite's dev server
      // and under vitest, the two places `?fake=1` is used.
      if (import.meta.env.DEV && params.get('fake') === '1') {
        s.machineId = '';
        this.endpointUrl = null;
        this.localCore = false;
        this.paired = false;
        const { FakeClient } = await import('../fake-client');
        // `&long=1` adds the four-hundred-message thread the windowed list is
        // looked at on, `&heavy=1` the forty messages and 11.5 MiB of tool calls
        // a long agent session leaves, `&principal=session` answers as a paired
        // phone, so the screens a device is refused can be walked without pairing one.
        s.attach(
          new FakeClient({
            long: params.get('long') === '1',
            heavy: params.get('heavy') === '1',
            delegationDemo: params.get('team') === '1',
            stewardDemo: params.get('steward') === '1',
            uninstalled: params.get('uninstalled') === '1',
            ...(params.get('principal') === 'session' ? { principal: 'session' as const } : {})
          })
        );
      } else {
        if (window.__TAURI_INTERNALS__) {
          const local = await fromTauri();
          if (local) {
            this.localEndpointUrl = local.url;
            this.environments = refreshLocalEnvironment(local);
          }
        }
        const endpoint = await resolveEndpoint(preferLocal, askToFollowLink);
        if (!endpoint) {
          this.connection = 'closed';
          // The shell's reason, when it has one: the core exited and what it
          // printed, or a start that never answered.
          const refusal = window.__TAURI_INTERNALS__ ? shellEndpointError() : null;
          if (refusal) s.error = fill(strings.errors.coreStart, { reason: refusal });
          this.booted = true;
          return;
        }
        s.machineId = endpoint.url;
        this.attachEndpoint(endpoint);
        // A grant link is stored by `onSession`. Any other link becomes the
        // stored core only once it has answered, never before.
        if (endpoint.fromLink && endpoint.grant === undefined) this.#rememberOnceReady(endpoint);
      }
      // The fake core has no address and stands for the page's own.
      const linked = requested !== null && (this.endpointUrl === null || servesThisPage(this.endpointUrl)) ? requested : null;
      const opens = threads.openGeneration;
      await s.connect();
      // `&open=recent` lands on the most recent thread instead of a draft, the
      // page most captures are about. Fake core only, like `&long=1`.
      if (import.meta.env.DEV && params.get('fake') === '1' && params.get('open') === 'recent') await s.openWhereLeft();
      // A thread clicked while the lists arrived is still opening: it wins.
      else if (threads.openGeneration === opens) {
        if (linked !== null) await s.open(linked);
        // A thread the link names that is gone lands as usual, unless a click came first.
        if (threads.openGeneration === opens + (linked === null ? 0 : 1)) await s.openLanding();
      }
      // `&panel=<kind>` opens that surface on the thread the page lands on, so
      // a capture of it needs no clicks. Fake core only, like `&long=1`.
      if (import.meta.env.DEV && params.get('fake') === '1') this.#openQueryPanel(params.get('panel'));
    } finally {
      this.booted = true;
    }
  }

  #openQueryPanel(kind: string | null): void {
    const s = this.ctx.store;
    if (kind === null || !s.openThread) return;
    const panel = s.panel;
    // `file:<path>` and `files:<path>` carry what the surface opens on, which
    // is how a capture reaches one file with no click.
    const cut = kind.indexOf(':');
    const name = cut < 0 ? kind : kind.slice(0, cut);
    const path = cut < 0 ? '' : kind.slice(cut + 1);
    if (name === 'changes') panel.openChanges(path === '' ? undefined : path);
    else if (name === 'files') panel.openFiles(path === '' ? undefined : path);
    else if (name === 'file' && path !== '') panel.openFile(path);
    else if (name === 'tasks') panel.openTasks();
    else if (name === 'agents') panel.open('agents');
    else if (name === 'trace') panel.open('trace');
    else if (name === 'messages') panel.open('messages');
  }

  #rememberOnceReady(endpoint: Endpoint): void {
    const client = this.ctx.client;
    if (client === null || !observable(client)) return;
    const off = client.onState((state) => {
      if (state !== 'ready') return;
      off();
      storeEndpoint(endpoint);
    });
    this.ctx.off.push(off);
  }

  attachEndpoint(endpoint: Endpoint, rememberActive = true): void {
    const url = endpoint.url;
    const repairing = this.pairingRequired && this.endpointUrl === url;
    this.ctx.store.machineId = endpoint.local ? 'local' : url;
    const paired = endpoint.paired === true || endpoint.grant !== undefined || endpoint.ticket !== undefined;
    this.endpointUrl = url;
    this.paired = paired;
    // Keep the recovery form mounted during a new handshake with this machine.
    this.pairingRequired = repairing;
    this.ctx.store.error = null;
    this.localCore = endpoint.local === true;
    this.#keyless = endpoint.token === '' && endpoint.grant === undefined && endpoint.ticket === undefined;
    let key = endpoint.token;
    const began = Date.now();
    const client = new WsClient({
      url,
      token: endpoint.token,
      ...(endpoint.grant === undefined ? {} : { grant: endpoint.grant }),
      ...(endpoint.ticket === undefined ? {} : { ticket: endpoint.ticket }),
      // Reached through another member: the key for that member, as it stands at each connection.
      ...(parseGroupRelayUrl(url) === null ? {} : { relay: () => relayKeyFor(url) }),
      paired,
      // The session a grant became is this device's own credential: kept
      // where the next load reads it, so the link is opened once, ever.
      // The core joins the remembered environments with it, so switching
      // back later needs no new link.
      onSession: (session) => {
        key = session.token;
        if (this.ctx.client !== client) return;
        // The group dropped this machine while its ticket was being exchanged: the key is refused, and the connection ends there.
        if (endpoint.grant === undefined && droppedSince(url, began, endpoint)) return false;
        // A ticket leaves the machine the group's; a grant makes it the owner's.
        if (rememberActive) storeEndpoint({ url, token: session.token, paired: true, ...(endpoint.grant === undefined ? { coreId: endpoint.coreId, groupId: endpoint.groupId, epoch: endpoint.epoch } : {}) });
        this.environments = rememberSession(endpoint, session.token);
        return true;
      },
      onUnauthorized: (error) => {
        if (this.ctx.client === client && !this.localCore) this.#authenticationFailed(error);
      },
      // Revoked from the desktop: the dead key goes here and in the
      // remembered cores, and the page says what to do rather than
      // retrying every ten seconds.
      onRevoked: () => {
        if (this.ctx.client !== client) return;
        // Only the key this connection presented is dead: another window may have paired this machine anew meanwhile.
        if (rememberActive && readStoredEndpoint()?.token === key) clearStoredEndpoint();
        this.environments = removeEnvironment(url, key);
        this.connection = 'closed';
        this.pairingRequired = true;
        this.ctx.store.error = strings.errors.revoked;
      },
      clientName: window.__TAURI_INTERNALS__ === undefined ? 'pwa' : 'shell',
      version: UI_VERSION,
      device: deviceLabel
    });
    this.ctx.store.attach(client);
  }

  /** Drops everything the last core said, then connects to the next one. */
  async #switchTo(endpoint: Endpoint): Promise<void> {
    const s = this.ctx.store;
    this.ctx.client?.close();
    s.detach();
    s.composerStates = {};
    this.ctx.composer.previewUndo.clear();
    this.ctx.composer.composerInsertions.clear();
    s.openThread = null;
    s.draft = null;
    s.closePairing();
    s.sessions = [];
    s.group = null;
    s.groupKnown = false;
    s.groupInvite = null;
    s.projects = [];
    s.threads = [];
    // What the next core answers replaces these; one that cannot answer must not show the last one's.
    s.harnessUpdates = [];
    s.todos = {};
    s.resources = [];
    s.trace = [];
    this.ctx.workbench.tracedThreadId = null;
    this.principal = null;
    this.core = null;
    this.attachEndpoint(endpoint);
    await s.connect();
    await s.openWhereLeft();
  }

  /**
   * The core this shell started, lost for `LOCAL_RECOVERY_MS`: the shell is
   * asked for it again, which starts a new core when the old one exited (a
   * crash, a kill), and the store follows it if it moved. A client closed on
   * purpose ("Stop this core") is not watched: that stop is meant to hold.
   */
  watchLocalCore(client: Client, state: ClientState): void {
    if (state !== 'connecting' || !this.localCore) {
      if (this.#localRecovery !== null) clearTimeout(this.#localRecovery);
      this.#localRecovery = null;
      return;
    }
    if (this.#localRecovery !== null) return;
    this.#localRecovery = setTimeout(() => {
      this.#localRecovery = null;
      if (this.ctx.client === client && client.state === 'connecting') void this.#followLocalCore(client);
    }, LOCAL_RECOVERY_MS);
  }

  /**
   * Asks the shell where its core is now and moves this store there when the
   * address changed: `moved`. `same` when there is nothing to follow (not the
   * shell's core, or the same address), `refused` when the shell has no core
   * to give, its reason then being the store's error.
   */
  async #followLocalCore(client: Client): Promise<'moved' | 'same' | 'refused'> {
    if (!this.localCore || window.__TAURI_INTERNALS__ === undefined) return 'same';
    const local = await fromTauri();
    if (this.ctx.client !== client) return 'same';
    if (!local) {
      const refusal = shellEndpointError();
      this.ctx.store.error = refusal ? fill(strings.errors.coreStart, { reason: refusal }) : strings.errors.noEndpoint;
      return 'refused';
    }
    if (client.state === 'ready' || local.url === this.endpointUrl) return 'same';
    this.localEndpointUrl = local.url;
    this.environments = refreshLocalEnvironment(local);
    await this.#switchTo(local);
    return 'moved';
  }

  async connect(): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    if (!client) return;
    const generation = this.ctx.clientGeneration;
    // A closed client of the shell's own core: its core may be gone, and the
    // shell starts another on this ask, maybe on a new port.
    if (client.state === 'closed' && await this.#followLocalCore(client) !== 'same') return;
    try {
      s.error = null;
      const core = await client.connect();
      if (!this.ctx.currentClient(client, generation)) return;
      this.core = core;
      if (this.localCore) noteThisComputer(core.hostname);
      this.connection = client.state;
      this.principal = client.principal;
      this.pairingRequired = false;
      void s.reload();
      await Promise.all([this.ctx.drafts.start(), this.reloading?.essential]);
    } catch (error) {
      if (!this.ctx.currentClient(client, generation)) return;
      this.connection = client.state;
      if (error instanceof RpcFailure && error.code === RpcErrorCode.Unauthorized && !this.localCore) {
        this.#authenticationFailed(error);
      }
      else this.ctx.fail(error);
    }
  }

  #authenticationFailed(error: RpcFailure): void {
    this.pairingRequired = true;
    const s = this.ctx.store;
    // A first connection catches the rejection after onRevoked has explained it.
    // A refused grant keeps its own error; attachEndpoint cleared the old notice.
    if (this.#keyless) s.error = strings.errors.unpaired;
    else if (s.error !== strings.errors.revoked && s.error !== error.message) this.ctx.fail(error);
  }

  /** Point the UI at another core, from the Settings page. It stays remembered. */
  async connectTo(url: string, token: string): Promise<void> {
    storeEndpoint({ url, token });
    forgetGroupOf(url);
    this.environments = upsertEnvironment({ url, token, paired: false });
    await this.#switchTo({ url, token });
  }

  /** Drive a remembered core with the key the pairing left here. No new link needed. */
  async switchEnvironment(url: string): Promise<void> {
    if (url === this.localEndpointUrl) return this.ctx.store.useLocalCore();
    const env = readEnvironments().find((entry) => entry.url === url);
    if (!env) {
      this.ctx.store.error = strings.errors.noEndpoint;
      return;
    }
    storeEndpoint(env);
    await this.#switchTo({ url: env.url, token: env.token, ...(env.paired ? { paired: true } : {}) });
  }

  /**
   * Drop a remembered core from this device. Its key stays valid there until
   * revoked; forgetting the core under the UI falls back to the local one.
   * `brought` is the machine of a group it was: its entry goes only while it
   * is still that one, not once it was paired by hand.
   */
  async forgetEnvironment(url: string, brought?: { coreId: string; groupId?: string }, dropped?: number): Promise<void> {
    this.environments = brought === undefined ? removeEnvironment(url) : removeBrought(url, brought, dropped);
    if (this.endpointUrl === url) await this.ctx.store.useLocalCore(url);
  }

  /**
   * Pair this app with a core that runs elsewhere, from a link that core
   * minted. The grant is spent on the first hello and the key it becomes is
   * stored in its place; in the shell that key wins over the core the shell
   * started, on every launch, until `useLocalCore`.
   */
  async pairWith(link: string): Promise<boolean> {
    const parsed = parsePairingLink(link);
    if (!parsed) {
      this.ctx.store.error = strings.errors.pairingLink;
      return false;
    }
    await this.#switchTo({ url: parsed.url, token: '', grant: parsed.grant });
    return this.connection === 'ready';
  }

  /**
   * Back to the core this shell started. Remembered cores stay remembered.
   * `not` is a core that was just forgotten: a page it served would resolve
   * back to it, with no key, so the window stays closed instead.
   */
  async useLocalCore(not?: string): Promise<void> {
    const s = this.ctx.store;
    clearStoredEndpoint();
    const endpoint = await resolveEndpoint();
    if (!endpoint || endpoint.url === not) {
      this.ctx.client?.close();
      s.detach();
      this.connection = 'closed';
      s.error = strings.errors.noEndpoint;
      return;
    }
    await this.#switchTo(endpoint);
  }

  /** Retire leases when a connection ends, including a reconnect on the same client. */
  invalidateReads(): void {
    this.#readEpoch++;
    this.reloading?.release();
    this.ctx.requests.cancelReads();
    this.ctx.threadReads.clear();
    this.ctx.projectReads.clear();
    this.ctx.accountReads.clear();
  }

  /** The ready handler and explicit callers share a refresh of this connection. */
  reload(): Promise<void> {
    const client = this.ctx.client;
    if (!client) return Promise.resolve();
    const generation = this.ctx.clientGeneration, epoch = this.#readEpoch;
    if (this.reloading?.client === client && this.reloading.generation === generation && this.reloading.epoch === epoch) return this.reloading.promise;
    let release!: () => void;
    const essential = new Promise<void>(resolve => { release = resolve; });
    const promise = this.#load(client, generation, epoch, release).finally(() => {
      release();
      if (this.reloading?.promise === promise) this.reloading = null;
    });
    this.reloading = { client, generation, epoch, promise, essential, release };
    return promise;
  }

  async #load(client: Client, generation: number, epoch: number, ready: () => void): Promise<void> {
    const s = this.ctx.store;
    const { accounts, requests } = this.ctx;
    const current = () => this.ctx.currentClient(client, generation) && this.#readEpoch === epoch;
    const loginRevision = accounts.loginRevision;
    // What this connection said of its group before does not speak for what it is now.
    s.groupKnown = false;
    const revisions = { ...this.ctx.metadataRevision };
    const projectRead = this.ctx.projectReads.begin();
    const threadRead = this.ctx.threadReads.begin();
    const accountRead = this.ctx.accountReads.begin();
    // The global reads also serve the reopen, avoiding duplicate per-thread reads.
    const permissionRead = requests.permissionRead(client, 'all');
    const questionRead = requests.questionRead(client, 'all');
    const open = s.openThread;
    const reopened = open && s.visible ? s.open(open.id, false, { requests: false }).catch((error: unknown) => { if (current()) this.ctx.fail(error); }) : null;
    // Publish each completed slice immediately. A secondary login snapshot must
    // never hold conversation catch-up or accepted input behind it.
    const slice = <T>(asked: Promise<T>, apply: (value: T) => void, cancel?: () => void): Promise<void> => asked.then(value => {
      if (current()) apply(value); else cancel?.();
    }).catch(error => { cancel?.(); if (current()) this.ctx.fail(error); });
    const primary = [
      slice(client.call('projects.list', {}), rows => { s.projects = retainRows(s.projects, projectRead.apply(rows, s.projects)); this.ctx.projects.bootListAt = Date.now(); }, () => projectRead.cancel()),
      slice(client.call('threads.list', {}), rows => {
        s.threads = reconcileRows(s.threads, threadRead.apply(rows, s.threads));
        const read = reopened && s.openThread?.unread === false ? s.threads.find(t => t.id === s.openThread?.id) : undefined;
        if (read) read.unread = false;
        const listed = new Set(s.threads.map(t => s.threadKey(t.id)));
        const stale = unlistedPanels(s.machineId, listed, s.openThread ? s.threadKey(s.openThread.id) : null);
        rightPanel.prune(key => stale(key) && !rightPanel.drafts.get(key)?.size);
        work.settle(s.threads.length > 0 || onboardingSeen());
      }, () => threadRead.cancel()),
      slice(client.call('providers.list', {}), value => {
        if (revisions.providers !== this.ctx.metadataRevision.providers) return;
        s.providers = value.loaded; s.rejectedProviders = value.rejected; s.installStates = installStatesOf(value.loaded);
      }),
      slice(client.call('accounts.list', {}), rows => { s.accounts = retainRows(s.accounts, accountRead.apply(rows, s.accounts)); this.ctx.models.restoreModels(); }, () => accountRead.cancel()),
      slice(client.call('settings.get', {}), value => { if (revisions.settings === this.ctx.metadataRevision.settings) s.settings = value; }),
      slice(permissionRead.promise, rows => permissionRead.apply(rows), permissionRead.cancel),
      slice(questionRead.promise, rows => questionRead.apply(rows), questionRead.cancel),
      ...(reopened ? [reopened] : [])
    ];
    const secondary = [
      slice(client.call('scheduler.get', {}), value => { if (revisions.scheduler === this.ctx.metadataRevision.scheduler) s.scheduler = value; }),
      slice(s.owner ? client.call('accounts.logins', {}) : Promise.resolve([]), rows => accounts.restoreLogins(rows, loginRevision)),
      slice(client.call('keybindings.get', {}), value => { if (revisions.keybindings === this.ctx.metadataRevision.keybindings) s.keybindings = value; })
    ];
    const essential = Promise.all(primary).then(() => {
      ready();
      if (!current()) return;
      try {
        if (typeof performance !== 'undefined' && performance.getEntriesByName?.('boite:ready')?.length === 0) performance.mark?.('boite:ready');
      } catch { /* Diagnostic timing cannot hold a working connection in its loading state. */ }
    });
    try {
      await Promise.all([essential, ...secondary]);
      if (!current()) return;
      void s.loadHarnessUpdates();
      // Beside the lists, not among them: the machines of the group are connected once it answers.
      void s.loadGroup();
      void s.refreshMemory();
      // Grants already read may have changed while the machine was away; unread ones wait for the settings.
      if (s.stewards !== null) void s.loadStewards();
      if (open && reopened && s.openThread?.id === open.id) {
        await this.ctx.delegation.refreshDelegated(client);
        if (!current() || s.openThread?.id !== open.id) return;
        void s.loadDelegation(open.id);
        const held = s.coordination?.self.threadId === open.id;
        if (held || !s.openThread.agentSessionId) void s.loadCoordination(open.id, held && s.coordinationDirectory !== null);
      }
    } finally {
      projectRead.cancel(); threadRead.cancel(); accountRead.cancel(); permissionRead.cancel(); questionRead.cancel();
    }
  }
}
