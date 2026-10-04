import { Store, store } from './store.svelte';
import type { AgentAddress } from '@boite/contracts';
import {
  clearStoredEndpoint,
  forgetGroupOf,
  linkedCore,
  parsePairingLink,
  readEnvironments,
  removeEnvironment,
  servesThisPage,
  storeEndpoint,
  upsertEnvironment,
  readStoredEndpoint,
  fromTauri,
  type Endpoint,
  type StoredEnvironment
} from './endpoint';
import { strings } from './strings';
import { AutoSettingsSync } from './auto-settings-sync.svelte';
import { GroupLinks, holdsBack } from './group-links.svelte';

export interface Machine {
  id: string;
  label: string;
  store: Store;
  icon?: MachineIconName;
  /** Set when the group brought this machine here: its id in the roster. Such a machine goes when the group drops it. */
  coreId?: string;
  /** The group that brought it. */
  groupId?: string;
}

export function isThisPC(machine: Machine): boolean {
  if (machine.store.localCore) return true;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(machine.store.endpointUrl ?? machine.id).hostname); }
  catch { return false; }
}

export const machineIcons = ['desktop', 'laptop', 'server', 'rack', 'cloud', 'cpu'] as const;
export type MachineIconName = typeof machineIcons[number];
const PROFILE_KEY = 'boite.machine-profiles';
function profileKey(machine: Machine): string {
  const core = machine.store.core;
  return core?.hostname ? JSON.stringify([core.hostname, core.dataDir, core.channel]) : machine.id;
}
function profiles(): Record<string, { label: string; icon?: MachineIconName }> {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) ?? '{}') ?? {}; } catch { return {}; }
}

/** What a machine that has not answered yet is called: its address, never "This PC". */
function hostOf(url: string | null): string | undefined {
  try { return url === null ? undefined : new URL(url).host; } catch { return undefined; }
}

