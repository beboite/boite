import { Store, store } from './store.svelte';
import {
  fromTauri,
  insideTauri,
  parsePairingLink,
  readEnvironments,
  removeEnvironment,
  storeEndpoint,
  upsertEnvironment,
  type Endpoint
} from './endpoint';
import { strings } from './strings';

export interface Machine {
  id: string;
  label: string;
  store: Store;
}

/** Each host keeps its own ids, credentials and pending requests. */
export class Workspace {
  machines = $state<Machine[]>([]);
  active = $state(store);
  view = $state<'projects' | 'recent'>('projects');
  error = $state<string | null>(null);
  #generation = 0;
  #lifecycle = 0;

  async boot(): Promise<void> {
    const lifecycle = ++this.#lifecycle;
    store.visible = true;
    this.active = store;
    try {
      this.view = localStorage.getItem('boite.thread-view') === 'recent' ? 'recent' : 'projects';
    } catch {
      /* session only */
    }
    await store.boot(true);
    if (lifecycle !== this.#lifecycle) return;
    this.active = store;
    this.machines = [
      { id: store.endpointUrl ?? 'local', label: store.core?.hostname ?? strings.machines.local, store }
    ];
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('fake') === '1') {
      if (new URLSearchParams(window.location.search).get('machines') === '1') {
        const { FakeClient } = await import('./fake-client');
        const remote = new Store();
        remote.machineId = 'http://builder.test';
        remote.visible = false;
        remote.attach(new FakeClient());
        await remote.connect();
        remote.booted = true;
        if (remote.core) remote.core.os = 'linux';
        this.machines = [...this.machines, { id: remote.machineId, label: 'Builder', store: remote }];
      }
      return;
    }
    if (insideTauri() && !store.localCore) {
      const local = await fromTauri();
      if (local && local.url !== store.endpointUrl) await this.add(local, strings.machines.local);
    }
    await Promise.all(
      readEnvironments()
        .filter((e) => e.url !== store.endpointUrl)
        .map((e) => this.add(e, e.label))
    );
  }

  setView(view: 'projects' | 'recent'): void {
    this.view = view;
    try {
      localStorage.setItem('boite.thread-view', view);
    } catch {
      /* session only */
    }
  }

  async add(endpoint: Endpoint, label?: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(endpoint.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error();
    } catch {
      this.error = strings.machines.invalidUrl;
      return false;
    }
    const id = url.toString().replace(/\/+$/, '');
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
    const machine: Machine = existing ?? { id, label: label?.trim() || url.host, store: target };
    if (!existing) this.machines = [...this.machines, machine];
    await target.connectEndpoint({ ...endpoint, url: id });
    if (!this.machines.some((m) => m.store === target)) {
      target.client?.close();
      target.detach();
      return false;
    }
    if (target.connection !== 'ready') {
      this.error = `${machine.label}: ${target.error ?? strings.connection.closed}`;
      return false;
    }
    machine.label = label?.trim() || target.core?.hostname || url.host;
    // Grant credentials are persisted by WsClient's onSession, never the grant itself.
    if (!endpoint.grant && !endpoint.local)
      upsertEnvironment({ url: id, token: endpoint.token, paired: endpoint.paired ?? false, label: machine.label });
    else {
      const saved = readEnvironments().find((e) => e.url === id);
      if (saved) upsertEnvironment({ ...saved, label: machine.label });
    }
    this.machines = [...this.machines];
    if (target === store) {
      const saved = readEnvironments().find((e) => e.url === id);
      if (saved) storeEndpoint(saved);
    }
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
    }
    target.showChat();
    target.visible = true;
    if (threadId) await target.open(threadId);
    else if (projectId) target.startDraft(projectId);
    else if (target.openThread) await target.open(target.openThread.id);
    else await target.openWhereLeft();
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
