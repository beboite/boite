import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLetter } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { memberThreadId } from '../src/contacts/members.ts';
import { RpcFailure } from '../src/errors.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

const cores: TestCore[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) await core.stop();
});

async function project(harness: TestCore, client: CoreClient, name: string): Promise<{ id: string }> {
  const path = join(harness.dataDir, 'projects', name);
  mkdirSync(path, { recursive: true });
  return client.call('projects.add', { path, name });
}

async function thread(client: CoreClient, projectId: string, title: string): Promise<string> {
  const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'echo');
  if (!account) throw new Error('no echo account');
  return (await client.call('threads.create', { projectId, providerId: 'echo', accountId: account.id, title })).id;
}

const letters = (harness: TestCore, threadId: string): AgentLetter[] => harness.core.coordination.get(threadId).messages;

/**
 * A contact linked to `host`, and `member`, another machine of the host's
 * group that the contact never meets.
 */
async function setup() {
  const host = await startTestCore();
  const guest = await startTestCore();
  const member = await startTestCore();
  cores.push(host, guest, member);
  host.core.contacts.selfUrl = async () => host.url;
  // Echo threads run an unknown model, tier 2: the default of 1 would refuse them.
  for (const side of [host, guest, member]) side.core.contacts.setSettings({ minTier: 2 });
  const hostClient = await host.connect();
  const guestClient = await guest.connect();
  const memberClient = await member.connect();
  const hostId = host.core.coordination.card().coreId;
  const guestId = guest.core.coordination.card().coreId;
  const memberId = member.core.coordination.card().coreId;
  await host.core.group.create('Home');
  await member.core.group.join((await host.core.group.invite()).invite);
  const invite = await hostClient.call('contacts.invite', {});
  await guestClient.call('contacts.join', { link: invite.link });
  await waitFor(() => host.core.contacts.linked(guestId));
  return { host, guest, member, hostClient, guestClient, memberClient, hostId, guestId, memberId };
}

test('a project of another machine of the group is opened to a contact through the machine it is linked to, both ways', async () => {
  const { host, guest, member, hostClient, guestClient, memberClient, hostId, guestId, memberId } = await setup();
  const gamma = await project(member, memberClient, 'gamma');
  const memberThread = await thread(memberClient, gamma.id, 'Gamma work');
  const guestThread = await thread(guestClient, (await project(guest, guestClient, 'mine')).id, 'Guest work');

  const shared = await hostClient.call('contacts.grant', { coreId: guestId, projectId: gamma.id, machine: memberId });
  expect(shared.grants).toEqual([expect.objectContaining({ projectId: gamma.id, machine: memberId, name: 'gamma', readThreads: false })]);
  // The contact reads the member's project among the host's, and the member keeps its copy of the contact.
  await waitFor(() => guest.core.contacts.find(hostId)?.offers.some(offer => offer.name === 'gamma') === true, 10000);
  await waitFor(() => member.core.contacts.members.relayedOf(guestId).length === 1, 10000);
  expect(member.core.contacts.forThread(memberThread)).toEqual([{ name: host.core.contacts.find(guestId)!.name, coreId: guestId, projects: [], link: 'connected' }]);
  // Listed once, and asking it still finds the host's mailbox route.
  expect((await member.core.coordination.mailboxes.contacts(memberThread)).filter(entry => entry.coreId === guestId)).toHaveLength(1);
  expect(member.core.coordination.mailboxes.route(memberThread, guestId)?.via).toBe(hostId);

  // The member's thread is listed under the host's id: the contact never learns of the member.
  const alias = memberThreadId(memberId, memberThread);
  const directory = await guest.core.coordination.directory(guestThread);
  expect(directory.agents.find(agent => agent.threadId === alias)).toMatchObject({ coreId: hostId, title: 'Gamma work', project: 'gamma' });
  expect(JSON.stringify(directory.agents)).not.toContain(memberId);
  expect((await guest.core.coordination.search(guestThread, 'gamma')).matches.map(match => match.threadId)).toEqual([alias]);

  // Contact to member, through the host.
  const out = await guest.core.coordination.send({ threadId: guestThread, to: { coreId: hostId, threadId: alias }, text: 'Which port does gamma use?', requestId: crypto.randomUUID() });
  await waitFor(() => letters(member, memberThread).some(letter => letter.id === out.id), 10000);
  const received = letters(member, memberThread).find(letter => letter.id === out.id)!;
  expect(received.contact).toEqual({ coreId: guestId, name: host.core.contacts.find(guestId)!.name });
  expect(received.from.coreId).toBe(guestId);
  await waitFor(() => ['received', 'delivered'].includes(letters(guest, guestThread).find(letter => letter.id === out.id)?.status ?? ''), 10000);

  // Member to contact, its reply carried back the same way, signed by the host.
  const back = await member.core.coordination.send({ threadId: memberThread, to: received.from, text: 'Port 8080.', replyTo: received.id, requestId: crypto.randomUUID() });
  await waitFor(() => letters(guest, guestThread).some(letter => letter.id === back.id), 10000);
  const answer = letters(guest, guestThread).find(letter => letter.id === back.id)!;
  expect(answer.from).toMatchObject({ coreId: hostId, threadId: alias });
  expect(answer.contact?.coreId).toBe(hostId);
  await waitFor(() => ['received', 'delivered'].includes(letters(member, memberThread).find(letter => letter.id === back.id)?.status ?? ''), 10000);

  // Reading takes readThreads, granted on the host for the member's project.
  expect(await thrown(guest.core.coordination.read(guestThread, { coreId: hostId, threadId: alias }))).toThrow('readThreads');
  await hostClient.call('contacts.grant', { coreId: guestId, projectId: gamma.id, machine: memberId, readThreads: true });
  expect((await guest.core.coordination.read(guestThread, { coreId: hostId, threadId: alias })).contact).toMatchObject({ coreId: hostId, threadId: alias });

  // Closed again: the member drops its copy, and the contact's next letter is refused.
  await hostClient.call('contacts.revoke', { coreId: guestId, projectId: gamma.id, machine: memberId });
  await waitFor(() => member.core.contacts.members.relayedOf(guestId).length === 0, 10000);
  const late = await guest.core.coordination.send({ threadId: guestThread, to: { coreId: hostId, threadId: alias }, text: 'Still there?', requestId: crypto.randomUUID() });
  await waitFor(() => letters(guest, guestThread).find(letter => letter.id === late.id)?.status === 'rejected', 10000);
  expect(letters(member, memberThread).some(letter => letter.id === late.id)).toBe(false);
  expect((await guest.core.coordination.directory(guestThread)).agents.some(agent => agent.threadId === alias)).toBe(false);
}, 60000);