/** A connection's URL is also its identity in the workspace and saved list. */
function endpointIdentity(endpoint: Endpoint): { id: string; host: string } | null {
  try {
    const url = new URL(endpoint.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { id: url.toString().replace(/\/+$/, ''), host: url.host };
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
  readonly settingsSync = new AutoSettingsSync(() => this.machines, profileKey);
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
  #generation = 0;
  #lifecycle = 0;

  #current(lifecycle: number): boolean {
    return lifecycle === this.#lifecycle;
  }

  #primaryMachine(selected: Endpoint | null, remembered: StoredEnvironment[], before: StoredEnvironment[] = []): Machine {
    // A machine the group brought stays one when it is the machine this window opens on. When its saved entry
    // went during the boot, its key refused, what the entry said before still holds: the group may drop it.
    const brought = remembered.find(e => e.url === store.endpointUrl) ?? before.find(e => e.url === store.endpointUrl);
    const machine: Machine = {
      id: store.endpointUrl ?? 'local',
      label: remembered.find(e => e.url === selected?.url)?.label ?? (store.localCore ? strings.machines.local : store.core?.hostname ?? hostOf(store.endpointUrl)) ?? strings.machines.local,
      store,
      ...(brought?.coreId === undefined ? {} : { coreId: brought.coreId }),
      ...(brought?.groupId === undefined ? {} : { groupId: brought.groupId })
    };
    this.restoreProfile(machine);
    return machine;
  }

  async #addFakeMachine(lifecycle: number): Promise<void> {
    const { FakeClient } = await import('./fake-client');
    if (!this.#current(lifecycle)) return;
    const remote = new Store();
    remote.machineId = 'http://builder.test';
    remote.visible = false;
    remote.attach(new FakeClient({ coreId: 'fake-builder', coreName: 'Builder', publicUrl: 'https://builder.test' }));
    await remote.connect();
    if (!this.#current(lifecycle)) {
      remote.client?.close();
      remote.detach();
      return;
    }
    remote.booted = true;
    if (remote.core) remote.core.os = 'linux';
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
  }

  async #connectShellLocal(lifecycle: number): Promise<void> {
    if (!window.__TAURI_INTERNALS__ || store.localCore) return;
    const local = await fromTauri();
    if (!this.#current(lifecycle)) return;
    if (local && local.url !== store.endpointUrl) await this.add(local, strings.machines.local);
  }

  async #adoptPopulatedJournal(lifecycle: number): Promise<void> {
    // A fresh Dev core may have no threads while an older core on this PC has a journal.
    // The name a core reports is its own word: a machine the group brought never becomes the page's own by claiming this PC's.
    const populated = store.localCore && store.threads.length === 0 && store.core?.hostname
      ? this.machines.find(m => m.store !== store && m.coreId === undefined && m.store.connection === 'ready' && m.store.threads.length > 0 && m.store.core?.hostname === store.core?.hostname)
      : undefined;
    if (!populated) return;
    await store.switchEnvironment(populated.id);
    if (!this.#current(lifecycle) || store.connection !== 'ready') return;
    populated.store.client?.close();
    populated.store.detach();
    this.machines = [{ id: populated.id, label: populated.label, icon: populated.icon, store }, ...this.machines.filter(m => m.store !== store && m !== populated)];
  }

  /** Which keys the group brought over plain HTTP may be sent where they were saved: asked before any of them is. */
  async #vet(): Promise<StoredEnvironment[]> {
    const saved = readEnvironments();
    const held = saved.filter(holdsBack);
    if (held.length === 0) return [];
    const anchors: Endpoint[] = saved.filter((e) => e.coreId === undefined && e.token !== '').map((e) => ({ url: e.url, token: e.token, paired: e.paired }));
    const local = window.__TAURI_INTERNALS__ ? await fromTauri().catch(() => null) : null;
    if (local && !anchors.some((e) => e.url === local.url)) anchors.push(local);
    return this.groups.vet(held, anchors);
  }

  /** The machine paired by hand a window falls back on: the one serving this page first. None in the shell, which has its own core. */
  #byHand(): StoredEnvironment | undefined {
    const byHand = readEnvironments().filter((e) => e.coreId === undefined && e.token !== '');
    return window.__TAURI_INTERNALS__ ? undefined : byHand.find((e) => servesThisPage(e.url)) ?? byHand[0];
  }

  /**
   * The stored core was refused its key: the key goes first, so nothing reads
   * it back, and the window opens on a machine paired by hand or on the
   * shell's own core.
   */
  #openElsewhere(): void {
    clearStoredEndpoint();
    const next = this.#byHand();
    if (next) storeEndpoint({ url: next.url, token: next.token, ...(next.paired ? { paired: true } : {}) });
  }

  /**
   * `thread` comes from a notification's `?thread=` link. The page's own core
   * opens it as it boots, before any other machine is waited on; a thread of
   * another remembered machine that served the page opens once that one is in.
   */
  async boot(thread: string | null = null): Promise<void> {
    this.settled = false;
    try {
      await this.#boot(thread);
    } finally {
      this.settled = true;
    }
  }

  async #boot(thread: string | null): Promise<void> {
    const lifecycle = ++this.#lifecycle;
    const generation = this.#generation;
    store.visible = true;
    this.active = store;
    try {
      this.view = localStorage.getItem('boite.thread-view') === 'recent' ? 'recent' : 'projects';
    } catch {
      /* session only */
    }
    // The window would open on a machine whose key is held back, the stored one or the one a `?core=`
    // link names: it waits for the answer, and on a refusal that key is sent nowhere.
    // Both count: a link the owner declines falls back on the stored core.
    const saved = readEnvironments();
    const stored = readStoredEndpoint()?.url;
    const gated = [linkedCore(), stored].filter((url): url is string => typeof url === 'string' && saved.some((e) => e.url === url && holdsBack(e)));
    const vetting = this.#vet().catch(() => [] as StoredEnvironment[]);
    if (gated.length > 0) {
      const cleared = await vetting;
      if (!this.#current(lifecycle)) return;
      if (stored !== undefined && gated.includes(stored) && !cleared.some((e) => e.url === stored)) this.#openElsewhere();
    }
    const selected = readStoredEndpoint();
    await (thread === null ? store.boot() : store.boot(false, thread));
    if (!this.#current(lifecycle)) return;
    this.active = store;
    // Read after the boot: a pairing link it opened on has just made this machine one paired by hand.
    this.machines = [this.#primaryMachine(selected, readEnvironments(), saved)];
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('fake') === '1') {
      if (new URLSearchParams(window.location.search).get('machines') === '1') {
        await this.#addFakeMachine(lifecycle);
      }
      return;
    }
    const primaryEndpoint = readStoredEndpoint();
    await this.#connectShellLocal(lifecycle);
    if (!this.#current(lifecycle)) return;
    if (!store.localCore && primaryEndpoint?.url === store.endpointUrl && primaryEndpoint.token) {
      // An entry that went during the boot comes back as what it was: a machine the group brought is not made the owner's by being written again.
      const was = saved.find((e) => e.url === primaryEndpoint.url);
      upsertEnvironment({
        ...primaryEndpoint, paired: primaryEndpoint.paired ?? false, label: this.machines[0]!.label,
        ...(was?.coreId === undefined ? {} : { coreId: was.coreId }),
        ...(was?.groupId === undefined ? {} : { groupId: was.groupId })
      });
    }
    const others = readEnvironments().filter((e) => e.url !== store.endpointUrl);
    await Promise.all([
      ...others.filter((e) => !holdsBack(e)).map((e) => this.add(e, e.label)),
      // A key held back is sent once the machines paired by hand had their say, and only where it still stands.
      vetting.then((cleared) => Promise.all(others
        .filter((e) => holdsBack(e) && cleared.some((kept) => kept.url === e.url) && this.#current(lifecycle))
        .map((e) => this.add(e, e.label))))
    ]);
    if (!this.#current(lifecycle)) return;
    await this.#adoptPopulatedJournal(lifecycle);
    if (thread === null || generation !== this.#generation || !this.#current(lifecycle) || store.openThread?.id === thread) return;
    const origin = this.machines.find((m) => m.store !== store && m.store.endpointUrl !== null && servesThisPage(m.store.endpointUrl));
    if (origin) await this.select(origin.store, thread);
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
    if (!endpoint.grant && !endpoint.ticket && !endpoint.local)
      upsertEnvironment({ url: machine.id, token: endpoint.token, paired: endpoint.paired ?? false, label: machine.label });
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
    const target = existing?.store ?? new Store();
    target.client?.close();
    target.detach();
    target.machineId = id;
    target.visible = this.active === target;
    if (!existing) {
      const fresh: Machine = {
        id, label: label?.trim() || host, store: target,
        ...(endpoint.coreId === undefined ? {} : { coreId: endpoint.coreId }),
        ...(endpoint.groupId === undefined ? {} : { groupId: endpoint.groupId })
      };
      this.#distinct(fresh);
      this.machines = [...this.machines, fresh];
    }
    // Read back from the list: the name the core reports is written through the
    // reactive entry, or a card already drawn under the address keeps showing it.
    const machine = existing ?? this.machines.find((m) => m.store === target)!;
    const connecting = target.connectEndpoint({ ...endpoint, url: id });
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
    this.#rememberConnected(machine, endpoint, label, host);
    // Paired again by hand: from now on it is the owner's machine, not one the group may drop.
    if (existing && endpoint.ticket === undefined && existing.coreId !== undefined) {
      delete existing.coreId;
      delete existing.groupId;
      forgetGroupOf(existing.id);
      this.machines = [...this.machines];
    }
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

  async select(target: Store, threadId?: string, projectId?: string): Promise<void> {
    const generation = ++this.#generation;
    const previous = this.active;
    if (previous !== target) {
      void previous.suspend();
      if (generation !== this.#generation) return;
      target.sidebarWidth = previous.sidebarWidth;
      target.sidebarCollapsed = previous.sidebarCollapsed;
      target.search = previous.search;
      target.notifications = previous.notifications;
      this.active = target;
      const saved = readEnvironments().find(e => e.url === target.endpointUrl);
      if (saved) storeEndpoint(saved);
    }
    target.showChat();
    target.visible = true;
    if (threadId) await target.open(threadId);
    else if (projectId) target.startDraft(projectId);
    else if (target.openThread) await target.open(target.openThread.id);
    else await target.openWhereLeft();
  }

  async addLocalProjects(paths: string[]): Promise<void> {
    const local = this.machines.find(m => m.store.localCore)?.store;
    if (!local) { this.active.error = strings.connection.unavailable; return; }
    await local.addProjects(paths);
    await this.select(local, undefined, local.draft?.projectId ?? undefined);
  }

  async remove(id: string): Promise<void> {
    const machine = this.machines.find((m) => m.id === id);
    if (!machine || machine.store === store) return;
    ++this.#generation;
    this.settingsSync.forget(machine);
    machine.store.client?.close();
    machine.store.detach();
    this.machines = this.machines.filter((m) => m !== machine);
    removeEnvironment(id);
    if (this.active === machine.store) await this.select(store);
  }

  /**
   * The machine this window opened on is no longer one to send a key to: the
   * key is forgotten and the window goes back to its own core. The entry
   * follows the store, and a machine already listed at that address gives way.
   */
  async dropPrimary(id: string): Promise<void> {
    ++this.#generation;
    // A machine paired by hand first, never the address being dropped: a page that address
    // served would otherwise reach it again, with no key, and take it for the window's own.
    const next = this.#byHand();
    if (next && next.url !== id) await store.switchEnvironment(next.url);
    await store.forgetEnvironment(id);
    // Nothing to fall back on: the window shows a machine paired by hand that is still connected, if there is one.
    const other = store.connection === 'ready' ? undefined : this.machines.find((m) => m.store !== store && m.coreId === undefined && m.store.connection === 'ready');
    if (other && this.active === store) await this.select(other.store);
    const entry = this.#primaryMachine(readStoredEndpoint(), readEnvironments());
    const twin = this.machines.find((m) => m.store !== store && m.id === entry.id);
    if (twin) {
      this.settingsSync.forget(twin);
      twin.store.client?.close();
      twin.store.detach();
    }
    this.machines = [entry, ...this.machines.filter((m) => m.store !== store && m !== twin)];
  }

  async openNotification(key: string): Promise<void> {
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
