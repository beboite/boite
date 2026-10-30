import { Store, store } from './store.svelte';
import { INITIAL_PAGE_BYTES, RpcErrorCode, threadActive, withoutTrailingSlashes, type AgentAddress, type GroupCore } from '@boite/contracts';
import {
  forgetGroupOf,
  removeBrought,
  opensFromLink,
  parsePairingLink,
  readEnvironments,
  removeEnvironment,
  servesThisPage,
  storeEndpoint,
  upsertEnvironment,
  readStoredEndpoint,
  readMainMachine,
  storeMainMachine,
  type Endpoint,
  type MainMachine,
  opens
} from './endpoint';
import { fill, strings } from './strings';
import { threadAddress } from './chat-links';
import { RpcFailure } from './rpc-error';
import { onReveal, reveal } from './reveal';
import { AutoSettingsSync } from './auto-settings-sync.svelte';
import { GroupLinks } from './group-links.svelte';
import { limitsMachine, setNotificationCore, setPushHomeClient } from './notify';
import { appPage } from './app-origin';
import { bootWorkspace, byHand, hostOf, primaryMachine } from './workspace-boot';

export interface Machine {
  id: string;
  label: string;
  store: Store;
  icon?: MachineIconName;
  /** Set when the group brought this machine here: its id in the roster. Such a machine goes when the group drops it. */
  coreId?: string;
  /** The group that brought it. */
  groupId?: string;
  /** Which admission of that machine the group listed when it brought it. */
  epoch?: number;
}

export function isThisPC(machine: Machine): boolean {
  if (machine.store.localCore) return true;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(machine.store.endpointUrl ?? machine.id).hostname); }
  catch { return false; }
}

/**
 * A machine's name on screen. This computer under the default name goes by
 * its own: in a group every PC is "this PC" to itself, which tells nobody apart.
 */
export function machineName(machine: Machine): string {
  return isThisPC(machine) && localDefault(machine.label) && machine.store.core?.hostname ? machine.store.core.hostname : machine.label;
}

/**
 * The default name of this computer, as saved in any language the app spoke
 * then (English, French), or by an older version. The French one is written
 * out rather than read: its catalogue loads only once the app speaks French.
 */
function localDefault(label: string): boolean {
  return label === strings.machines.local || ['This PC', 'Ce PC', 'My computer', 'This computer'].includes(label);
}

/** A machine in a list of machines: this computer by its name and "(you)", once it has a name of its own. */
export function listedName(machine: Machine): string {
  const name = machineName(machine);
  return isThisPC(machine) && !localDefault(name) ? fill(strings.machines.you, { machine: name }) : name;
}

/**
 * What a machine's connection means to the user. A remote machine that is
 * simply switched off, a laptop opened now and then, is `offline` and stays
 * quiet: nothing was lost. It is `lost`, the state worth a warning, when the
 * user must act or depends on it: a machine that refused this device's key, the
 * machine this window runs on, this PC's own core, or a machine whose last
 * known threads still had a turn queued, running or waiting when it went away.
 */
export type MachineHealth = 'ready' | 'connecting' | 'offline' | 'lost';

export function machineHealth(machine: Machine, primary: Store): MachineHealth {
  const s = machine.store;
  if (s.connection === 'ready') return 'ready';
  if (s.connection !== 'closed' && !s.booted) return 'connecting';
  const needed = s.pairingRequired || s === primary || isThisPC(machine) || s.threads.some(t => threadActive(t.status));
  return needed ? 'lost' : 'offline';
}

/**
 * How long the machine the window opens on is given to say hello before the
 * other remembered machines are connected without it. The service worker
 * gives the page itself about as long (`SHELL_PATIENCE_MS` in `public/sw.js`).
 */
export const PRIMARY_PATIENCE_MS = 2000;
/** How long the window keeps its loading screen while another machine may still answer in place of the one it opened on. */
export const STAND_IN_WAIT_MS = 6000;

export const machineIcons = [
  'desktop', 'laptop', 'phone', 'tablet', 'apple', 'server', 'rack', 'nas',
  'database', 'cloud', 'cpu', 'router', 'terminal', 'bot', 'gamepad', 'tv', 'house',
] as const;
export type MachineIconName = typeof machineIcons[number];
const PROFILE_KEY = 'boite.machine-profiles';
function profileKey(machine: Machine): string {
  const core = machine.store.core;
  return core?.hostname ? JSON.stringify([core.hostname, core.dataDir, core.channel]) : machine.id;
}
function profiles(): Record<string, { label: string; icon?: MachineIconName }> {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) ?? '{}') ?? {}; } catch { return {}; }
}

