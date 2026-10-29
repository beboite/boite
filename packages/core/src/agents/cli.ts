import type { AgentSchedule, RpcParams } from '@boite/contracts';
import type { CoreClient } from '../client.ts';
import { targetOf } from '../control-cli.ts';

export const BOT_ACTIONS = 'memory, remember, routines, schedule, unschedule, watch or unwatch';

/** `boite bot ...` (`boite agent` before) from a bot's own thread. Authentication stays in the existing boite CLI. */
export async function botCommand(client: CoreClient, threadId: string, args: string[]): Promise<unknown> {
  const [action, ...rest] = args;
  const snapshot = await client.call('agents.snapshot', { threadId });
  const agent = snapshot.profiles[0];
  if (!agent) throw new Error('this thread is not a bot\'s');
  const need = (index: number, name: string): string => {
    const value = rest[index];
    if (!value) throw new Error(`bot ${action} needs ${name}`);
    return value;
  };
  const json = <T>(): T => {
    try { return JSON.parse(rest.join(' ')) as T; }
    catch { throw new Error(`bot ${action} needs a JSON object`); }
  };
  switch (action) {
    case 'memory': {
      const brain = await client.call('agents.brain.get', { threadId, agentId: agent.id });
      return { memory: `${brain.path}/MEMORY.md`, text: brain.memory };
    }
    case 'remember': {
      const text = rest.join(' ').trim();
      if (!text) throw new Error('bot remember needs the fact to note');
      const brain = await client.call('agents.memory.note', { threadId, text });
      return { noted: text, memory: `${brain.path}/MEMORY.md`, characters: brain.memory.length };
    }
    case 'routines': return snapshot.routines;
    case 'schedule': {
      const value = json<{ name: string; prompt: string; schedule: AgentSchedule; id?: string; expectedRevision?: number; enabled?: boolean }>();
      const previous = value.id ? snapshot.routines.find(r => r.id === value.id) : undefined;
      if (value.id && !previous) throw new Error(`bot schedule: no routine ${value.id}; boite bot routines lists yours`);
      const params: RpcParams<'agents.routine.save'> = {
        threadId,
        ...(previous ? { id: previous.id, expectedRevision: value.expectedRevision ?? previous.revision } : {}),
        value: { agentId: agent.id, name: value.name, prompt: value.prompt, schedule: value.schedule, enabled: value.enabled ?? true, nextAt: null, lastTurnId: null, lastScheduledAt: null },
      };
      return client.call('agents.routine.save', params);
    }
    case 'unschedule': return client.call('agents.routine.remove', { threadId, routineId: need(0, 'a routine id (boite bot routines lists them)') });
    case 'watch':
    case 'unwatch': {
      // `<machine>/<thread-id>`: a thread of a project another machine of the group entrusted to the bot.
      const { target, machine } = targetOf(need(0, 'a thread id'));
      const watched = await client.call('agents.watch', { threadId, watchThreadId: target, watched: action === 'watch', ...(machine === undefined ? {} : { machine }) });
      return watched ?? { unwatched: rest[0] };
    }
    default: throw new Error(`bot expects ${BOT_ACTIONS}`);
  }
}
