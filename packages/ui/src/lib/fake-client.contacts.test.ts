import { afterEach, expect, test } from 'vitest';
import { defaultCoordinationConfig, RpcErrorCode } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { FAKE_CONTACT_INVITE } from './fake-client/contacts';
import { RpcFailure } from './client';
import { encodeInvite, inviteShare, readInvite } from './contact-link';

/*
 * The in-memory core's contacts: the seed `?fake=1` draws, the event every
 * change sends, and the refusals the real core answers with, field named
 * when `packages/core/src/contacts/store.ts` names one.
 */

const clients: FakeClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });

async function fake(): Promise<{ client: FakeClient; events: () => number }> {
  const client = new FakeClient({ delayMs: 0 });
  clients.push(client);
  await client.connect();
  let heard = 0;
  client.on('contacts.updated', () => { heard += 1; });
  return { client, events: () => heard };
}

async function refusal(call: Promise<unknown>): Promise<{ code: number; field?: unknown }> {
  try {
    await call;
  } catch (error) {
    if (error instanceof RpcFailure) return { code: error.code, field: (error.data as { field?: unknown } | undefined)?.field };
    throw error;
  }
  throw new Error('the call was expected to fail');
}

test('the seed is Chris, connected, with one project each way and one request waiting', async () => {
  const { client } = await fake();
  const state = await client.call('contacts.get', {});
  expect(state.contacts.map(contact => [contact.name, contact.link, contact.grants.length, contact.offers.length])).toEqual([['Chris', 'connected', 1, 1]]);
  expect(state.contacts[0]!.fingerprint.split(' ')).toHaveLength(8);
  expect(state.requests.filter(request => request.status === 'pending').map(request => request.direction)).toEqual(['in']);
  expect(state.settings.minTier).toBe(1);
});

