import type { BackgroundTask, MessagePart, NativeAgent, NativeAgentUpdate, Turn } from './index.ts';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.slice(0, 4000) : undefined;

/** Claude Agent/Task, Muse Task, ACP task and pi's subagent extension retain their ordinary tool cards. */
export function nativeAgentsOfTool(part: MessagePart): NativeAgentUpdate[] {
  if (part.type !== 'tool') return [];
  if (part.nativeAgents) return part.nativeAgents;
  if (!['agent', 'task', 'subagent'].includes(part.name.toLowerCase())) return [];
  const input = record(part.input);
  const tasks = Array.isArray(input.tasks) ? input.tasks : Array.isArray(input.chain) ? input.chain : [input];
  return tasks.flatMap((raw, index) => {
    const task = record(raw);
    const brief = text(task.prompt) ?? text(task.task) ?? text(task.objective);
    // Task-list CRUD and tools with only a title are not child agents.
    if (!brief) return [];
    const background = input.run_in_background === true;
    return [{
      id: tasks.length === 1 ? part.toolId : `${part.toolId}:${index}`,
      name: text(task.description) ?? text(task.agent) ?? text(task.subagent_type) ?? text(task.role),
      task: brief, model: text(task.model),
      status: tasks.length > 1 || background ? 'unknown' : part.status === 'error' || part.status === 'denied' ? 'error' : part.status === 'done' ? 'done' : 'running',
      ...(part.output && tasks.length === 1 ? { result: part.output.slice(0, 4000) } : {}),
    } satisfies NativeAgentUpdate];
  });
}

export interface NativeAgentEntry { part: MessagePart; at: number; turnId?: string; turnStatus?: Turn['status'] }

/** Merge explicit provider IDs across turns, and scope inferred tool IDs to their invocation's turn. */
export function collectNativeAgents(entries: Iterable<NativeAgentEntry>, background: BackgroundTask[] = []): NativeAgent[] {
  const agents = new Map<string, NativeAgent>();
  for (const { part, at, turnId, turnStatus } of entries) {
    if (part.type !== 'tool') continue;
    for (const update of nativeAgentsOfTool(part)) {
      const id = !part.nativeAgents && turnId ? `${turnId}:${update.id}` : update.id;
      const previous = agents.get(id);
      const defined = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
      const agent = { ...previous, ...defined, id, status: update.status, toolId: previous?.toolId ?? part.toolId, startedAt: previous?.startedAt ?? part.startedAt ?? at } as NativeAgent;
      if (agent.status === 'running' && (turnStatus === 'stopped' || turnStatus === 'error' || turnStatus === 'done')) agent.status = 'unknown';
      if (agent.status === 'running' && !update.result) delete agent.result;
      agents.set(agent.id, agent);
    }
  }
  const launches = [...agents.values()];
  for (const task of background) {
    if (task.kind !== 'agent') continue;
    const eligible = launches.filter(agent => agent.toolId === task.toolId && agent.startedAt <= task.startedAt);
    const latestStart = eligible.reduce((latest, agent) => Math.max(latest, agent.startedAt), -Infinity);
    const latest = eligible.filter(agent => agent.startedAt === latestStart);
    const previous = latest.length === 1 ? latest[0] : undefined;
    const id = previous?.id ?? task.id;
    agents.set(id, { ...previous, id, name: previous?.name ?? task.description, status: 'running', result: undefined, toolId: previous?.toolId ?? task.toolId ?? task.id, startedAt: previous?.startedAt ?? task.startedAt });
  }
  return [...agents.values()];
}