test('a grant names a machine of the group and one of its projects, and only members relay for a contact', async () => {
  const { host, hostClient, guestId, memberId, member, memberClient } = await setup();
  const gamma = await project(member, memberClient, 'gamma');
  expect(await thrown(hostClient.call('contacts.grant', { coreId: guestId, projectId: gamma.id, machine: 'f'.repeat(64) }))).toThrow('machine: expected the core id of a machine of this core\'s group');
  expect(await thrown(hostClient.call('contacts.grant', { coreId: guestId, projectId: 'prj_missing', machine: memberId }))).toThrow('no unarchived project prj_missing');
  // This core's own id is this core.
  expect(await thrown(hostClient.call('contacts.grant', { coreId: guestId, projectId: gamma.id, machine: host.core.coordination.card().coreId }))).toThrow('expected an unarchived project of this core');
  expect((await hostClient.call('contacts.get', {})).contacts[0]!.grants).toEqual([]);
}, 30000);

/** The host's requests to the member fail as a network would while `down` holds for that operation. */
function cut(host: TestCore, member: string, operations: string[]): { restore(): void } {
  const coordination = host.core.coordination;
  const real = coordination.request.bind(coordination);
  coordination.request = (peer, operation, payload) => peer.coreId === member && operations.includes(operation) ? Promise.reject(new Error('machine unreachable')) : real(peer, operation, payload);
  return { restore: () => { coordination.request = real; } };
}

test('a member that missed a revoke reaches nothing through the linked machine, and a removal is pushed again until heard', async () => {
  const { host, guest, member, hostClient, guestClient, memberClient, hostId, guestId, memberId } = await setup();
  const gamma = await project(member, memberClient, 'gamma');
  const memberThread = await thread(memberClient, gamma.id, 'Gamma work');
  const mine = await project(guest, guestClient, 'mine');
  const guestThread = await thread(guestClient, mine.id, 'Guest work');
  await guestClient.call('contacts.grant', { coreId: hostId, projectId: mine.id });
  await hostClient.call('contacts.grant', { coreId: guestId, projectId: gamma.id, machine: memberId });
  await waitFor(() => member.core.contacts.members.relayedOf(guestId).length === 1, 10000);
  await waitFor(() => host.core.contacts.find(guestId)?.offers.length === 1, 10000);
  expect((await member.core.coordination.directory(memberThread)).agents.map(agent => agent.threadId)).toContain(guestThread);

  // The member is off when the grant closes: its copy stays, yet the linked machine relays nothing for it.
  const down = cut(host, memberId, ['relay.mirror']);
  await hostClient.call('contacts.revoke', { coreId: guestId, projectId: gamma.id, machine: memberId });
  expect(member.core.contacts.members.relayedOf(guestId)).toHaveLength(1);
  const stale = await member.core.coordination.directory(memberThread);
  expect(stale.agents.map(agent => agent.threadId)).not.toContain(guestThread);

  // Removing the last contact keeps the timer that retries the member's copy.
  await hostClient.call('contacts.grant', { coreId: guestId, projectId: gamma.id, machine: memberId });
  await hostClient.call('contacts.remove', { coreId: guestId });
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(host.core.contacts.members.behind()).toBe(true);
  expect((host.core.contacts as unknown as { timer: unknown }).timer).not.toBeNull();
  down.restore();
}, 60000);