/** A connection's URL is also its identity in the workspace and saved list. */
function endpointIdentity(endpoint: Endpoint): { id: string; host: string } | null {
  try {
    const url = new URL(endpoint.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { id: withoutTrailingSlashes(url.toString()), host: url.host };
  } catch {
    return null;
  }
}

/** Each host keeps its own ids, credentials and pending requests. */
export class Workspace {
  machines = $state<Machine[]>([]);
  active = $state(store);
  view = $state<'projects' | 'recent'>('projects');
  error = $state<string | null>(null);
  /** Selections still landing: until they have, the screen is on its way somewhere (`view-history.svelte.ts`). */
  selecting = $state(0);
  readonly settingsSync = new AutoSettingsSync(() => this.machines, machineName);
  /** Connects the other machines of a group and drops the ones that left it. */
  readonly groups = new GroupLinks(this);
  /** The store of the core this page booted on: never removed, whatever a group says. */
  readonly primary: Store = store;
  /**
   * Every machine this device remembers is in the list, connected or not. Until
   * then a member of the group may only look missing, and asking for a ticket
   * to it would make a second key for a machine this device already holds one for.
   */
  settled = $state(false);
  /**
   * The machine the window opened on has not answered and another one may
   * still be shown in its place: the window keeps its loading screen instead
   * of drawing a dead machine and its error for the moment that takes.
   */
  waiting = $state(false);
  /**
   * The machine the owner chose to open on at every start; null while a start
   * opens on the machine shown last. Kept on this device: a phone and a
   * computer each have their own.
   */
  main = $state<MainMachine | null>(readMainMachine());
  #generation = 0;
  /** The latest notification tap waiting for the machine its thread is on. */
  #memberTap = 0;
  #lifecycle = 0;

  /**
   * The connected machines or, before the first connection, the one store the
   * app runs on, under the id `local` that only the caller's own keys read.
   */
  machinesOr(store: Store): Machine[] {
    return this.machines.length ? this.machines : [{ id: 'local', label: strings.machines.local, store }];
  }

  #current(lifecycle: number): boolean {
    return lifecycle === this.#lifecycle;
  }

  /**
   * `thread` comes from a notification's `?thread=` link. The page's own core
   * opens it as it boots, before any other machine is waited on; a thread of
   * another remembered machine that served the page opens once that one is in.
   */
  async boot(thread: string | null = null): Promise<void> {
    this.settled = false;
    const lifecycle = this.#lifecycle + 1;
    // A link in the address bar is the owner asking for that machine: its answer is waited for, whatever it is.
    this.waiting = !opensFromLink();
    const hold = setTimeout(() => { if (this.#current(lifecycle)) this.waiting = false; }, STAND_IN_WAIT_MS);
    try {
      await this.#boot(thread);
    } finally {
      clearTimeout(hold);
      this.settled = true;
      this.waiting = false;
    }
  }

  /**
   * Another machine may be shown in place of the one the window opened on,
   * which has not answered. Never in place of the shell's own core, which the
   * shell brings back itself, and not before an address is known: the shell is
   * still starting its core, or the owner is being asked about a link.
   */
  #mayStandIn(): boolean {
    return store.endpointUrl !== null && !store.localCore && store.connection !== 'ready'
      && (window.__TAURI_INTERNALS__ !== undefined || readEnvironments().some((e) => opens(e) && e.url !== store.endpointUrl));
  }

  /** Whether the machine the window opens on has still not said hello after `PRIMARY_PATIENCE_MS`, with another machine to show instead. */
  async #silent(booting: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = await Promise.race([
      booting.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), PRIMARY_PATIENCE_MS); })
    ]);
    clearTimeout(timer);
    return late && this.#mayStandIn();
  }

  /**
   * The machine the window opened on does not answer and another one does: the
   * window opens on that one, on the draft a start lands on, and starts there
   * next time unless the owner chose the machine a start opens on. A phone
   * paired with a laptop keeps working on the rest of the group while the
   * laptop is off. Nothing moves once the user went somewhere.
   */
  #standIn(lifecycle: number, generation: number): void {
    if (!this.#current(lifecycle)) return;
    const live = generation === this.#generation && this.active === store && store.page === 'chat' && this.#mayStandIn()
      ? this.machines.find((m) => m.store !== store && m.store.connection === 'ready')
      : undefined;
    if (live) {
      this.#moveTo(live.store);
      live.store.showChat();
      live.store.visible = true;
      void live.store.openLanding();
    }
    if (this.active !== store || !this.#mayStandIn()) this.waiting = false;
  }

  /** The machine the window opened on has ended its first attempt, after the others were connected without it. */
  #primaryAnswered(lifecycle: number, generation: number): void {
    if (!this.#current(lifecycle)) return;
    const machine = this.machines.find((m) => m.store === store);
    if (machine && store.connection === 'ready') {
      // It was listed under its address until it said who it is.
      if (machine.label === hostOf(store.endpointUrl) && store.core?.hostname) {
        machine.label = store.core.hostname;
        this.restoreProfile(machine);
        this.#distinct(machine);
        this.machines = [...this.machines];
      }
      // Another remembered address of this same core connected first: it goes, as it would have had it come second.
      for (const other of this.machines.filter((m) => m.store !== store && m.store !== this.active)) this.#discardAlias(other);
    }
    this.#standIn(lifecycle, generation);
  }

  async #addFakeMachine(lifecycle: number): Promise<void> {
    const store = this.primary;
    const { FakeClient } = await import('./fake-client');
    if (!this.#current(lifecycle)) return;
    const remote = new Store();
    remote.machineId = 'http://builder.test';
    remote.visible = false;
    // `?desktopUpdate=<phase>` makes it a Windows PC whose desktop app reports an update.
    const params = new URLSearchParams(window.location.search);
    const desktopApp = params.get('desktopUpdate') !== null;
    // `&load=<n>` streams on this machine too: a second machine at work feeds its own store.
    const load = params.get('load') ? { load: Number(params.get('load')), ...(params.get('loadtick') ? { loadTickMs: Number(params.get('loadtick')) } : {}) } : {};
    remote.attach(new FakeClient({ coreId: 'fake-builder', coreName: 'Builder', publicUrl: 'https://builder.test', desktopApp, ...load }));
    await remote.connect();
    if (!this.#current(lifecycle)) {
      remote.client?.close();
      remote.detach();
      return;
    }
    remote.booted = true;
    if (remote.core) remote.core.os = desktopApp ? 'windows' : 'linux';
    const machine = { id: remote.machineId, label: 'Builder', store: remote };
    this.restoreProfile(machine);
    this.machines = [...this.machines, machine];
    // The two fake machines are one group, so the group card has members to show.
    if (store.client && remote.client && (await store.client.call('group.get', {})) === null) {
      await store.client.call('group.create', { name: 'Home' });
      const { invite } = await store.client.call('group.invite', {});
      await remote.client.call('group.join', { invite });
      await Promise.all([store.loadGroup(), remote.loadGroup()]);
    }
    // `&remote=1` gives the open conversation a subagent on this machine; `&remote=away` then closes this machine's connection.
    const subagent = params.get('remote');
    if ((subagent === '1' || subagent === 'away') && store.client && remote.client) {
      await remote.client.call('settings.set', { groupThreads: true });
      await store.client.call('delegation.spawn', { threadId: 't-trace', machine: 'Builder', task: 'Build the release on this machine and report the artifact sizes.', title: 'Build the release on Builder', requestId: 'demo-remote-subagent' });
      if (subagent === 'away') remote.client.close();
    }
  }

  async #boot(thread: string | null): Promise<void> {
    const lifecycle = ++this.#lifecycle;
    const generation = this.#generation;
    return bootWorkspace(this, thread, {
      current: () => this.#current(lifecycle),
      navigationCurrent: () => generation === this.#generation,
      silent: (booting) => this.#silent(booting),
      standIn: () => this.#standIn(lifecycle, generation),
      primaryAnswered: () => this.#primaryAnswered(lifecycle, generation),
      // Behind DEV here too, so a release build drops the method and its fake client.
      addFakeMachine: () => (import.meta.env.DEV ? this.#addFakeMachine(lifecycle) : Promise.resolve())
    });
  }

  restoreProfile(machine: Machine): void {
    const saved = profiles()[profileKey(machine)];
    if (typeof saved?.label === 'string' && saved.label.trim()) machine.label = saved.label;
    if (saved?.icon && machineIcons.includes(saved.icon)) machine.icon = saved.icon;
    if (isThisPC(machine) && ['My computer', 'This computer'].includes(machine.label)) machine.label = strings.machines.local;
  }

  /**
   * Two machines under one name cannot be told apart in a list, and a link
   * named after a machine already listed looked like it reached that one. The
   * newcomer takes its address beside the name; the one already there keeps its own.
   */
  #distinct(machine: Machine): void {
    const taken = new Set(this.machines.filter(m => m.store !== machine.store).map(m => m.label.trim().toLowerCase()));
    if (!taken.has(machine.label.trim().toLowerCase())) return;
    const base = `${machine.label.trim()} (${hostOf(machine.store.endpointUrl ?? machine.id) ?? machine.id})`;
    let label = base;
    for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${base} ${n}`;
    machine.label = label;
  }

  /** The machine a pairing link reaches, and the listed machine at that address if there is one. */
  linkTarget(link: string): { host: string; machine: Machine | null } | null {
    const parsed = parsePairingLink(link);
    const identity = parsed && endpointIdentity({ url: parsed.url, token: '' });
    if (!identity) return null;
    return { host: identity.host, machine: this.machines.find(m => m.id === identity.id) ?? null };
  }

  customize(id: string, label: string, icon?: MachineIconName): void {
    const machine = this.machines.find(m => m.id === id);
    if (!machine || !label.trim() || (icon && !machineIcons.includes(icon))) return;
    machine.label = label.trim();
    this.#distinct(machine);
    machine.icon = icon;
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...profiles(), [profileKey(machine)]: { label: machine.label, icon } })); } catch { /* session only */ }
    const saved = readEnvironments().find(e => e.url === machine.id);
    if (saved) upsertEnvironment({ ...saved, label: machine.label });
    this.machines = [...this.machines];
  }

  /** A migrated connection follows group membership while retaining its existing address and display profile. */
  markGrouped(machine: Machine, groupId: string, core: GroupCore): void {
    machine.coreId = core.coreId;
    machine.groupId = groupId;
    machine.epoch = core.epoch;
    const saved = readEnvironments().find(entry => entry.url === machine.id);
    if (saved) upsertEnvironment({ ...saved, coreId: core.coreId, groupId, epoch: core.epoch });
    if (machine.store === this.primary && saved) storeEndpoint({ ...saved, coreId: core.coreId, groupId, epoch: core.epoch });
    this.machines = [...this.machines];
  }

  /**
   * What choosing this machine to open on is saved as. The app's own core, the
   * one the shell starts or in a browser the one that serves the page, is
   * named as such: the shell's takes another port at every start. The fake
   * core has no address and stands for the page's own.
   */
  #mainOf(machine: Machine): MainMachine {
    const s = machine.store;
    if (s.localCore || servesThisPage(machine.id) || (s === store && s.endpointUrl === null)) return { local: true };
    return { url: machine.id, ...(machine.coreId === undefined || machine.groupId === undefined ? {} : { coreId: machine.coreId, groupId: machine.groupId }) };
  }

  /** Whether this is the machine the owner chose to open on. One the group brought is the same machine at whatever address it gives now. */
  isMain(machine: Machine): boolean {
    const main = this.main;
    if (main === null) return false;
    const mine = this.#mainOf(machine);
    if ('local' in main || 'local' in mine) return 'local' in main && 'local' in mine;
    return main.url === mine.url || (main.coreId !== undefined && main.coreId === mine.coreId && main.groupId === mine.groupId);
  }

  /**
   * The owner chooses the machine every start opens on, or with null goes back
   * to the machine shown last. Nothing moves now: the window stays where it is,
   * and a start on a machine that does not answer still opens on another.
   */
  setMain(machine: Machine | null): void {
    this.main = machine === null ? null : this.#mainOf(machine);
    storeMainMachine(this.main);
  }

  setView(view: 'projects' | 'recent'): void {
    this.view = view;
    try {
      localStorage.setItem('boite.thread-view', view);
    } catch {
      /* session only */
    }
  }

  /** Two URLs can reach the same core; keep the already connected machine. */
  #discardAlias(machine: Machine): boolean {
    const target = machine.store;
    // The name, folder and channel a core reports are its own word. A machine the group brought may
    // report anyone's, so it never makes another machine pass for its duplicate.
    const alias = target.core?.hostname && this.machines.find(m => m.store !== target && m.coreId === undefined && m.store.core?.hostname && profileKey(m) === profileKey(machine));
    if (!alias) return false;
    target.client?.close();
    target.detach();
    this.machines = this.machines.filter(m => m.store !== target);
    removeEnvironment(machine.id);
    this.error = null;
    return true;
  }

  /** Keep a connected machine's display name and resumable session credentials. */
  #rememberConnected(machine: Machine, endpoint: Endpoint, label: string | undefined, host: string): void {
    machine.label = label?.trim() || machine.store.core?.hostname || host;
    this.restoreProfile(machine);
    this.#distinct(machine);
    // Grant and ticket credentials are persisted by WsClient's onSession, never the grant itself.
    // A machine the group brought is written back as one: another window may have dropped its entry meanwhile.
    if (!endpoint.grant && !endpoint.ticket && !endpoint.local)
      upsertEnvironment({
        url: machine.id, token: endpoint.token, paired: endpoint.paired ?? endpoint.signs !== undefined, label: machine.label,
        ...(endpoint.signs === undefined ? {} : { signs: endpoint.signs }),
        ...(machine.coreId === undefined ? {} : { coreId: machine.coreId }),
        ...(machine.groupId === undefined ? {} : { groupId: machine.groupId }),
        ...(machine.epoch === undefined ? {} : { epoch: machine.epoch })
      });
    else {
      const saved = readEnvironments().find((e) => e.url === machine.id);
      if (saved) upsertEnvironment({ ...saved, label: machine.label });
    }
    this.machines = [...this.machines];
    if (machine.store === store) {
      const saved = readEnvironments().find((e) => e.url === machine.id);
      if (saved) storeEndpoint(saved);
    }
  }

  /**
   * `quiet` is a connection nobody asked for by hand, a machine the group
   * names: a failure writes no error under the add form, and a machine that
   * was only tried is not left in the list.
   */
  async add(endpoint: Endpoint, label?: string, quiet = false): Promise<boolean> {
    const lifecycle = this.#lifecycle;
    const identity = endpointIdentity(endpoint);
    const fail = (message: string): false => {
      if (!quiet) this.error = message;
      return false;
    };
    if (!identity) return fail(strings.machines.invalidUrl);
    const { id, host } = identity;
    const existing = this.machines.find((m) => m.id === id);
    // Only a machine that answered is a duplicate. One still retrying holds a
    // key its core refuses, and on a phone that machine is the page's own,
    // which cannot be removed: the new link has to be able to replace the key.
    if (existing && existing.store.connection === 'ready') return fail(strings.machines.duplicate);
    // A machine paired by hand at this address stays what it is: the group neither replaces its key nor claims it.
    if (existing && endpoint.ticket !== undefined && existing.coreId !== endpoint.coreId) return false;
    // The phone app's window opened on no machine: the first one added becomes the one it shows.
    // A first add that failed left it detached and out of the list: the next one takes it again.
    const adopt = !existing && appPage() && !store.localCore && (store.endpointUrl === null || !this.machines.some((m) => m.store === store));
    const target = existing?.store ?? (adopt ? store : new Store());
    target.client?.close();
    target.detach();
    target.machineId = id;
    target.visible = this.active === target;
    if (!existing) {
      const fresh: Machine = {
        id, label: label?.trim() || host, store: target,
        ...(endpoint.coreId === undefined ? {} : { coreId: endpoint.coreId }),
        ...(endpoint.groupId === undefined ? {} : { groupId: endpoint.groupId }),
        ...(endpoint.coreId === undefined || endpoint.epoch === undefined ? {} : { epoch: endpoint.epoch })
      };
      this.#distinct(fresh);
      this.machines = adopt ? [fresh, ...this.machines.filter((m) => m.store !== store)] : [...this.machines, fresh];
    }
    // Read back from the list: the name the core reports is written through the
    // reactive entry, or a card already drawn under the address keeps showing it.
    const machine = existing ?? this.machines.find((m) => m.store === target)!;
    // The primary pairing must survive reload before draft hydration finishes.
    const connecting = target.connectEndpoint({ ...endpoint, url: id }, target === store);
    const client = target.client;
    await connecting;
    // A later add replaced this attempt's client: the outcome is that one's to report.
    if (target.client !== client) return false;
    if (!this.#current(lifecycle) || !this.machines.some((m) => m.store === target)) {
      if (!this.machines.some((m) => m.store === target)) {
        target.client?.close();
        target.detach();
      }
      return false;
    }
    if (target.connection !== 'ready') {
      // A ticket that opened nothing leaves no key to retry with: the group asks for another.
      if (endpoint.ticket !== undefined && !existing) {
        target.client?.close();
        target.detach();
        this.machines = this.machines.filter((m) => m.store !== target);
      }
      return fail(`${machine.label}: ${target.error ?? strings.connection.closed}`);
    }
    if (this.#discardAlias(machine)) return true;
    // Paired again by hand: from now on it is the owner's machine, not one the group may drop.
    // The marks go before the key is written back, so neither place it is saved in keeps them.
    if (existing && endpoint.ticket === undefined && endpoint.coreId === undefined && existing.coreId !== undefined) {
      delete existing.coreId;
      delete existing.groupId;
      delete existing.epoch;
      forgetGroupOf(existing.id);
    }
    this.#rememberConnected(machine, endpoint, label, host);
    if (!quiet) this.error = null;
    return true;
  }

  async pair(link: string, label: string): Promise<boolean> {
    const parsed = parsePairingLink(link);
    if (!parsed) {
      this.error = strings.errors.pairingLink;
      return false;
    }
    return this.add({ ...parsed, token: '' }, label);
  }

  /**
   * The window moves to `target`, which takes over the sidebar, the search and
   * the notifications as they were. It is where the next start opens, unless
   * the owner chose a machine for that (`main`).
   */
  #moveTo(target: Store): void {
    const previous = this.active;
    if (previous === target) return;
    void previous.suspend();
    target.sidebarWidth = previous.sidebarWidth;
    target.sidebarCollapsed = previous.sidebarCollapsed;
    target.search = previous.search;
    target.notifications = previous.notifications;
    this.active = target;
    const saved = readEnvironments().find(e => e.url === target.endpointUrl);
    if (saved) storeEndpoint(saved);
  }

  /** A named draft, a project's fresh draft, or the machine's last visit when no destination is given. */
  async select(target: Store, threadId?: string, projectId?: string | null, options: { fresh?: boolean; draftId?: string } = {}): Promise<void> {
    this.selecting += 1;
    try {
      await this.#select(target, threadId, projectId, options);
    } finally {
      this.selecting -= 1;
    }
  }

  async #select(target: Store, threadId: string | undefined, projectId: string | null | undefined, options: { fresh?: boolean; draftId?: string }): Promise<void> {
    ++this.#generation;
    this.#moveTo(target);
    target.visible = true;
    if (threadId) await target.open(threadId);
    else if (projectId !== undefined || options.draftId !== undefined) target.startDraft(projectId, options);
    else {
      target.showChat();
      if (target.openThread) await target.open(target.openThread.id);
      else await target.openWhereLeft();
    }
  }

  async addLocalProjects(paths: string[]): Promise<void> {
    const local = this.machines.find(m => m.store.localCore)?.store;
    if (!local) { this.active.error = strings.connection.unavailable; return; }
    await local.addProjects(paths);
    await this.select(local, undefined, local.draft?.projectId ?? undefined);
  }

  /** `dropped`: the group dropped this machine, as opposed to it having moved or the owner taking it off the list. */
  async remove(id: string, dropped = false): Promise<void> {
    const machine = this.machines.find((m) => m.id === id);
    if (!machine || machine.store === store) return;
    ++this.#generation;
    this.settingsSync.forget(machine);
    machine.store.client?.close();
    machine.store.detach();
    this.machines = this.machines.filter((m) => m !== machine);
    if (machine.coreId === undefined) removeEnvironment(id);
    else removeBrought(id, { coreId: machine.coreId, ...(machine.groupId === undefined ? {} : { groupId: machine.groupId }) }, dropped ? machine.epoch ?? Number.MAX_SAFE_INTEGER : undefined);
    if (this.active === machine.store) await this.select(store);
  }

  /**
   * The machine this window opened on is no longer one to send a key to: the
   * key is forgotten and the window goes back to its own core. The entry
   * follows the store, and a machine already listed at that address gives way.
   */
  async dropPrimary(id: string, dropped = false): Promise<void> {
    ++this.#generation;
    // A machine paired by hand first, never the address being dropped: a page that address
    // served would otherwise reach it again, with no key, and take it for the window's own.
    const next = byHand();
    if (next && next.url !== id) await store.switchEnvironment(next.url);
    const was = this.machines.find((m) => m.store === store);
    const brought = was?.coreId === undefined ? undefined : { coreId: was.coreId, ...(was.groupId === undefined ? {} : { groupId: was.groupId }) };
    await store.forgetEnvironment(id, brought, dropped ? was?.epoch ?? Number.MAX_SAFE_INTEGER : undefined);
    // Nothing to fall back on: the window shows a machine paired by hand that is still connected, if there is one.
    const other = store.connection === 'ready' ? undefined : this.machines.find((m) => m.store !== store && m.coreId === undefined && m.store.connection === 'ready');
    if (other && this.active === store) await this.select(other.store);
    const entry = primaryMachine(this, readStoredEndpoint(), readEnvironments());
    const twin = this.machines.find((m) => m.store !== store && m.id === entry.id);
    if (twin) {
      this.settingsSync.forget(twin);
      twin.store.client?.close();
      twin.store.detach();
    }
    this.machines = [entry, ...this.machines.filter((m) => m.store !== store && m !== twin)];
  }

  /**
   * A notification another machine of the group sent through the core of this
   * page: the thread is on that machine, which the group may still be
   * connecting. False when it is not connected within `patience`.
   */
  async openMemberThread(coreId: string, threadId: string, patience = 90_000): Promise<boolean> {
    // Longer than the group's own wait between two attempts at a machine (a minute), so one retry fits.
    const target = await this.#memberStore(coreId, patience);
    if (typeof target === 'string') return false;
    await this.select(target, threadId);
    return true;
  }

  /**
   * The store of a machine of the group once it is connected. `superseded`
   * when a newer tap, a closed workspace or the user opening something else
   * took over meanwhile; `timeout` when it did not connect in time.
   */
  async #memberStore(coreId: string, patience: number): Promise<Store | 'superseded' | 'timeout'> {
    const lifecycle = this.#lifecycle;
    const tap = ++this.#memberTap;
    const active = this.active;
    const navigation = active.navigationGeneration;
    const deadline = Date.now() + patience;
    for (;;) {
      if (tap !== this.#memberTap || !this.#current(lifecycle) || this.active !== active || active.navigationGeneration !== navigation) return 'superseded';
      const machine = this.machines.find((entry) => GroupLinks.coreOf(entry) === coreId && entry.store.connection === 'ready');
      if (machine !== undefined) return machine.store;
      if (Date.now() >= deadline) return 'timeout';
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * What the worker posts when a notification is tapped with a window open:
   * Limits, or a thread. True when a thread opens, so the phone shows the chat.
   */
  workerMessage(data: unknown): boolean {
    const message = (data ?? {}) as { type?: unknown; threadId?: unknown; key?: unknown; core?: unknown };
    if (message.type === 'boite.open-limits') { void this.openLimits(message.core); return false; }
    if (message.type !== 'boite.open-thread' || typeof message.threadId !== 'string') return false;
    if (typeof message.key === 'string' && message.core === undefined) void this.openNotification(message.key);
    else void this.openFromWorker(message.threadId, message.core);
    return true;
  }

  /** A notification the worker reports tapped: its thread on the machine it names, else on the core that served the page. */
  async openFromWorker(threadId: string, member?: unknown): Promise<void> {
    if (typeof member === 'string' && /^[0-9a-f]{64}$/.test(member)) {
      await this.openMemberThread(member, threadId);
      return;
    }
    const machine = this.machines.find((entry) => entry.store.endpointUrl !== null && servesThisPage(entry.store.endpointUrl));
    if (machine) await this.select(machine.store, threadId);
  }

  /** The boot, on the thread a notification tapped with no window open named, on whichever machine it is. */
  async bootAt(tapped: { thread: string | null; member: string | null; key?: string | null; limits?: boolean }): Promise<void> {
    // A tapped limit alert: Limits, on the machine it names once the group has connected it.
    if (tapped.limits) {
      await this.boot(null);
      await this.openLimits(tapped.member);
      return;
    }
    // A page notice about a machine with no group id: this window's own key names the machine.
    if (tapped.key) {
      await this.boot(null);
      await this.openNotification(tapped.key);
      return;
    }
    await this.boot(tapped.member === null ? tapped.thread : null);
    if (tapped.member !== null && tapped.thread !== null) await this.openMemberThread(tapped.member, tapped.thread);
  }

  /**
   * A tapped limit alert the worker reports: Limits on the machine of the group
   * it names, else on the core that served the page. A machine of the group
   * still connecting gets the same few seconds a thread does.
   */
  async openLimits(member?: unknown): Promise<void> {
    let target: Store | undefined;
    if (typeof member === 'string' && /^[0-9a-f]{64}$/.test(member)) {
      // The same guards as a thread's tap: a newer tap or the user's own navigation wins.
      const found = await this.#memberStore(member, 10_000);
      if (found === 'superseded') return;
      if (found !== 'timeout') target = found;
    }
    target ??= this.machines.find((entry) => entry.store.endpointUrl !== null && servesThisPage(entry.store.endpointUrl))?.store ?? store;
    await this.select(target);
    target.showSettings('limits');
  }

  async openNotification(key: string): Promise<void> {
    // A limit alert names a machine and no thread: its Limits page opens.
    const limits = limitsMachine(key);
    if (limits !== null) {
      const target = limits ? this.machines.find((m) => m.store.machineId === limits || m.id === limits)?.store : store;
      if (!target) return;
      await this.select(target);
      target.showSettings('limits');
      return;
    }
    let machineId: string | null = null,
      threadId = key;
    try {
      const pair: unknown = JSON.parse(key);
      if (Array.isArray(pair) && pair.length === 2 && pair.every((v) => typeof v === 'string'))
        [machineId, threadId] = pair as [string, string];
    } catch {
      /* legacy local id */
    }
    const target = machineId ? this.machines.find((m) => m.store.machineId === machineId || m.id === machineId)?.store : store;
    if (target) await this.select(target, threadId);
  }

  /**
   * The machine whose core has this id: by the id its hello gave, else by the
   * one the group knows it by before it answered. A connected one wins over a
   * twin still connecting under another address.
   */
  machineOf(coreId: string): Machine | null {
    const matches = this.machines.filter((machine) => machine.store.core?.coreId === coreId || GroupLinks.coreOf(machine) === coreId);
    return matches.find((machine) => machine.store.connection === 'ready') ?? matches[0] ?? null;
  }

  /** Resolve an answer's thread address on its owning machine, including an unlisted archive. */
  async openThreadLink(owner: Store, from: string | undefined, where: string | null, threadId: string): Promise<void> {
    const generation = ++this.#generation, lifecycle = this.#lifecycle;
    const active = this.active, navigation = active.navigationGeneration;
    const client = owner.client, ownerNavigation = owner.navigationGeneration;
    const current = () => generation === this.#generation && lifecycle === this.#lifecycle && this.active === active
      && active.navigationGeneration === navigation && owner.client === client
      && owner.navigationGeneration === ownerNavigation;
    const core = where !== null && /^[0-9a-f]{64}$/.test(where) ? where : null;
    const slug = (name: string) => name.trim().replace(/\s+/g, '-').toLowerCase();
    const names = (name: string) => where === null || where === 'here' || slug(name) === where.toLowerCase()
      || (/^[0-9a-f]{6,}$/.test(where) && name.startsWith(where));
    const connected = this.machines.filter(machine => machine.store.connection === 'ready');
    const named = connected.filter(machine => core !== null ? machine.store.core?.coreId === core
      : names(machine.label) || names(machine.store.core?.coreId ?? ''));
    const target = where === null || where === 'here' ? owner : named.length === 1 ? named[0]!.store : undefined;
    if (!current()) return;
    if (where !== null && where !== 'here' && named.length > 1) { owner.error = strings.agentMessages.threadMissing; return; }
    if (target?.client && target.connection === 'ready') {
      const targetClient = target.client, targetNavigation = target.navigationGeneration;
      const targetCurrent = () => current() && target.client === targetClient && target.connection === 'ready'
        && target.navigationGeneration === targetNavigation;
      try {
        // The active list excludes archives. Probe only the contextual owner, without navigating or subscribing.
        if (!target.threads.some(thread => thread.id === threadId))
          await targetClient.call('threads.get', { threadId, limit: 1, maxBytes: INITIAL_PAGE_BYTES,
            compactTools: true, compactFiles: true, compactImages: true, compactToolParts: true });
        if (targetCurrent()) await this.select(target, threadId);
        return;
      } catch (error) {
        if (!targetCurrent()) return;
        if (!(error instanceof RpcFailure) || error.code !== RpcErrorCode.NotFound) {
          owner.error = error instanceof Error ? error.message : String(error);
          return;
        }
        // A resolved explicit owner stays authoritative even if a directory repeats its name elsewhere.
        if (where !== null) { owner.error = strings.agentMessages.threadMissing; return; }
      }
    }
    // An offline source can open an explicit ready target, but cannot resolve another address.
    if (owner.connection !== 'ready') return;
    // An unqualified address can still name the sole known remote holder after local NotFound.
    const holders = this.machines.filter(machine => machine.store.connection === 'ready'
      && machine.store.threads.some(thread => thread.id === threadId));
    if (where === null && holders.length === 1) { await this.select(holders[0]!.store, threadId); return; }
    if (client && from) {
      try {
        const [{ self }, { agents }] = await Promise.all([client.call('collaboration.get', { threadId: from }), client.call('collaboration.directory', { threadId: from })]);
        if (!current() || owner.connection !== 'ready') return;
        const found = agents.filter(agent => agent.threadId === threadId && (core !== null ? agent.coreId === core
          : where === 'here' ? agent.coreId === self.coreId : names(agent.machine) || names(agent.coreId)));
        if (found.length === 1) { await this.openAgentThread(owner, self, found[0]!); return; }
      } catch { /* Coordination off on this thread: no contact names the core. */ }
    }
    if (current() && owner.connection === 'ready') owner.error = strings.agentMessages.threadMissing;
  }

  /** A click on a thread link `renderMarkdown` drew opens that thread; true when it was one. */
  followThreadLink(event: MouseEvent, owner: Store | undefined, from: string | undefined): boolean {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-thread-address]') : null;
    if (!anchor) return false;
    event.preventDefault();
    const address = threadAddress(anchor.dataset.threadAddress!);
    if (address && owner) void this.openThreadLink(owner, from, address.where, address.threadId);
    return true;
  }

  /** Resolve the authenticated core identity before using a machine-scoped thread id. */
  async openAgentThread(owner: Store, self: AgentAddress, address: AgentAddress): Promise<void> {
    const generation = ++this.#generation;
    const lifecycle = this.#lifecycle;
    const active = this.active;
    const navigation = active.navigationGeneration;
    let target: Store | undefined;
    if (address.coreId === self.coreId) target = owner;
    else {
      const candidates = this.machines.filter(machine => machine.store !== owner && machine.store.connection === 'ready');
      const identities = await Promise.all(candidates.map(async machine => {
        try {
          const view = await machine.store.client!.call('collaboration.get', { threadId: address.threadId });
          return { store: machine.store, coreId: view.self.coreId };
        }
        catch { return null; }
      }));
      if (generation !== this.#generation || lifecycle !== this.#lifecycle || navigation !== active.navigationGeneration) return;
      target = identities.find(identity => identity?.coreId === address.coreId)?.store;
    }
    if (!target) { owner.error = strings.coordination.machineNotConnected; return; }
    await this.select(target, address.threadId);
  }

  close(): void {
    ++this.#lifecycle;
    ++this.#generation;
    for (const machine of this.machines) {
      machine.store.client?.close();
      machine.store.detach();
    }
    this.machines = [];
    this.active = store;
  }
}

export const workspace = new Workspace();
// A toast about a machine this page does not serve names that machine as its pushes do.
setNotificationCore((store) => {
  const machine = workspace.machines.find((entry) => entry.store === store);
  return machine === undefined ? undefined : GroupLinks.coreOf(machine);
});
// Kinds changed while another machine is shown still reach the one holding the subscription.
setPushHomeClient((home) => workspace.machines.find((machine) => (machine.store.endpointUrl ?? '') === home)?.store.client ?? null);

// A desktop app's `ui.reveal`, answered by whichever machine's Store received it.
onReveal((from, target) => reveal(workspace, from, target));
