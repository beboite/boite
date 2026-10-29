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
