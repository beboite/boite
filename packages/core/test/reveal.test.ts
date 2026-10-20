import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import type { UiRevealTarget } from '@boite/contracts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

const cores: TestCore[] = [];
afterEach(async () => {
  const stopping = cores.splice(0);
  await Promise.all(stopping.map((core) => core.core.group.close()));
  for (const core of stopping) await core.stop();
});

async function machine(): Promise<TestCore> {
  const core = await startTestCore();
  cores.push(core);
  return core;
}

const id = (h: TestCore): string => h.core.coordination.card().coreId;

/** The contact card of a machine linked by hand, made from a fresh key. */
function linkedPeer(): { coreId: string; name: string; url: string; publicKey: string } {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { coreId: createHash('sha256').update(pem).digest('hex'), name: 'Laptop', url: 'https://laptop.example', publicKey: pem };
}

test('a thread or an agent on a machine of the group or a linked one reaches the windows with its coreId', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  const { invite } = await a.core.group.invite();
  await b.core.group.join(invite);
  await waitFor(() => a.core.group.peers().some((peer) => peer.coreId === id(b)));
  const linked = linkedPeer();
  a.core.coordination.trust(linked);

  const owner = await a.connect();
  // What a client checks before it names a machine: an older core would drop coreId and open its own.
  expect(a.core.info().features?.revealMachines).toBe(true);
  const { threadId } = await echoThread(a, owner);
  const heard: UiRevealTarget[] = [];
  owner.on('ui.reveal', (event) => heard.push(event.target));

  const sent: UiRevealTarget[] = [
    { kind: 'thread', threadId: 'thr_on_b', coreId: id(b) },
    { kind: 'agent', agentId: 'agent-b', coreId: id(b) },
    { kind: 'thread', threadId: 'thr_on_laptop', coreId: linked.coreId },
    { kind: 'agent', agentId: 'agent-laptop', coreId: linked.coreId },
  ];
  for (const target of sent) expect(await owner.call('ui.reveal', { target })).toEqual({ delivered: 1 });
  // This core's own id is this core: the thread must be one of its own, and the event carries no coreId, as from an old client.
  expect(await owner.call('ui.reveal', { target: { kind: 'thread', threadId, coreId: id(a) } })).toEqual({ delivered: 1 });
  expect(await owner.call('ui.reveal', { target: { kind: 'agent', agentId: 'agent-a', coreId: id(a) } })).toEqual({ delivered: 1 });
  expect(await owner.call('ui.reveal', { target: { kind: 'thread', threadId } })).toEqual({ delivered: 1 });
  await waitFor(() => heard.length === 7);
  expect(heard).toEqual([...sent, { kind: 'thread', threadId }, { kind: 'agent', agentId: 'agent-a' }, { kind: 'thread', threadId }]);
}, 30_000);

test('a machine the core does not know, or a malformed coreId, is refused by its field', async () => {
  const a = await machine();
  const owner = await a.connect();
  const { threadId } = await echoThread(a, owner);
  const stranger = linkedPeer().coreId;

  expect(await thrown(owner.call('ui.reveal', { target: { kind: 'thread', threadId, coreId: stranger } }))).toThrow(`target.coreId ${stranger} is not this core's id, a machine of its group or a machine trusted for coordination`);
  expect(await thrown(owner.call('ui.reveal', { target: { kind: 'agent', agentId: 'agent-1', coreId: stranger } }))).toThrow('is not this core\'s id');
  expect(await thrown(owner.call('ui.reveal', { target: { kind: 'agent', agentId: 'agent-1', coreId: 'laptop' } }))).toThrow('target.coreId must be');
  expect(await thrown(owner.call('ui.reveal', { target: { kind: 'thread', threadId, coreId: null } as never }))).toThrow('target.coreId must be');
  // Without a coreId, the thread must still be this core's.
  expect(await thrown(owner.call('ui.reveal', { target: { kind: 'thread', threadId: 'thr_on_b' } }))).toThrow('is not a thread of this core');

  // A link the owner removes no longer counts.
  const linked = linkedPeer();
  a.core.coordination.trust(linked);
  expect(await owner.call('ui.reveal', { target: { kind: 'thread', threadId: 'thr_x', coreId: linked.coreId } })).toEqual({ delivered: 1 });
  expect(await thrown(owner.call('ui.reveal', { target: { kind: 'thread', threadId: '', coreId: linked.coreId } }))).toThrow('target.threadId must be 1 to 200 characters');
  a.core.coordination.untrust(linked.coreId);
  expect(await thrown(owner.call('ui.reveal', { target: { kind: 'thread', threadId: 'thr_x', coreId: linked.coreId } }))).toThrow('is not this core\'s id');
}, 30_000);
