/*
 * The main window keeps the companion's window open while its experiment is
 * on, and closes it when it is switched off. Outside the desktop shell there
 * is no window to open. It also shows the page of an agent of the companion's.
 */
import { setExperiment } from '../experiments';
import { experimentOn } from '../experiments.svelte';

/**
 * Called once from a component's setup: the effect lives as long as it does.
 * The companion's commands (`shell.ts`) load only here, so the main window's
 * entry does not carry them.
 */
export function followCompanionExperiment(onerror: (error: unknown) => void): void {
  $effect(() => {
    if (window.__TAURI_INTERNALS__ === undefined) return;
    const action = experimentOn('companion') ? 'open' : 'close';
    void import('./shell').then(({ companionWindow }) => companionWindow(action)).catch(onerror);
  });
}

/** An agent's page, where its conversation, memory, model and look are; the Agents page shows with its experiment on. */
export function showAgentPage(store: { showAgents(agentId: string): void }, agentId: string): void {
  if (!experimentOn('resident-agents')) setExperiment('resident-agents', true);
  store.showAgents(agentId);
}

type Listen = typeof import('@tauri-apps/api/event').listen;
interface MainStore {
  showSettings(tab: 'companion'): void;
  showAgents(agentId: string): void;
}

/** What the companion's window asks of the main one: the companion's Settings page, or an agent's page, on the local machine. */
export function companionEvents(listen: Listen, onLocal: (open: (local: MainStore) => void) => Promise<void>) {
  return [
    listen('companion://settings', () => void onLocal((local) => local.showSettings('companion'))),
    listen<string>('companion://agent', (event) => void onLocal((local) => showAgentPage(local, event.payload)))
  ];
}
