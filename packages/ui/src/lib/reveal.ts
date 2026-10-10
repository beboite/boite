/*
 * `ui.reveal`: a desktop app started by a plugin (Bots, say) asks Boite to
 * come forward on a thread, on an agent's page or on the app updates (a newer
 * Boite the app noticed). The core sends the event to every owner connection;
 * only the desktop shell answers it, and only for the core it started on this
 * computer, so a browser tab or a window following a remote machine stays
 * where it is.
 */
import type { UiRevealTarget } from '@boite/contracts';
import { setExperiment } from './experiments';
import { experimentOn } from './experiments.svelte';
import type { Store } from './store.svelte';

/** What the reveal needs of the workspace: picking a machine, and maybe a thread on it. */
export interface RevealWorkspace {
  readonly active: Store;
  select(target: Store, threadId?: string): Promise<void>;
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
 * Settings, Machines) on the machine whose core asked. `show` is the shell
 * command; a test hands in its own.
 */
export async function reveal(workspace: RevealWorkspace, from: Store, target: UiRevealTarget, show: () => Promise<void> = showWindow): Promise<void> {
  await show();
  if (target.kind === 'thread') {
    await workspace.select(from, target.threadId);
    return;
  }
  await workspace.select(from);
  if (workspace.active !== from) return;
  if (target.kind === 'agent') showAgentPage(from, target.agentId);
  else from.showSettings('machines', 'machines');
}

async function showWindow(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('show_window');
}
