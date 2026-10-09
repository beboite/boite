/*
 * The main window keeps the companion's window open while its experiment is
 * on, and closes it when it is switched off. Outside the desktop shell there
 * is no window to open. It also shows the page of an agent of the companion's.
 */
import { setExperiment } from '../experiments';
import { experimentOn } from '../experiments.svelte';
import { companionWindow, inShell } from './shell';

/** Called once from a component's setup: the effect lives as long as it does. */
export function followCompanionExperiment(onerror: (error: unknown) => void): void {
  $effect(() => {
    if (!inShell()) return;
    void companionWindow(experimentOn('companion') ? 'open' : 'close').catch(onerror);
  });
}

/** An agent's page, where its conversation, memory, model and look are; the Agents page shows with its experiment on. */
export function showAgentPage(store: { showAgents(agentId: string): void }, agentId: string): void {
  if (!experimentOn('resident-agents')) setExperiment('resident-agents', true);
  store.showAgents(agentId);
}
