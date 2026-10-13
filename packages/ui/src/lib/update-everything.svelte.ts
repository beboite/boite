import type { HarnessUpdate, ProviderId, ServerUpdateStatus } from '@boite/contracts';
import { appUpdater, showAppUpdateUi, type UpdateChannel, type UpdatePhase } from './app-update.svelte';
import { harnessOffered } from './machine-updates';
import { strings } from './strings';
import { workspace, type Machine } from './workspace.svelte';

/** One machine as the update-everything button reads it. */
export interface MachineReading {
  id: string;
  label: string;
  /** The computer the desktop app runs on: Boite there updates with the app. */
  local: boolean;
  /** Connected with full control: only then can it be asked to update. */
  ready: boolean;
  server: Pick<ServerUpdateStatus, 'mode' | 'phase' | 'currentVersion' | 'version' | 'received' | 'total' | 'error'> | null;
  agents: readonly HarnessUpdate[];
}

/** The desktop app's own updater, read on the computer it runs on. */
export interface AppReading {
  phase: UpdatePhase;
  currentVersion: string;
  version: string | null;
  channel: UpdateChannel;
  received: number;
  total: number | null;
  error: string | null;
}

/** What one part of a machine is doing, in the order a row reads it. */
export type PartState = 'offered' | 'downloading' | 'ready' | 'waiting' | 'installing' | 'updating' | 'failed';

export interface PlannedPart {
  /** `app`, `boite` or the agent's provider id. */
  id: string;
  name: string;
  /** What runs now, when it is known. */
  from: string | null;
  version: string;
  state: PartState;
  /** Download progress, 0 to 100, when the size is known. */
  percent: number | null;
  /** Threads an agent update waits for to pause. */
  waitingFor: number;
  message: string | null;
  /** What the button starts: an offer, or a failure it retries. */
  startable: boolean;
}

export interface PlannedMachine {
  id: string;
  label: string;
  local: boolean;
  parts: PlannedPart[];
}

const percentOf = (received: number, total: number | null): number | null =>
  total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;

function appPart(app: AppReading): PlannedPart | null {
  if (app.version === null) return null;
  const state: Partial<Record<UpdatePhase, PartState>> = {
    available: 'offered', downloading: 'downloading', ready: 'ready', waiting: 'installing', installing: 'installing', error: 'failed'
  };
  const mapped = state[app.phase];
  if (mapped === undefined) return null;
  return { id: 'app', name: 'Boite', from: app.currentVersion || null, version: app.version, state: mapped, percent: percentOf(app.received, app.total), waitingFor: 0,
    message: app.phase === 'error' ? app.error : null, startable: ['available', 'ready', 'error'].includes(app.phase) };
}

function serverPart(server: NonNullable<MachineReading['server']>): PlannedPart | null {
  // Docker and manual installs update by their own command, not by a click.
  if (server.mode !== 'systemd' || server.version === null) return null;
  const state: Partial<Record<ServerUpdateStatus['phase'], PartState>> = {
    available: 'offered', downloading: 'downloading', waiting: 'waiting', installing: 'installing', error: 'failed'
  };
  const mapped = state[server.phase];
  if (mapped === undefined) return null;
  return { id: 'boite', name: 'Boite', from: server.currentVersion || null, version: server.version, state: mapped, percent: percentOf(server.received, server.total), waitingFor: 0,
    message: server.phase === 'error' ? server.error : null, startable: server.phase === 'available' || server.phase === 'error' };
}

function agentPart(update: HarnessUpdate): PlannedPart | null {
  const updating = update.state === 'updating';
  if (!updating && !harnessOffered(update)) return null;
  return { id: update.providerId, name: update.name, from: update.current, version: update.latest ?? '', state: updating ? 'updating' : update.state === 'failed' ? 'failed' : 'offered',
    percent: null, waitingFor: update.waitingFor ?? 0, message: update.state === 'failed' ? update.message : null, startable: !updating };
}

/** The entry the app's own release stands under when this computer's core is not among the machines. */
export const APP_MACHINE = 'app';

/**
 * Every update the button would start or is following, machine by machine,
 * this computer first. A machine without full control, or not connected,
 * has nothing the button can ask, so it is left out rather than shown idle.
 * The app's own release needs no core: without this computer's, it gets an
 * entry of its own under `localLabel`.
 */
export function planOf(machines: readonly MachineReading[], app: AppReading | null, localLabel = 'This PC'): PlannedMachine[] {
  const own = app ? appPart(app) : null;
  const ready = machines.filter((machine) => machine.ready);
  const planned = ready.map((machine) => {
    const parts: PlannedPart[] = [];
    const boite = machine.local ? own : machine.server ? serverPart(machine.server) : null;
    if (boite) parts.push(boite);
    for (const update of machine.agents) {
      const part = agentPart(update);
      if (part) parts.push(part);
    }
    return { id: machine.id, label: machine.label, local: machine.local, parts };
  });
  if (own && !ready.some((machine) => machine.local)) planned.push({ id: APP_MACHINE, label: localLabel, local: true, parts: [own] });
  return planned.filter((machine) => machine.parts.length > 0).sort((a, b) => Number(b.local) - Number(a.local));
}

