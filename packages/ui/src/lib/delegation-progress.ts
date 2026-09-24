import type { DelegatedAgent } from '@boite/contracts';

/** An idle thread alone is not evidence that its task completed. */
export function agentProgress(agent: DelegatedAgent) {
  const active = ['queued', 'running', 'waiting'].includes(agent.thread.status);
  const status = active ? agent.thread.status : agent.lastTurn?.status ?? agent.thread.status;
  return {
    active,
    status,
    startedAt: agent.thread.createdAt,
    finishedAt: active ? null : agent.lastTurn?.finishedAt ?? null
  };
}

export function teamProgress(agents: DelegatedAgent[]) {
  const states = agents.map(agentProgress);
  return {
    active: states.some(state => state.active),
    completed: states.filter(state => state.status === 'done').length,
    failed: states.filter(state => state.status === 'error').length,
    stopped: states.filter(state => state.status === 'stopped').length,
    startedAt: states.length ? Math.min(...states.map(state => state.startedAt)) : null,
    finishedAt: states.length && states.every(state => state.finishedAt !== null)
      ? Math.max(...states.map(state => state.finishedAt!)) : null
  };
}