test('a receipt a member could not answer is asked again, never refused', async () => {
  const { host, hostClient, memberClient, guestId, memberId, member } = await setup();
  const gamma = await project(member, memberClient, 'gamma');
  await hostClient.call('contacts.grant', { coreId: guestId, projectId: gamma.id, machine: memberId });
  const down = cut(host, memberId, ['relay.in']);
  const failure = await host.core.contacts.members.receipt(guestId, { id: crypto.randomUUID(), fromThreadId: 'thr_x' }).catch((error: unknown) => error);
  down.restore();
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(RpcFailure);
  // Every member answered and none knows it: that is final.
  expect(await thrown(host.core.contacts.members.receipt(guestId, { id: crypto.randomUUID(), fromThreadId: 'thr_x' }))).toThrow('unknown receipt');
}, 30000);

test('a contact still relayed by another member keeps the reply windows when one member drops it', async () => {
  const { host, member, memberClient, guestId, hostId } = await setup();
  const other = await startTestCore();
  cores.push(other);
  await other.core.group.join((await host.core.group.invite()).invite);
  const otherId = other.core.coordination.card().coreId;
  await waitFor(() => member.core.group.peers().some(peer => peer.coreId === otherId), 10000);
  const gamma = await project(member, memberClient, 'gamma');
  const delta = await project(member, memberClient, 'delta');
  const replying = await thread(memberClient, delta.id, 'Delta work');
  const entry = { coreId: guestId, name: 'Chris', minTier: 2, link: 'connected', offers: [], grants: [{ projectId: gamma.id, readThreads: false }] };
  member.core.contacts.members.mirrored(hostId, { contacts: [entry] });
  member.core.contacts.members.mirrored(otherId, { contacts: [entry] });
  // A thread outside the opened project wrote to the contact: it may hear back.
  member.core.contacts.reach.noteSent(replying, guestId);
  member.core.contacts.members.mirrored(hostId, { contacts: [] });
  expect(member.core.contacts.reach.mayReach(guestId, replying)).toBe(true);
  member.core.contacts.members.mirrored(otherId, { contacts: [] });
  expect(member.core.contacts.reach.mayReach(guestId, replying)).toBe(false);

  // Relayed by a member that then leaves the group: the contact is no longer a peer here.
  member.core.contacts.members.mirrored(otherId, { contacts: [entry] });
  expect(member.core.coordination.trusted().some(peer => peer.coreId === guestId)).toBe(true);
  host.core.group.remove(otherId);
  await waitFor(() => !member.core.group.peers().some(peer => peer.coreId === otherId), 10000);
  expect(member.core.coordination.trusted().some(peer => peer.coreId === guestId)).toBe(false);
}, 30000);


test('an authenticated group sync refreshes legacy relay copies without trusting missing admissions', async () => {
  const {host, member, hostClient, memberClient, hostId, guestId, memberId} = await setup();
  const gamma = await project(member, memberClient, 'legacy');
  await hostClient.call('contacts.grant', {coreId: guestId, projectId: gamma.id, machine: memberId});
  await waitFor(() => member.core.contacts.members.relayedOf(guestId).length === 1);
  const copies = member.core.journal.getSetting('contacts:relayed') as {admission?: string}[];
  member.core.journal.setSetting('contacts:relayed', copies.map(({admission, ...entry}) => entry));
  expect(member.core.contacts.members.relayedOf(guestId)).toEqual([]);
  const gateway = member.core.group.peers().find(peer => peer.coreId === hostId)!;
  await member.core.coordination.request(gateway, 'group.sync', member.core.group.require());
  await waitFor(() => member.core.contacts.members.relayedOf(guestId).length === 1);
  expect(member.core.contacts.members.relayedOf(guestId)[0]?.admission).toBe(copies[0]?.admission);
}, 30000);
