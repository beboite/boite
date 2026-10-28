import { afterEach, expect, test } from 'vitest';
import { FakeClient } from '../fake-client';

/* `agent.spawn --machine` in the in-memory client refuses as the core's `memberNamed` and remote spawn do. */

const clients: FakeClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });

async function machine(id: string, name = id): Promise<FakeClient> {
  const client = new FakeClient({ delayMs: 0, coreId: id, coreName: name, publicUrl: `https://${id}.test` });
  clients.push(client);
  await client.connect();
  return client;
}

test('a spawn on another machine names this machine, an unknown one, a shared name and an absent one as the core does', async () => {
  const desk = await machine('desk'), pc = await machine('pc');
  await desk.call('group.create', { name: 'Home' });
  await pc.call('group.join', { invite: (await desk.call('group.invite', {})).invite });
  const spawn = (to: string) => desk.call('agent.spawn', { threadId: 't-trace', project: 'notes', prompt: 'Print the letter', requestId: `spawn-${to}`, machine: to });

  await expect(spawn('desk')).rejects.toThrow('agent.spawn.machine: desk is this machine; leave --machine out');
  await expect(spawn('nowhere')).rejects.toMatchObject({ message: 'agent.spawn.machine: no machine nowhere in this group; the others are pc', data: { field: 'machine', expected: ['pc'] } });
  await expect(spawn('pc')).rejects.toThrow('pc does not let the other machines of its group start threads there');

  // A member the page no longer reaches did not answer; its switch is not known to be off.
  pc.close();
  await expect(spawn('pc')).rejects.toThrow('pc did not answer');

  const twin = await machine('fade01', 'pc');
  await twin.call('group.join', { invite: (await desk.call('group.invite', {})).invite });
  await expect(spawn('pc')).rejects.toThrow('agent.spawn.machine: 2 machines are named pc; name one by a core id prefix: pc, fade01');
});

test('thread new --model picks from this machine\'s models, or with --machine from that machine\'s, as the core does', async () => {
  const desk = await machine('desk'), pc = await machine('pc');
  await desk.call('group.create', { name: 'Home' });
  await pc.call('group.join', { invite: (await desk.call('group.invite', {})).invite });
  const label = (choice: { providerId: string; model: string }) => `${choice.providerId}/${choice.model}`;
  const own = (await desk.call('agent.projects', { threadId: 't-trace' })).find(project => project.current)!;
  const spawn = (params: { requestId: string; model?: string; effort?: string; machine?: string }) => desk.call('agent.spawn', { threadId: 't-trace', project: params.machine === undefined ? own.name : 'notes', prompt: 'Read the parser', ...params });

  const here = await desk.call('delegation.models', { threadId: 't-trace' });
  const other = here.choices.find(choice => !choice.current && choice.efforts.length > 0)!;
  const spawned = await spawn({ requestId: 'model-1', model: label(other), effort: other.efforts[0]! });
  expect(spawned.thread).toMatchObject({ providerId: other.providerId, model: other.model, effort: other.efforts[0] });
  await expect(spawn({ requestId: 'model-2', model: 'nothing-like-it' })).rejects.toMatchObject({
    message: 'model: no installed model matches "nothing-like-it"; run boite delegate models', data: { field: 'model', expected: here.choices.map(label) },
  });

  await expect(desk.call('delegation.models', { threadId: 't-trace', machine: 'pc' })).rejects.toThrow('boite settings request groupThreads true --machine pc --why');
  await pc.call('settings.set', { groupThreads: true });
  const there = await desk.call('delegation.models', { threadId: 't-trace', machine: 'pc' });
  expect(there.choices.length).toBeGreaterThan(0);
  await expect(spawn({ requestId: 'remote-1', machine: 'pc', model: 'nothing-like-it' })).rejects.toMatchObject({
    message: 'model: no installed model matches "nothing-like-it"; run boite delegate models --machine pc', data: { field: 'model', expected: there.choices.map(label) },
  });
  await expect(spawn({ requestId: 'remote-2', machine: 'pc', model: label(there.choices[0]!) })).rejects.toThrow('the in-memory client does not start threads on another machine');
});
