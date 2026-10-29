import { expect, vi } from 'vitest';
import type { ThreadSummary } from '@boite/contracts';
import { test } from '../../test/fake-client';

test('trusting a held bot frees its sub-agent as the core does, and a sub-agent keeps the hold of its own mail', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const bot = await client.call('agents.profile.save', { value: {
    name: 'Scout', domain: '', instructions: '', avatar: '', status: 'active', projectIds: ['p-boite'],
    selection: { providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null, permissionMode: 'default' },
  } });
  const { threadId } = await client.call('agents.open', { agentId: bot.id });
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId })).status).toBe('idle'));
  const child = (await client.call('delegation.spawn', { threadId, task: 'Inspect the project', requestId: 'held' })).thread.id;
  const heard = new Map<string, ThreadSummary['contactHold']>();
  client.on('thread.updated', summary => { if (summary.contactHold !== undefined) heard.set(summary.id, summary.contactHold); });

  client.holdForContactMail(threadId, ['Chris']);
  expect(heard.get(child)).toEqual({ contacts: ['Chris'] });
  // As the core: only the owner trusts it, never the held agent.
  client.becomes('agent');
  await expect(client.call('threads.trustContactHistory', { threadId })).rejects.toThrow('not one of the agent');
  client.becomes('owner');
  await client.call('threads.trustContactHistory', { threadId });
  expect([heard.get(threadId), heard.get(child)]).toEqual([null, null]);

  client.holdForContactMail(child, ['Dana']);
  client.holdForContactMail(threadId, ['Chris']);
  expect(heard.get(child)).toEqual({ contacts: ['Dana', 'Chris'] });
  await client.call('threads.trustContactHistory', { threadId });
  expect([heard.get(threadId), heard.get(child)]).toEqual([null, { contacts: ['Dana'] }]);
});
