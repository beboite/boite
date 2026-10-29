import type { DesktopUpdateStatus, HarnessUpdate, Os, ProviderId, ServerUpdateStatus } from '@boite/contracts';
import { appUpdater, showAppUpdateUi, type UpdateChannel, type UpdatePhase } from './app-update.svelte';
import { harnessOffered } from './machine-updates';
import { strings } from './strings';
import { listedName, workspace, type Machine } from './workspace.svelte';

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
  /** The desktop app on another machine, as its window reports it to its core; null on this computer. */
  desktop?: DesktopUpdateStatus | null;
  /** The release last asked of that desktop app, and why it did not reach its window. */
  desktopFailure?: { version: string; message: string } | null;
  /** The release that machine's core took and holds until its agents are done. */
  desktopRequested?: string | null;
  /** That machine's system: only the Windows installer runs with nobody there to answer it. */
  os?: Os | null;
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
  /** `app` (this computer's desktop app), `desktop` (another machine's), `boite` or the agent's provider id. */
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

/**
 * The desktop app of another machine. Its own window installs it, so a
 * downloaded release is still an offer from here, and a request that found no
 * window open shows as failed with that reason until the window answers.
 */
export function desktopPart(desktop: DesktopUpdateStatus | null, failure: { version: string; message: string } | null, requested: string | null = null): PlannedPart | null {
  const version = desktop?.version ?? failure?.version ?? null;
  if (version === null) return null;
  const phase = desktop?.version === version ? desktop.phase : null;
  if (failure?.version === version && (phase === null || ['available', 'ready', 'error', 'idle', 'current', 'checking'].includes(phase))) {
    return { id: 'desktop', name: 'Boite', from: desktop?.currentVersion || null, version, state: 'failed', percent: null, waitingFor: 0, message: failure.message, startable: true };
  }
  if (desktop === null || phase === null) return null;
  const state: Partial<Record<DesktopUpdateStatus['phase'], PartState>> = {
    available: 'offered', ready: 'offered', downloading: 'downloading', waiting: 'installing', installing: 'installing', error: 'failed'
  };
  const mapped = state[phase];
  if (mapped === undefined) return null;
  // Taken by that machine's core: its window installs once the agents there are done.
  if (requested === version && mapped !== 'downloading' && mapped !== 'installing') {
    return { id: 'desktop', name: 'Boite', from: desktop.currentVersion || null, version, state: 'waiting', percent: null, waitingFor: 0, message: null, startable: false };
  }
  return { id: 'desktop', name: 'Boite', from: desktop.currentVersion || null, version, state: mapped, percent: percentOf(desktop.received, desktop.total), waitingFor: 0,
    message: phase === 'error' ? desktop.error : null, startable: ['available', 'ready', 'error'].includes(phase) };
}

function agentPart(update: HarnessUpdate): PlannedPart | null {
  const updating = update.state === 'updating';
  if (!updating && !harnessOffered(update)) return null;
  return { id: update.providerId, name: update.name, from: update.current, version: update.latest ?? '', state: updating ? 'updating' : update.state === 'failed' ? 'failed' : 'offered',
    percent: null, waitingFor: update.waitingFor ?? 0, message: update.state === 'failed' ? update.message : null, startable: !updating };
}

/** The parts that are Boite itself rather than an agent. */
export const BOITE_PARTS: readonly string[] = ['app', 'desktop', 'boite'];

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
    // Another machine's desktop app installs from here only where its installer asks nothing of anyone there.
    const desktop = !machine.local && machine.os === 'windows' ? desktopPart(machine.desktop ?? null, machine.desktopFailure ?? null, machine.desktopRequested ?? null) : null;
    if (desktop) parts.push(desktop);
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

/** One row of the card: a part as last seen, and when it finished if it did. */
export interface UpdateRow {
  key: string;
  machineId: string;
  label: string;
  local: boolean;
  part: PlannedPart;
  /** When the part left the plan after being under way; it shows its check until `DONE_LINGER_MS` later. */
  doneAt: number | null;
}

/** How long a finished row keeps its check before it goes. */
export const DONE_LINGER_MS = 1400;

const UNDER_WAY: readonly PartState[] = ['downloading', 'waiting', 'installing', 'updating'];

/**
 * The card's rows from the previous ones and the current plan, so the list
 * empties one row at a time instead of all at once. A part that was under way
 * and left the plan is done: it keeps its row with a check for a moment, then
 * goes. A machine out of reach keeps its rows as they were, since Boite
 * restarting there, or a link that drops, is not an update done. A part that
 * was only offered and left (put off, skipped elsewhere) goes without a check.
 */
