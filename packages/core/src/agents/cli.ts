import { AGENT_HISTORY_MAX_PAGE } from '@boite/contracts';
import type { AgentHistoryCursor, AgentHistoryKind, AgentMemory, AgentRecord, AgentsHistoryPage, RpcParams } from '@boite/contracts';
import type { CoreClient } from '../client.ts';

const oldest = (records: AgentRecord[]) => records.reduce<AgentHistoryCursor | null>((min, r) => !min || r.updatedAt < min.updatedAt || r.updatedAt === min.updatedAt && r.id < min.id ? { updatedAt: r.updatedAt, id: r.id } : min, null);

/** Older pages of one kind behind the records the snapshot carried. Only an explicit command walks them. */
async function* older(client: CoreClient, threadId: string, kind: AgentHistoryKind, held: AgentRecord[]): AsyncGenerator<AgentsHistoryPage> {
  let before = oldest(held);
  for (;;) {
    const page = await client.call('agents.history', { threadId, kind, limit: AGENT_HISTORY_MAX_PAGE, ...(before ? { before } : {}) });
    yield page;
    const records = [...page.messages, ...page.work, ...page.memories];
    if (!page.more || !records.length) return;
    before = oldest(records);
  }
}

/** Provider-independent tools. Authentication stays in the existing boite CLI. */
export async function agentCommand(client: CoreClient, threadId: string, args: string[], requestId: string): Promise<unknown> {
  const [action, ...rest] = args;
  const snapshot = await client.call('agents.snapshot', { threadId });
  const session = snapshot.sessions.find(s => s.threadId === threadId);
  if (!session) throw new Error('this thread is not a persistent agent session');
  const need = (index: number, name: string): string => {
    const value = rest[index];
    if (!value) throw new Error(`agent ${action} needs ${name}`);
    return value;
  };
  const json = <T>(): T => {
    try { return JSON.parse(rest.join(' ')) as T; }
    catch { throw new Error(`agent ${action} needs a JSON object`); }
  };
  switch (action) {
    case 'context': return snapshot;
    case 'inbox': return { messages: snapshot.messages, deliveries: snapshot.deliveries };
    case 'missions': return { missions: snapshot.missions, tasks: snapshot.tasks };
    case 'routines': return snapshot.routines;
    case 'schedule': {
      const value = json<{ name: string; prompt: string; schedule: RpcParams<'agents.routine.save'>['value']['schedule']; id?: string; expectedRevision?: number; enabled?: boolean }>();
      return client.call('agents.routine.save', { threadId, ...(value.id ? { id: value.id, expectedRevision: value.expectedRevision } : {}), value: { agentId: session.agentId, name: value.name, prompt: value.prompt, schedule: value.schedule, enabled: value.enabled ?? true, nextAt: null, lastWorkId: null, lastScheduledAt: null } });
    }
    case 'send': return client.call('agents.message.send', { threadId, scope: session.scope, recipientIds: need(0, 'recipient ids separated by commas, or -') === '-' ? [] : rest[0]!.split(','), text: rest.slice(1).join(' '), requestId });
    case 'reply': {
      const id = need(0, 'an incoming message id');
      let parent = snapshot.messages.find(m => m.id === id);
      if (!parent && snapshot.more.message) for await (const page of older(client, threadId, 'message', snapshot.messages)) if ((parent = page.messages.find(m => m.id === id))) break;
      if (!parent) throw new Error('message is not in this conversation');
      return client.call('agents.message.send', { threadId, scope: session.scope, recipientIds: parent.senderId ? [parent.senderId] : [], text: rest.slice(1).join(' '), replyTo: parent.id, requestId });
    }
    case 'acquire': {
      const task = snapshot.tasks.find(t => t.id === need(0, 'a task id'));
      if (!task) throw new Error('task is not in this mission');
      return client.call('agents.task.acquire', { threadId, agentId: session.agentId, taskId: task.id, expectedRevision: task.revision });
    }
    case 'submit': return client.call('agents.task.submit', { threadId, taskId: need(0, 'a task id'), generation: Number(need(1, 'the assignment generation')), result: rest.slice(2).join(' ') });
    case 'artifact': return client.call('agents.artifact.add', { threadId, requestId, value: json<RpcParams<'agents.artifact.add'>['value']>() });
    case 'decide': return client.call('agents.decision.request', { ...json<Pick<RpcParams<'agents.decision.request'>, 'prompt' | 'options'>>(), threadId, requestId });
    case 'memory': {
      const query = rest.join(' ').toLocaleLowerCase();
      const matches = (m: AgentMemory) => `${m.title}\n${m.text}`.toLocaleLowerCase().includes(query);
      const found = snapshot.memories.filter(matches);
      if (snapshot.more.memory) for await (const page of older(client, threadId, 'memory', snapshot.memories)) found.push(...page.memories.filter(matches));
      return found.sort((a, b) => a.createdAt - b.createdAt);
    }
    case 'remember': {
      const value = json<{ title: string; text: string; id?: string; expectedRevision?: number }>();
      return client.call('agents.memory.save', { threadId, ...(value.id ? { id: value.id, expectedRevision: value.expectedRevision } : {}), value: { scope: session.scope, title: value.title, text: value.text, sourceScopes: [session.scope], sourceRunId: null, expiresAt: null } });
    }
    default: throw new Error('agent expects context, inbox, send, reply, missions, acquire, submit, artifact, decide, memory, remember, routines or schedule');
  }
}
