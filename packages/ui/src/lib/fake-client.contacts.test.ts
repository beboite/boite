import { afterEach, expect, test } from 'vitest';
import { RpcErrorCode } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { RpcFailure } from './client';

/*
 * The in-memory core's contacts: the seed `?fake=1` draws, the event every
 * change sends, and the refusals the real core answers with, field named.
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
  expect(state.contacts[0]!.fingerprint.split(' ')).toHaveLength(4);
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
  expect(events()).toBe(4);
  // The requests carry the new name: they show the contact as this owner calls it.
  expect((await client.call('contacts.get', {})).requests.every(request => request.contact === 'Chris B')).toBe(true);
  expect(await refusal(client.call('contacts.update', { coreId: chris!.coreId, name: ' ' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'name' });
  expect(await refusal(client.call('contacts.grant', { coreId: chris!.coreId, projectId: 'nope' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'projectId' });
  expect(await refusal(client.call('contacts.update', { coreId: 'core-nobody', trusted: true }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'coreId' });
});

test('accepting opens the picked project to the asker; refusing needs a reason; a decided request stays decided', async () => {
  const { client } = await fake();
  const state = await client.call('contacts.get', {});
  const pending = state.requests.find(request => request.status === 'pending')!;
  expect(await refusal(client.call('contacts.decide', { id: pending.id, accept: false, reason: '  ' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'reason' });
  const accepted = await client.call('contacts.decide', { id: pending.id, accept: true, projectId: 'p-notes' });
  expect([accepted.status, accepted.decidedBy, accepted.project?.name]).toEqual(['accepted', 'owner', 'notes']);
  const chris = (await client.call('contacts.get', {})).contacts[0]!;
  expect(chris.grants.map(grant => [grant.projectId, grant.readThreads])).toContainEqual(['p-notes', false]);
  expect((await refusal(client.call('contacts.decide', { id: pending.id, accept: false, reason: 'late' }))).code).toBe(RpcErrorCode.Refused);
  const out = state.requests.find(request => request.direction === 'out')!;
  expect((await refusal(client.call('contacts.decide', { id: out.id, accept: true, projectId: 'p-notes' }))).code).toBe(RpcErrorCode.Refused);
});

test('an invitation shares the machine only with a key; join checks the link and gives four words', async () => {
  const { client } = await fake();
  const shared = await client.call('contacts.invite', {});
  expect(shared.link.startsWith('boite://contact#')).toBe(true);
  expect(shared.share.status).toBe('created');
  const cleared = await client.call('contacts.tailscaleKey', { key: null });
  expect([cleared.apiKey, cleared.policy, cleared.policyFix]).toEqual([false, 'unknown', undefined]);
  const manual = await client.call('contacts.invite', {});
  expect(manual.share).toMatchObject({ status: 'manual' });
  expect(await refusal(client.call('contacts.tailscaleKey', { key: 'hunter2' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'key' });
  expect((await client.call('contacts.tailscaleKey', { key: 'tskey-api-x' })).policy).toBe('open');

  expect(await refusal(client.call('contacts.join', { link: 'https://example.com' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'link' });
  const joined = await client.call('contacts.join', { link: manual.link });
  expect([joined.role, joined.machine, joined.fingerprint.split(' ').length]).toEqual(['guest', 'This PC', 4]);
  expect((await client.call('contacts.get', {})).contacts).toHaveLength(2);
  await client.call('contacts.remove', { coreId: joined.coreId });
  expect((await client.call('contacts.get', {})).contacts.map(contact => contact.name)).toEqual(['Chris']);
});

test('the tier takes 1, 2 or 3; an agent asks a contact by name and lists what each opened', async () => {
  const { client } = await fake();
  expect(await client.call('contacts.settings', { settings: { minTier: 3 } })).toEqual({ minTier: 3 });
  expect(await refusal(client.call('contacts.settings', { settings: { minTier: 4 as never } }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'settings.minTier' });
  expect(await client.call('collaboration.contacts', { threadId: 't-any' })).toEqual([{ name: 'Chris', coreId: 'core-chris', projects: ['website'], link: 'connected' }]);
  const asked = await client.call('collaboration.ask', { threadId: 't-any', contact: 'Chris', text: 'An agent on the website' });
  expect([asked.direction, asked.status, asked.contact]).toEqual(['out', 'pending', 'Chris']);
  expect(await refusal(client.call('collaboration.ask', { threadId: 't-any', contact: 'Nobody', text: 'x' }))).toEqual({ code: RpcErrorCode.InvalidParams, field: 'contact' });
});
