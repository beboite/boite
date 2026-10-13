import type { AgentProfile, ProjectId, ThreadSummary } from '@boite/contracts';
import { agentDirectory } from './agent-directory.svelte';
import type { Store } from './store.svelte';
import { workspace } from './workspace.svelte';

/*
 * The persistent agents the owner entrusted a project to, where the thread
 * list and the chat show them: a project header draws their robots, a thread
 * of that project names one in its header. Both read the agents directory,
 * loaded only with the Agents experiment on.
 */

/** The active agents that look after a project. The drafts project is never entrusted. */
export function residentsOf(store: Store, projectId: ProjectId | null): AgentProfile[] {
  if (projectId === null || store.projects.find(p => p.id === projectId)?.kind === 'drafts') return [];
  return agentDirectory(store).residentsOf(projectId);
}

/**
 * The agent that looks after a thread's project. None for a thread entrusted
 * to an agent itself, whose header names that agent, nor for an agent's own
 * thread.
 */
export function residentOfThread(store: Store, thread: Pick<ThreadSummary, 'id' | 'projectId' | 'agentSessionId'>): AgentProfile | null {
  if (thread.agentSessionId || agentDirectory(store).entrustmentOf(thread.id)) return null;
  return residentsOf(store, thread.projectId)[0] ?? null;
}

/** Opens an agent's conversation on the Agents page of its machine. */
export function openResident(store: Store, agentId: string): void {
  if (workspace.active === store) store.showAgents(agentId);
  else void workspace.select(store).then(() => store.showAgents(agentId));
}
