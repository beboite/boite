/*
 * `ui.reveal`: a desktop app started by a plugin (Bots, say) asks Boite to
 * come forward on a thread, on an agent's page or on the app updates (a newer
 * Boite the app noticed). The core sends the event to every owner connection;
 * only the desktop shell answers it, and only for the core it started on this
 * computer, so a browser tab or a window following a remote machine stays
 * where it is. A thread or an agent target that names another machine
 * (`coreId`) opens on the Store of the machine whose core has that id.
 */
import type { UiRevealTarget } from '@boite/contracts';
import { setExperiment } from './experiments';
import { experimentOn } from './experiments.svelte';
import type { Store } from './store.svelte';
import { fill, strings } from './strings';

/** What the reveal needs of the workspace: picking a machine, and maybe a thread on it. */
export interface RevealWorkspace {
  readonly active: Store;
  select(target: Store, threadId?: string): Promise<void>;
  /** The machine of this window whose core has this id, null when it has none. */
  machineOf(coreId: string): { store: Store; label: string } | null;
}

type Revealer = (from: Store, target: UiRevealTarget) => Promise<void>;
let revealer: Revealer | null = null;

/** The workspace hands in how it reveals; returns the way to stop. */
export function onReveal(next: Revealer): () => void {
  revealer = next;
  return () => { if (revealer === next) revealer = null; };
}

/** The event as the Store that received it hands it on. Outside the shell, or from another machine's core, nothing happens. */
export function revealRequested(from: Store, target: UiRevealTarget): void {
  if (window.__TAURI_INTERNALS__ === undefined || !from.localCore || revealer === null) return;
  void revealer(from, target).catch((error: unknown) => { console.warn('ui.reveal failed', error); });
}

/** An agent's page, where its conversation, memory, model and look are; the Agents page shows with its experiment on. */
export function showAgentPage(store: { showAgents(agentId: string): void }, agentId: string): void {
  if (!experimentOn('resident-agents')) setExperiment('resident-agents', true);
  store.showAgents(agentId);
}

/**
 * The window comes back as the tray's Show brings it (unminimized, shown,
 * focused), then opens the thread, the agent's page or the app updates (in
 * Settings, Machines). The app updates and a target without `coreId` open on
 * the machine whose core asked; a target with one opens on that machine, and
 * a machine this window lacks, or has but not connected, says so on the page
 * the window shows. `show` is the shell command; a test hands in its own.
 */
export async function reveal(workspace: RevealWorkspace, from: Store, target: UiRevealTarget, show: () => Promise<void> = showWindow): Promise<void> {
  await show();
  if (target.kind === 'update') {
    await workspace.select(from);
    if (workspace.active === from) from.showSettings('machines', 'machines');
    return;
  }
  const on = target.coreId === undefined ? from : machineFor(workspace, from, target.coreId);
  if (on === null) return;
  if (target.kind === 'thread') {
    await workspace.select(on, target.threadId);
    return;
  }
  await workspace.select(on);
  if (workspace.active === on) showAgentPage(on, target.agentId);
}

/** The Store a named machine's target opens on, or null after telling the user why there is none. */
function machineFor(workspace: RevealWorkspace, from: Store, coreId: string): Store | null {
  if (from.core?.coreId === coreId) return from;
  const machine = workspace.machineOf(coreId);
  if (machine === null) {
    workspace.active.error = strings.plugins.revealUnknownMachine;
    return null;
  }
  if (machine.store.connection !== 'ready') {
    workspace.active.error = fill(strings.plugins.revealMachineOffline, { machine: machine.label });
    return null;
  }
  return machine.store;
}

async function showWindow(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('show_window');
}
