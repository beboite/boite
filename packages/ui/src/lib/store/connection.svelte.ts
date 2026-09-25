import type { CoreInfo, Principal, ThreadId } from '@boite/contracts';
import { WsClient, type Client, type ClientState, type ObservableClient } from '../client';
import { confirm } from '../confirm.svelte';
import { clearStoredEndpoint, refreshLocalEnvironment, fromTauri, shellEndpointError, parsePairingLink, readEnvironments, removeEnvironment, resolveEndpoint, servesThisPage, storeEndpoint, upsertEnvironment, type Endpoint, type StoredEnvironment } from '../endpoint';
import { onboardingSeen } from '../onboarding';
import { rightPanel } from '../right-panel.svelte';
import { fill, strings } from '../strings';
import { reconcileRows, unlistedPanels } from '../thread-rows';
import { work } from '../work-prefs.svelte';
import { installStatesOf } from './accounts.svelte';
import type { StoreContext } from './context';

export const UI_VERSION = '2.0.0-beta.1';

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
  /** The core is the one the shell started on this computer. */
  localCore = $state(false);
  localEndpointUrl = $state<string | null>(null);
  /** The cores this device remembers: pairing or connecting adds one, forgetting removes one. */
  environments = $state<StoredEnvironment[]>([]);
  machineStates = $state<Record<string, { state: ClientState; error?: string }>>({});
  booted = $state(false);
  /** The load in flight and the client it speaks to, so the two callers of `reload()` share one. */
  reloading: { client: Client; promise: Promise<void> } | null = null;
  #localRecovery: ReturnType<typeof setTimeout> | null = null;

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
    this.ctx.threads.openGeneration++;
    await this.ctx.threads.unsubscribe();
  }

  async connectEndpoint(endpoint: Endpoint): Promise<void> {
    const s = this.ctx.store;
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
        // looked at on, `&principal=session` answers as a paired phone, so the
        // screens a device is refused can be walked without pairing one.
        s.attach(
          new FakeClient({
            long: params.get('long') === '1',
            delegationDemo: params.get('team') === '1',
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
  }

  #rememberOnceReady(endpoint: Endpoint): void {
    const client = this.ctx.client;
    if (client === null || !observable(client)) return;
    const off = client.onState((state) => {
      if (state !== 'ready') return;
      off();
      storeEndpoint({ url: endpoint.url, token: endpoint.token, ...(endpoint.paired ? { paired: true } : {}) });
    });
    this.ctx.off.push(off);
  }

  attachEndpoint(endpoint: Endpoint, rememberActive = true): void {
    const url = endpoint.url;
    this.ctx.store.machineId = endpoint.local ? 'local' : url;
    const paired = endpoint.paired === true || endpoint.grant !== undefined;
    this.endpointUrl = url;
    this.paired = paired;
    this.localCore = endpoint.local === true;
    this.ctx.store.attach(
      new WsClient({
        url,
        token: endpoint.token,
        ...(endpoint.grant === undefined ? {} : { grant: endpoint.grant }),
        paired,
        // The session a grant became is this device's own credential: kept
        // where the next load reads it, so the link is opened once, ever.
        // The core joins the remembered environments with it, so switching
        // back later needs no new link.
        onSession: (session) => {
          if (rememberActive) storeEndpoint({ url, token: session.token, paired: true });
          this.environments = upsertEnvironment({ url, token: session.token, paired: true });
        },
        // Revoked from the desktop: the dead key goes here and in the
        // remembered cores, and the page says what to do rather than
        // retrying every ten seconds.
        onRevoked: () => {
          if (rememberActive) clearStoredEndpoint();
          this.environments = removeEnvironment(url);
          this.connection = 'closed';
          this.ctx.store.error = strings.errors.revoked;
        },
        clientName: window.__TAURI_INTERNALS__ === undefined ? 'pwa' : 'shell',
        version: UI_VERSION
      })
    );
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
    s.pairing = null;
    s.sessions = [];
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
    // A closed client of the shell's own core: its core may be gone, and the
    // shell starts another on this ask, maybe on a new port.
    if (client.state === 'closed' && await this.#followLocalCore(client) !== 'same') return;
    try {
      this.core = await client.connect();
      this.connection = client.state;
      this.principal = client.principal;
      s.error = null;
      await s.reload();
    } catch (error) {
      this.connection = client.state;
      this.ctx.fail(error);
    }
  }

  /** Point the UI at another core, from the Settings page. It stays remembered. */
  async connectTo(url: string, token: string): Promise<void> {
    storeEndpoint({ url, token });
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
    storeEndpoint({ url: env.url, token: env.token, ...(env.paired ? { paired: true } : {}) });
    await this.#switchTo({ url: env.url, token: env.token, ...(env.paired ? { paired: true } : {}) });
  }

  /**
   * Drop a remembered core from this device. Its key stays valid there until
   * revoked; forgetting the core under the UI falls back to the local one.
   */
  async forgetEnvironment(url: string): Promise<void> {
    this.environments = removeEnvironment(url);
    if (this.endpointUrl === url) await this.ctx.store.useLocalCore();
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

  /** Back to the core this shell started. Remembered cores stay remembered. */
  async useLocalCore(): Promise<void> {
    const s = this.ctx.store;
    clearStoredEndpoint();
    const endpoint = await resolveEndpoint();
    if (!endpoint) {
      this.ctx.client?.close();
      s.detach();
      this.connection = 'closed';
      s.error = strings.errors.noEndpoint;
      return;
    }
    await this.#switchTo(endpoint);
  }

  /**
   * `connect()` and the `ready` state handler both ask for this on every boot
   * and on every reconnect, and the second one used to send the same ten calls
   * again. It joins the load already in flight instead.
   */
  reload(): Promise<void> {
    const client = this.ctx.client;
    if (!client) return this.#load();
    // The load in flight belongs to the client that started it. A machine
    // switched under a slow boot used to hand the new client that same
    // promise, whose result `#load()` then discards for being the old one's,
    // so the new machine's store stayed empty until something asked again.
    if (this.reloading?.client === client) return this.reloading.promise;
    const promise = this.#load().finally(() => {
      if (this.reloading?.promise === promise) this.reloading = null;
    });
    this.reloading = { client, promise };
    return promise;
  }

  async #load(): Promise<void> {
    const s = this.ctx.store;
    const { accounts, requests } = this.ctx;
    const client = this.ctx.client;
    if (!client) return;
    const loginRevision = accounts.loginRevision;
    // The open thread's catch-up leaves ahead of the lists, so the text missed
    // during a drop does not wait for the slowest of them.
    const open = s.openThread;
    const reopened = open && s.visible ? s.open(open.id, false).catch((error: unknown) => this.ctx.fail(error)) : null;
    // One rejected call used to take the whole boot down: `Promise.all` jumped
    // to the catch, which only toasted, and projects, threads, providers and
    // accounts silently kept their pre-reconnect values under an app that
    // looked loaded. Each slice lands on its own now, and only what failed is
    // reported.
    const results = await Promise.allSettled([
      client.call('projects.list', {}),
      client.call('threads.list', {}),
      client.call('providers.list', {}),
      client.call('accounts.list', {}),
      client.call('settings.get', {}),
      client.call('scheduler.get', {}),
      client.call('permissions.list', {}),
      client.call('questions.list', {}),
      // The one owner-only call of the boot. A device asking for it is refused.
      s.owner ? client.call('accounts.logins', {}) : Promise.resolve([]),
      client.call('keybindings.get', {})
    ]);
    // A machine switched under a slow boot must not have this one's data
    // written into it: the store may already be serving another client.
    if (client !== this.ctx.client) return;
    const [projects, threads, providers, accountList, settings, scheduler, permissions, questions, logins, keybindings] = results;
    if (permissions.status === 'fulfilled') requests.mergePermissions(permissions.value, 'all');
    if (questions.status === 'fulfilled') requests.mergeQuestions(questions.value, 'all');
    if (projects.status === 'fulfilled') { s.projects = projects.value; this.ctx.projects.projectsAt = Date.now(); }
    if (threads.status === 'fulfilled') {
      // Held rows are patched, not replaced, so a reconnect redraws only what changed.
      s.threads = reconcileRows(s.threads, threads.value);
      // A list read before the open thread's markRead may answer after it.
      const read = reopened && s.openThread?.unread === false ? s.threads.find((t) => t.id === s.openThread?.id) : undefined;
      if (read) read.unread = false;
      // Archived while this client was away: their layouts would never be shown again.
      const listed = new Set(threads.value.map((t) => s.threadKey(t.id)));
      rightPanel.prune(unlistedPanels(s.machineId, listed, s.openThread ? s.threadKey(s.openThread.id) : null));
      // A device with no record of how it works: conversations already here, or
      // a tour already seen, mean an install from before the question.
      work.settle(threads.value.length > 0 || onboardingSeen());
    }
    if (providers.status === 'fulfilled') {
      s.providers = providers.value.loaded;
      s.rejectedProviders = providers.value.rejected;
      s.installStates = installStatesOf(providers.value.loaded);
    }
    if (accountList.status === 'fulfilled') {
      s.accounts = accountList.value;
      this.ctx.models.restoreModels();
    }
    if (logins.status === 'fulfilled') accounts.restoreLogins(logins.value, loginRevision);
    if (settings.status === 'fulfilled') s.settings = settings.value;
    if (keybindings.status === 'fulfilled') s.keybindings = keybindings.value;
    if (scheduler.status === 'fulfilled') s.scheduler = scheduler.value;
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined && failed.status === 'rejected') this.ctx.fail(failed.reason);
    // What `bench/startup.ts` reads: the first moment the app holds its data.
    if (typeof performance !== 'undefined' && performance.getEntriesByName('boite:ready').length === 0) performance.mark('boite:ready');
    void s.loadHarnessUpdates();
    if (open && reopened) {
      await reopened;
      // The socket resubscribed the agent and the team, but what they said
      // during the gap reached nobody: fetch it, as open() did for the thread.
      if (client === this.ctx.client && s.openThread?.id === open.id) {
        await this.ctx.delegation.refreshDelegated(client);
        void s.loadDelegation(open.id);
        if (s.coordination?.self.threadId === open.id) void s.loadCoordination(open.id, s.coordinationDirectory !== null);
      }
    }
  }
}