/** The keys "Later" remembers: one per release offered, so a newer one asks again. */
export function offerKeys(plan: readonly PlannedMachine[]): string[] {
  return plan.flatMap((machine) => machine.parts.filter((part) => part.startable).map((part) => `${machine.id}/${part.id}@${part.version}`));
}

const DISMISSED_KEY = 'boite.updates-later';
/** Old entries go: a list that only grows would be read on every start. */
const DISMISSED_CAP = 200;

function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch { return []; }
}

/** Resolves once `ready` reads true, rechecking each time what it read changes. */
function until(ready: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stop = $effect.root(() => {
      $effect(() => {
        if (!ready()) return;
        resolve();
        queueMicrotask(() => stop());
      });
    });
  });
}

function readingOf(machine: Machine): MachineReading {
  const store = machine.store;
  return {
    id: machine.id,
    label: machine.label,
    // A core with no address runs in this window, the development harness's: it stands for this computer.
    local: store.localCore || (store.endpointUrl == null && machine.id === 'local'),
    ready: store.connection === 'ready' && store.owner,
    server: store.localCore ? null : store.serverUpdater.snapshot,
    agents: store.owner ? store.harnessUpdates : []
  };
}

/**
 * The one button that updates everything: the desktop app, Boite on every
 * machine with full control, and every agent there. Each machine's core
 * orders its own work (`core.updateEverything`), so a remote machine needs
 * nothing more from this window once asked, and machines never wait for one
 * another. This computer's app downloads at the same moment and restarts last,
 * once its own core's agents are done: the restart would cut their updaters.
 */
export class UpdateEverything {
  running = $state(false);
  #dismissed = $state<string[]>(readDismissed());

  get plan(): PlannedMachine[] {
    const app = showAppUpdateUi() && appUpdater.snapshot.supported ? appUpdater.snapshot : null;
    return planOf(workspace.machines.map(readingOf), app, strings.machines.local);
  }

  /** A part the button can start, on any machine. */
  get offered(): boolean {
    return this.plan.some((machine) => machine.parts.some((part) => part.startable));
  }

  /** An offer "Later" has not put off yet: the dot, and the card opening by itself. */
  get fresh(): string[] {
    const dismissed = new Set(this.#dismissed);
    return offerKeys(this.plan).filter((key) => !dismissed.has(key));
  }

  /** Releases the card already opened for by itself in this window. */
  #announced = new Set<string>();

  /** Whether `keys` hold a release the card has not opened for yet; marks them as announced. */
  announce(keys: readonly string[]): boolean {
    const added = keys.filter((key) => !this.#announced.has(key));
    for (const key of added) this.#announced.add(key);
    return added.length > 0;
  }

  later(): void {
    const keys = offerKeys(this.plan);
    const next = [...this.#dismissed.filter((key) => !keys.includes(key)), ...keys].slice(-DISMISSED_CAP);
    this.#dismissed = next;
    try { window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); }
    catch { /* Kept for this session when storage is unavailable. */ }
  }

  async run(): Promise<void> {
    if (this.running) return;
    const plan = this.plan;
    if (!plan.some((machine) => machine.parts.some((part) => part.startable))) return;
    this.running = true;
    try {
      const machines = new Map(workspace.machines.map((machine) => [machine.id, machine]));
      const local = plan.find((machine) => machine.local && machine.parts.some((part) => part.id === 'app' && part.startable));
      // The app's download is the longest step and touches nothing that runs: it starts first.
      const app = local ? appUpdater.prepare() : Promise.resolve(false);
      await Promise.all(plan.map((machine) => {
        const store = machines.get(machine.id)?.store;
        const agents = machine.parts.filter((part) => part.startable && part.id !== 'app' && part.id !== 'boite').map((part) => part.id as ProviderId);
        const server = machine.parts.find((part) => part.id === 'boite' && part.startable)?.version ?? null;
        return store ? store.serverUpdater.everything(agents, server) : null;
      }));
      if (!local || !(await app)) return;
      // A restart stops this computer's core: the agent updaters it runs land first.
      const localStore = machines.get(local.id)?.store;
      if (localStore) await until(() => localStore.connection !== 'ready' || !localStore.harnessUpdates.some((update) => update.state === 'updating'));
      if (appUpdater.ready) appUpdater.install();
    } finally {
      this.running = false;
    }
  }
}

export const updateEverything = new UpdateEverything();
