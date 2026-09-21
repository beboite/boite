import { Store, store } from './store.svelte';
import {
  parsePairingLink,
  readEnvironments,
  removeEnvironment,
  storeEndpoint,
  upsertEnvironment,
  readStoredEndpoint,
  fromTauri,
  type Endpoint,
  type StoredEnvironment
} from './endpoint';
import { strings } from './strings';

export interface Machine {
  id: string;
  label: string;
  store: Store;
  icon?: MachineIconName;
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
  #generation = 0;
  #lifecycle = 0;

  #current(lifecycle: number): boolean {
    return lifecycle === this.#lifecycle;
  }

  #primaryMachine(selected: Endpoint | null, remembered: StoredEnvironment[]): Machine {
    const machine: Machine = {
      id: store.endpointUrl ?? 'local',
      label: remembered.find(e => e.url === selected?.url)?.label ?? (store.localCore ? strings.machines.local : store.core?.hostname) ?? strings.machines.local,
      store
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
    remote.attach(new FakeClient());
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
  }

  async #connectShellLocal(lifecycle: number): Promise<void> {
    if (!window.__TAURI_INTERNALS__ || store.localCore) return;
    const local = await fromTauri();
    if (!this.#current(lifecycle)) return;
    if (local && local.url !== store.endpointUrl) await this.add(local, strings.machines.local);
  }

  async #adoptPopulatedJournal(lifecycle: number): Promise<void> {
    // A fresh Dev core may have no threads while an older core on this PC has a journal.
    const populated = store.localCore && store.threads.length === 0 && store.core?.hostname
      ? this.machines.find(m => m.store !== store && m.store.connection === 'ready' && m.store.threads.length > 0 && m.store.core?.hostname === store.core?.hostname)
      : undefined;
    if (!populated) return;
    await store.switchEnvironment(populated.id);
    if (!this.#current(lifecycle) || store.connection !== 'ready') return;
    populated.store.client?.close();
    populated.store.detach();
    this.machines = [{ id: populated.id, label: populated.label, icon: populated.icon, store }, ...this.machines.filter(m => m.store !== store && m !== populated)];
  }

  async boot(): Promise<void> {
    const lifecycle = ++this.#lifecycle;
    store.visible = true;
    this.active = store;
    try {
      this.view = localStorage.getItem('boite.thread-view') === 'recent' ? 'recent' : 'projects';
    } catch {
      /* session only */
    }
    const selected = readStoredEndpoint();
    const remembered = readEnvironments();
    await store.boot();
    if (!this.#current(lifecycle)) return;
    this.active = store;
    this.machines = [this.#primaryMachine(selected, remembered)];
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
      upsertEnvironment({ ...primaryEndpoint, paired: primaryEndpoint.paired ?? false, label: this.machines[0]!.label });
    }
    await Promise.all(
      readEnvironments()
        .filter((e) => e.url !== store.endpointUrl)
        .map((e) => this.add(e, e.label))
    );
    if (!this.#current(lifecycle)) return;
    await this.#adoptPopulatedJournal(lifecycle);
  }

  restoreProfile(machine: Machine): void {
    const saved = profiles()[profileKey(machine)];
    if (typeof saved?.label === 'string' && saved.label.trim()) machine.label = saved.label;
    if (saved?.icon && machineIcons.includes(saved.icon)) machine.icon = saved.icon;
    if (isThisPC(machine) && ['My computer', 'This computer'].includes(machine.label)) machine.label = strings.machines.local;
  }

  customize(id: string, label: string, icon?: MachineIconName): void {
    const machine = this.machines.find(m => m.id === id);
    if (!machine || !label.trim() || (icon && !machineIcons.includes(icon))) return;
    machine.label = label.trim();
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
    const alias = target.core?.hostname && this.machines.find(m => m.store !== target && m.store.core?.hostname && profileKey(m) === profileKey(machine));
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
    // Grant credentials are persisted by WsClient's onSession, never the grant itself.
    if (!endpoint.grant && !endpoint.local)
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

  async add(endpoint: Endpoint, label?: string): Promise<boolean> {
    const lifecycle = this.#lifecycle;
    const identity = endpointIdentity(endpoint);
    if (!identity) {
      this.error = strings.machines.invalidUrl;
      return false;
    }
    const { id, host } = identity;
    const existing = this.machines.find((m) => m.id === id);
    if (existing && existing.store.connection !== 'closed') {
      this.error = strings.machines.duplicate;
      return false;
    }
    const target = existing?.store ?? new Store();
    target.client?.close();
    target.detach();
    target.machineId = id;
    target.visible = this.active === target;
    const machine: Machine = existing ?? { id, label: label?.trim() || host, store: target };
    if (!existing) this.machines = [...this.machines, machine];
    await target.connectEndpoint({ ...endpoint, url: id });
    if (!this.#current(lifecycle) || !this.machines.some((m) => m.store === target)) {
      if (!this.machines.some((m) => m.store === target)) {
        target.client?.close();
        target.detach();
      }
      return false;
    }
    if (target.connection !== 'ready') {
      this.error = `${machine.label}: ${target.error ?? strings.connection.closed}`;
      return false;
    }
    if (this.#discardAlias(machine)) return true;
    this.#rememberConnected(machine, endpoint, label, host);
    this.error = null;
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
    await this.select(local, undefined, local.draft?.projectId);
  }

  async remove(id: string): Promise<void> {
    const machine = this.machines.find((m) => m.id === id);
    if (!machine || machine.store === store) return;
    ++this.#generation;
    machine.store.client?.close();
    machine.store.detach();
    this.machines = this.machines.filter((m) => m !== machine);
    removeEnvironment(id);
    if (this.active === machine.store) await this.select(store);
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