test('rename, trust, read grant and revoke answer the contact and send contacts.updated', async () => {
  const { client, events } = await fake();
  const [chris] = (await client.call('contacts.get', {})).contacts;
  const projectId = chris!.grants[0]!.projectId;
  expect((await client.call('contacts.update', { coreId: chris!.coreId, name: '  Chris B  ' })).name).toBe('Chris B');
  expect((await client.call('contacts.update', { coreId: chris!.coreId, trusted: true })).trusted).toBe(true);
  expect((await client.call('contacts.grant', { coreId: chris!.coreId, projectId, readThreads: true })).grants[0]!.readThreads).toBe(true);
  expect((await client.call('contacts.revoke', { coreId: chris!.coreId, projectId })).grants).toEqual([]);
  // Like the core, a project that was not open closes without a refusal.
  expect((await client.call('contacts.revoke', { coreId: chris!.coreId, projectId })).grants).toEqual([]);
  expect(events()).toBe(5);
  // The requests carry the new name: they show the contact as this owner calls it.
  expect((await client.call('contacts.get', {})).requests.every(request => request.contact === 'Chris B')).toBe(true);
  // The core's `text()` checks a name: blank or over 100 characters, and its error names no field.
  expect(await refusal(client.call('contacts.update', { coreId: chris!.coreId, name: ' ' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: undefined });
  expect(await refusal(client.call('contacts.update', { coreId: chris!.coreId, name: 'c'.repeat(101) }))).toEqual({ code: RpcErrorCode.InvalidParams, field: undefined });
  expect((await client.call('contacts.update', { coreId: chris!.coreId, name: 'c'.repeat(100) })).name).toHaveLength(100);
  // Two contacts never share a name, whatever its case.
  const dana = await client.call('contacts.join', { link: FAKE_CONTACT_INVITE });
  expect(await refusal(client.call('contacts.update', { coreId: dana.coreId, name: 'C'.repeat(100) }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'name' });
  expect(await refusal(client.call('contacts.grant', { coreId: chris!.coreId, projectId: 'nope' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'projectId' });
  expect(await refusal(client.call('contacts.update', { coreId: 'core-nobody', trusted: true }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'coreId' });
});

test('accepting opens the picked project to the asker; refusing without a reason declines; only a pending incoming request of a listed contact is decided', async () => {
  const { client } = await fake();
  const state = await client.call('contacts.get', {});
  const pending = state.requests.find(request => request.status === 'pending')!;
  // A blank reason fails the core's `text()`: no field named.
  expect(await refusal(client.call('contacts.decide', { id: pending.id, accept: false, reason: '  ' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: undefined });
  // Another machine of the group already opened its own p-notes: accepting still opens this core's.
  const member = new FakeClient({ delayMs: 0, coreId: 'machine-b' });
  clients.push(member);
  await member.connect();
  await client.call('group.create', { name: 'Home' });
  await member.call('group.join', { invite: (await client.call('group.invite', {})).invite });
  await client.call('contacts.grant', { coreId: state.contacts[0]!.coreId, projectId: 'p-notes', machine: 'machine-b' });
  const accepted = await client.call('contacts.decide', { id: pending.id, accept: true, projectId: 'p-notes' });
  expect([accepted.status, accepted.decidedBy, accepted.project?.name]).toEqual(['accepted', 'owner', 'notes']);
  const chris = (await client.call('contacts.get', {})).contacts[0]!;
  expect(chris.grants.map(grant => [grant.projectId, grant.readThreads, grant.machine ?? null])).toEqual(expect.arrayContaining([['p-notes', false, null], ['p-notes', false, 'machine-b']]));
  expect(await refusal(client.call('contacts.decide', { id: pending.id, accept: false, reason: 'late' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'id' });
  const out = state.requests.find(request => request.direction === 'out')!;
  expect(await refusal(client.call('contacts.decide', { id: out.id, accept: true, projectId: 'p-notes' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'id' });

  const other = (await fake()).client;
  const declined = await other.call('contacts.decide', { id: pending.id, accept: false });
  expect([declined.status, declined.reason]).toEqual(['refused', 'The owner declined this request.']);

  // A removed contact takes its requests along: nothing of it is left to accept.
  const removed = (await fake()).client;
  await removed.call('contacts.remove', { coreId: pending.coreId });
  expect((await removed.call('contacts.get', {})).requests.filter(request => request.coreId === pending.coreId)).toEqual([]);
  expect(await refusal(removed.call('contacts.decide', { id: pending.id, accept: true, projectId: 'p-notes' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'id' });
});

test('an invitation shares the machine only with a key; join refuses this core\'s own link, an expired one and a second join; eight words', async () => {
  const { client } = await fake();
  const shared = await client.call('contacts.invite', {});
  expect(shared.link.startsWith('boite://contact#')).toBe(true);
  expect(shared.share.status).toBe('created');
  // Someone already on this owner's Tailscale gets the link alone, key or not.
  const alone = await client.call('contacts.invite', { share: false });
  expect([alone.share, inviteShare(alone.link)]).toEqual([{ status: 'none' }, null]);
  expect(await refusal(client.call('contacts.invite', { share: 'no' as never }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'share' });
  // The core's fix: an `acls` rule naming this machine, never a grant to `autogroup:self`.
  const { policyFix } = (await client.call('contacts.get', {})).tailscale;
  expect(policyFix).toContain('"acls"');
  expect(policyFix).toContain('"dst":["100.101.102.103:8777"]');
  expect(policyFix).not.toContain('autogroup:self');
  const cleared = await client.call('contacts.tailscaleKey', { key: null });
  expect([cleared.apiKey, cleared.policy, cleared.policyFix]).toEqual([false, 'unknown', undefined]);
  const manual = await client.call('contacts.invite', {});
  expect(manual.share).toMatchObject({ status: 'manual' });
  expect(await refusal(client.call('contacts.tailscaleKey', { key: 'hunter2' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'key' });
  // Like the core's `checkApiKey`: ten to two hundred characters after the prefix.
  expect(await refusal(client.call('contacts.tailscaleKey', { key: 'tskey-api-x' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'key' });
  expect((await client.call('contacts.tailscaleKey', { key: 'tskey-api-0123456789' })).policy).toBe('open');

  expect(await refusal(client.call('contacts.join', { link: 'https://example.com' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'link' });
  expect(await refusal(client.call('contacts.join', { link: manual.link }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'link' });
  const expired = encodeInvite({ ...readInvite(FAKE_CONTACT_INVITE), e: 1 });
  expect(await refusal(client.call('contacts.join', { link: expired }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'link' });
  const joined = await client.call('contacts.join', { link: FAKE_CONTACT_INVITE });
  expect([joined.role, joined.machine, joined.fingerprint.split(' ').length]).toEqual(['guest', 'dana-laptop', 8]);
  expect(joined.coreId).toBe('core-dana');
  expect(await refusal(client.call('contacts.join', { link: FAKE_CONTACT_INVITE }))).toEqual({ code: RpcErrorCode.Refused, field: undefined });
  expect((await client.call('contacts.get', {})).contacts).toHaveLength(2);
  await client.call('contacts.remove', { coreId: joined.coreId });
  expect((await client.call('contacts.get', {})).contacts.map(contact => contact.name)).toEqual(['Chris']);
});

test('a cancelled invitation joins no other core, and a joined one counts no more at the inviter', async () => {
  const host = new FakeClient({ delayMs: 0, coreId: 'core-host', coreName: 'host-pc' });
  const guest = new FakeClient({ delayMs: 0, coreId: 'core-guest', coreName: 'guest-pc' });
  clients.push(host, guest);
  await Promise.all([host.connect(), guest.connect()]);
  const kept = await host.call('contacts.invite', { share: false });
  const dropped = await host.call('contacts.invite', { share: false });
  expect((await guest.call('contacts.join', { link: kept.link })).coreId).toBe('core-host');
  expect((await host.call('contacts.get', {})).invitations).toBe(1);
  await guest.call('contacts.remove', { coreId: 'core-host' });
  expect(await host.call('contacts.cancelInvites', {})).toEqual({ cancelled: 1 });
  expect(await refusal(guest.call('contacts.join', { link: dropped.link }))).toEqual({ code: RpcErrorCode.Refused, field: undefined });
  expect(await refusal(guest.call('contacts.join', { link: kept.link }))).toEqual({ code: RpcErrorCode.Refused, field: undefined });
  expect((await guest.call('contacts.get', {})).contacts.map(contact => contact.coreId)).toEqual(['core-chris']);
});

test('the tier takes 1, 2 or 3; an agent asks a contact by name and lists what each opened, unless its thread stays on this machine', async () => {
  const { client } = await fake();
  // `t-trace` runs echo, tier 2: the seeded minimum of 1 refuses it.
  expect(await refusal(client.call('collaboration.ask', { threadId: 't-trace', contact: 'Chris', text: 'An agent on the website' }))).toEqual({ code: RpcErrorCode.Refused, field: 'threadId' });
  expect(await client.call('contacts.settings', { settings: { minTier: 3 } })).toEqual({ minTier: 3 });
  expect(await refusal(client.call('contacts.settings', { settings: { minTier: 4 as never } }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'settings.minTier' });
  expect(await client.call('collaboration.contacts', { threadId: 't-trace' })).toEqual([{ name: 'Chris', coreId: 'core-chris', projects: ['website'], link: 'connected' }]);
  const asked = await client.call('collaboration.ask', { threadId: 't-trace', contact: 'chris', text: 'An agent on the website' });
  expect([asked.direction, asked.status, asked.contact]).toEqual(['out', 'pending', 'Chris']);
  // Any case, and a name's spaces written as hyphens, like `boite threads ask`.
  await client.call('contacts.update', { coreId: 'core-chris', name: 'Chris Brown' });
  expect((await client.call('collaboration.ask', { threadId: 't-trace', contact: 'CHRIS-brown', text: 'Docs' })).contact).toBe('Chris Brown');
  expect(await refusal(client.call('collaboration.ask', { threadId: 't-trace', contact: 'Nobody', text: 'x' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'contact' });
  expect(await refusal(client.call('collaboration.ask', { threadId: 't-trace', contact: 'Chris Brown', text: '  ' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: undefined });

  await client.call('collaboration.configure', { threadId: 't-trace', config: { ...defaultCoordinationConfig(), mode: 'off' } });
  expect(await client.call('collaboration.contacts', { threadId: 't-trace' })).toEqual([]);
  await client.call('collaboration.configure', { threadId: 't-trace', config: { ...defaultCoordinationConfig(), remote: false } });
  expect(await client.call('collaboration.contacts', { threadId: 't-trace' })).toEqual([]);
  expect(await refusal(client.call('collaboration.ask', { threadId: 't-trace', contact: 'Chris Brown', text: 'Docs' }))).toEqual({ code: RpcErrorCode.Refused, field: 'threadId' });
});
