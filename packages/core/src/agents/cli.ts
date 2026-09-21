import type { RpcParams } from '@boite/contracts';
import type { CoreClient } from '../client.ts';

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
    case 'send': return client.call('agents.message.send', { threadId, scope: session.scope, recipientIds: need(0, 'recipient ids separated by commas, or -') === '-' ? [] : rest[0]!.split(','), text: rest.slice(1).join(' '), requestId });
    case 'reply': {
      const parent = snapshot.messages.find(m => m.id === need(0, 'an incoming message id'));
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
      return snapshot.memories.filter(m => `${m.title}\n${m.text}`.toLocaleLowerCase().includes(query));
    }
    case 'remember': {
      const value = json<{ title: string; text: string; id?: string; expectedRevision?: number }>();
      return client.call('agents.memory.save', { threadId, ...(value.id ? { id: value.id, expectedRevision: value.expectedRevision } : {}), value: { scope: session.scope, title: value.title, text: value.text, sourceScopes: [session.scope], sourceRunId: null, expiresAt: null } });
    }
    default: throw new Error('agent expects context, inbox, send, reply, missions, acquire, submit, artifact, decide, memory or remember');
  }
}
