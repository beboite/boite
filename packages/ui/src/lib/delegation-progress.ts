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

export interface TeamLaunch {
  /** The timeline row's id: the message the launch followed, or the thread's start. */
  id: string;
  createdAt: number;
  agents: DelegatedAgent[];
}

/**
 * The subagents a timeline shows, one card per launch: the children started
 * after the same message share a card, placed where the first of them started,
 * and it stays there once they finish. A child older than every held message
 * belongs to history not loaded yet (`olderUnloaded`); it shows when that page
 * arrives, never at the top of the newer one.
 */
export function teamLaunches(agents: readonly DelegatedAgent[], messages: readonly { id: string; createdAt: number }[], olderUnloaded: boolean): TeamLaunch[] {
  const launches = new Map<string, TeamLaunch>();
  for (const agent of [...agents].sort((a, b) => a.thread.createdAt - b.thread.createdAt)) {
    const at = agent.thread.createdAt;
    let low = 0;
    let high = messages.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (messages[middle]!.createdAt <= at) low = middle + 1;
      else high = middle;
    }
    const anchor = messages[low - 1];
    if (!anchor && olderUnloaded) continue;
    const id = `delegation:${anchor?.id ?? 'start'}`;
    const launch = launches.get(id);
    if (launch) launch.agents.push(agent);
    else launches.set(id, { id, createdAt: at, agents: [agent] });
  }
  return [...launches.values()];
}