export function reconcileRows(previous: readonly UpdateRow[], plan: readonly PlannedMachine[], reachable: (machineId: string) => boolean, now: number): UpdateRow[] {
  const fresh = new Map<string, UpdateRow>();
  for (const machine of plan) {
    for (const part of machine.parts) {
      const key = `${machine.id}/${part.id}`;
      fresh.set(key, { key, machineId: machine.id, label: machine.label, local: machine.local, part, doneAt: null });
    }
  }
  const rows: UpdateRow[] = [];
  for (const row of previous) {
    const next = fresh.get(row.key);
    if (next) {
      rows.push(next);
      fresh.delete(row.key);
    } else if (row.doneAt !== null) {
      if (now - row.doneAt < DONE_LINGER_MS) rows.push(row);
    } else if (UNDER_WAY.includes(row.part.state)) {
      rows.push(reachable(row.machineId) ? { ...row, doneAt: now } : row);
    }
  }
  // A new row joins the rows of its machine, or comes last in the plan's order.
  for (const row of fresh.values()) {
    const last = rows.findLastIndex((entry) => entry.machineId === row.machineId);
    if (last === -1) rows.push(row);
    else rows.splice(last + 1, 0, row);
  }
  return rows;
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

/** The computer the desktop app runs on. A core with no address runs in this window, the development harness's: it stands for this computer. */
function isLocal(machine: Machine): boolean {
  return machine.store.localCore || (machine.store.endpointUrl == null && machine.id === 'local');
}

function readingOf(machine: Machine): MachineReading {
  const store = machine.store;
  return {
    id: machine.id,
    label: listedName(machine),
    local: isLocal(machine),
    ready: store.connection === 'ready' && store.owner,
    server: store.localCore ? null : store.serverUpdater.snapshot,
    agents: store.owner ? store.harnessUpdates : [],
    desktop: store.localCore ? null : store.serverUpdater.desktop,
    desktopFailure: store.localCore ? null : store.serverUpdater.desktopFailure,
    desktopRequested: store.localCore ? null : store.serverUpdater.desktopRequested,
    os: store.core?.os ?? null
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

  /** Whether this computer's app has a release the button can start. */
  get appOffered(): boolean {
    return this.plan.some((machine) => machine.local && machine.parts.some((part) => part.id === 'app' && part.startable));
  }

  /** True while an agent update runs on this computer's core: restarting the app now would cut it off. */
  get localBusy(): boolean {
    return workspace.machines.some((machine) => isLocal(machine) && machine.store.harnessUpdates.some((update) => update.state === 'updating'));
  }

  /** Installs the app's downloaded release, which restarts it. Nothing while this computer's agents still update. */
  restart(): void {
    if (!appUpdater.ready || this.localBusy) return;
    appUpdater.install();
  }

  /**
   * Starts the updates: every part of every machine, or with `appOnly` this
   * app's own release alone. The app only downloads: the card then says to
   * restart, which `restart` does, so nothing restarts under the user.
   */
  async run({ appOnly = false }: { appOnly?: boolean } = {}): Promise<void> {
    if (this.running) return;
    const plan = appOnly
      ? this.plan.filter((machine) => machine.local).map((machine) => ({ ...machine, parts: machine.parts.filter((part) => part.id === 'app') }))
      : this.plan;
    if (!plan.some((machine) => machine.parts.some((part) => part.startable))) return;
    this.running = true;
    try {
      const machines = new Map(workspace.machines.map((machine) => [machine.id, machine]));
      const local = plan.some((machine) => machine.local && machine.parts.some((part) => part.id === 'app' && part.startable));
      // The app's download is the longest step and touches nothing that runs: it starts first.
      const app = local ? appUpdater.prepare() : Promise.resolve(false);
      await Promise.all(plan.map((machine) => {
        const store = machines.get(machine.id)?.store;
        const agents = machine.parts.filter((part) => part.startable && !BOITE_PARTS.includes(part.id)).map((part) => part.id as ProviderId);
        const server = machine.parts.find((part) => part.id === 'boite' && part.startable)?.version ?? null;
        // That machine's core hands its desktop app's release to its window once these agents are done.
        const desktop = machine.local ? null : machine.parts.find((part) => part.id === 'desktop' && part.startable)?.version ?? null;
        return store && (agents.length > 0 || server !== null || desktop !== null) ? store.serverUpdater.everything(agents, server, desktop) : null;
      }));
      await app;
    } finally {
      this.running = false;
    }
  }
}

export const updateEverything = new UpdateEverything();
