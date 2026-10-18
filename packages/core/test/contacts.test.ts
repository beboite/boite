import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLetter } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { CONTACT_LINK_ROUTE } from '../src/contacts/store.ts';
import { setDriver } from '../src/drivers/index.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
let restore: (() => void) | undefined;
afterEach(async () => {
  restore?.();
  restore = undefined;
  for (const core of cores.splice(0)) await core.stop();
});

async function project(harness: TestCore, client: CoreClient, name: string, remote?: string): Promise<{ id: string; path: string }> {
  const path = join(harness.dataDir, 'projects', name);
  mkdirSync(path, { recursive: true });
  if (remote !== undefined) {
    mkdirSync(join(path, '.git'), { recursive: true });
    writeFileSync(join(path, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  }
  return client.call('projects.add', { path, name });
}

async function thread(client: CoreClient, projectId: string, title: string): Promise<string> {
  const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'echo');
  if (!account) throw new Error('no echo account');
  return (await client.call('threads.create', { projectId, providerId: 'echo', accountId: account.id, title })).id;
}

/** Two cores linked as contacts over loopback: the host's tailnet URL is its loopback URL. */
async function linked() {
  const host = await startTestCore();
  const guest = await startTestCore();
  cores.push(host, guest);
  host.core.contacts.selfUrl = async () => host.url;
  // Echo threads run an unknown model, tier 2: the default of 1 would refuse them.
  for (const side of [host, guest]) side.core.contacts.setSettings({ minTier: 2 });
  const hostClient = await host.connect();
  const guestClient = await guest.connect();
  const hostId = host.core.coordination.card().coreId;
  const guestId = guest.core.coordination.card().coreId;
  const invite = await hostClient.call('contacts.invite', {});
  const joined = await guestClient.call('contacts.join', { link: invite.link });
  await waitFor(() => host.core.contacts.linked(guestId));
  return { host, guest, hostClient, guestClient, hostId, guestId, invite, joined };
}

const letters = (harness: TestCore, threadId: string): AgentLetter[] => harness.core.coordination.get(threadId).messages;
const requestsOf = (harness: TestCore) => (harness.core.journal.getSetting('contacts:requests') as { id: string; direction: string; status: string }[] | undefined) ?? [];

/** Polls an async condition, for what only an RPC reads. */
async function eventually(predicate: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for a condition');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('an invitation links two owners: both keep the other\'s keys, read the same four words, and the guest\'s link carries the host\'s requests', async () => {
  const { host, guest, hostClient, guestClient, hostId, guestId, invite, joined } = await linked();
  expect(invite.link.startsWith('boite://contact#')).toBe(true);
  expect(invite.share.status).toBe('manual');
  expect(invite.expiresAt - Date.now()).toBeGreaterThan(23 * 3_600_000);
  expect(joined).toMatchObject({ coreId: hostId, role: 'guest', url: host.url, trusted: false, grants: [], offers: [] });
  const hostSide = (await hostClient.call('contacts.get', {})).contacts;
  expect(hostSide).toHaveLength(1);
  expect(hostSide[0]).toMatchObject({ coreId: guestId, role: 'host', link: 'connected' });
  expect(hostSide[0]!.url).toBeUndefined();
  expect(hostSide[0]!.fingerprint).toBe(joined.fingerprint);
  expect(joined.fingerprint.split(' ')).toHaveLength(4);
  await eventually(async () => (await guestClient.call('contacts.get', {})).contacts[0]?.link === 'connected');
  // The host cannot dial its guest: its request goes down the link and the answer comes back on it.
  expect(await host.core.coordination.check(guestId)).toEqual({ ok: true });
  expect(await guest.core.coordination.check(hostId)).toEqual({ ok: true });
  // Neither side's keys or addresses reach a client beyond what the contract names.
  expect(JSON.stringify(hostSide)).not.toContain('PUBLIC KEY');
}, 20000);

test('a granted project is all a contact sees: letters cross both ways, an ungranted project refuses them, and reading needs readThreads', async () => {
  const { host, guest, hostClient, guestClient, hostId, guestId } = await linked();
  const open = await project(host, hostClient, 'alpha');
  const closed = await project(host, hostClient, 'beta');
  const hostOpen = await thread(hostClient, open.id, 'Alpha work');
  const hostClosed = await thread(hostClient, closed.id, 'Beta work');
  const guestThread = await thread(guestClient, (await project(guest, guestClient, 'mine')).id, 'Guest work');
  await hostClient.call('contacts.grant', { coreId: guestId, projectId: open.id });
  // The host announces what it opened, down the link.
  await waitFor(() => guest.core.contacts.find(hostId)?.offers.some(offer => offer.name === 'alpha') === true, 10000);
  expect((await guestClient.call('contacts.get', {})).contacts[0]?.offers).toEqual([{ projectId: open.id, name: 'alpha' }]);
  const contacts = await guest.core.contacts.forThread(guestThread);
  expect(contacts).toEqual([{ name: guest.core.contacts.find(hostId)!.name, coreId: hostId, projects: ['alpha'], link: 'connected' }]);

  const directory = await guest.core.coordination.directory(guestThread);
  expect(directory.agents.some(agent => agent.threadId === hostOpen)).toBe(true);
  expect(directory.agents.some(agent => agent.threadId === hostClosed)).toBe(false);
  const search = await guest.core.coordination.search(guestThread, 'work');
  expect(search.matches.map(match => match.threadId)).toEqual([hostOpen]);

  // Guest to host, over HTTP: the host names the sender by its own name for the guest.
  const out = await guest.core.coordination.send({ threadId: guestThread, to: { coreId: hostId, threadId: hostOpen }, text: 'Which port does alpha use?', requestId: crypto.randomUUID() });
  expect(out.contact).toEqual({ coreId: hostId, name: guest.core.contacts.find(hostId)!.name });
  await waitFor(() => letters(host, hostOpen).some(letter => letter.id === out.id));
  const received = letters(host, hostOpen).find(letter => letter.id === out.id)!;
  expect(received.contact).toEqual({ coreId: guestId, name: host.core.contacts.find(guestId)!.name });

  // Host to guest, down the link: the guest thread wrote to this contact, so it may hear back outside any granted project.
  const back = await host.core.coordination.send({ threadId: hostOpen, to: { coreId: guestId, threadId: guestThread }, text: 'Port 8080.', requestId: crypto.randomUUID() });
  await waitFor(() => letters(guest, guestThread).some(letter => letter.id === back.id && letter.contact?.coreId === hostId), 10000);

  const refused = await guest.core.coordination.send({ threadId: guestThread, to: { coreId: hostId, threadId: hostClosed }, text: 'And beta?', requestId: crypto.randomUUID() });
  await waitFor(() => letters(guest, guestThread).find(letter => letter.id === refused.id)?.status === 'rejected', 10000);
  expect(letters(guest, guestThread).find(letter => letter.id === refused.id)?.error).toContain('not a thread of a project opened to you');
  expect(letters(host, hostClosed)).toHaveLength(0);

  await expect(guest.core.coordination.read(guestThread, { coreId: hostId, threadId: hostOpen })).rejects.toThrow('readThreads');
  await hostClient.call('contacts.grant', { coreId: guestId, projectId: open.id, readThreads: true });
  expect((await guest.core.coordination.read(guestThread, { coreId: hostId, threadId: hostOpen })).contact.threadId).toBe(hostOpen);
  await expect(guest.core.coordination.read(guestThread, { coreId: hostId, threadId: hostClosed })).rejects.toThrow('not a thread of a project opened to you');
}, 30000);

test('model tiers: a sender below its own owner\'s tier cannot write, and a letter whose attested model is below the recipient\'s tier is refused', async () => {
  const { host, guest, hostClient, guestClient, hostId, guestId } = await linked();
  const open = await project(host, hostClient, 'alpha');
  const hostThread = await thread(hostClient, open.id, 'Alpha work');
  const guestThread = await thread(guestClient, (await project(guest, guestClient, 'mine')).id, 'Guest work');
  await hostClient.call('contacts.grant', { coreId: guestId, projectId: open.id });
  await guestClient.call('contacts.settings', { settings: { minTier: 1 } });
  await expect(guest.core.coordination.send({ threadId: guestThread, to: { coreId: hostId, threadId: hostThread }, text: 'Hello', requestId: crypto.randomUUID() })).rejects.toThrow('tier 2');
  await expect(guestClient.call('collaboration.ask', { threadId: guestThread, contact: hostId, text: 'an agent on alpha' })).rejects.toThrow('tier 2');
  await guestClient.call('contacts.settings', { settings: { minTier: 2 } });
  await hostClient.call('contacts.settings', { settings: { minTier: 1 } });
  const letter = await guest.core.coordination.send({ threadId: guestThread, to: { coreId: hostId, threadId: hostThread }, text: 'Hello', requestId: crypto.randomUUID() });
  await waitFor(() => letters(guest, guestThread).find(entry => entry.id === letter.id)?.status === 'rejected', 10000);
  expect(letters(guest, guestThread).find(entry => entry.id === letter.id)?.error).toContain('takes tier 1 or better');
  await expect(hostClient.call('contacts.settings', { settings: { minTier: 4 as 1 } })).rejects.toThrow('settings.minTier: expected 1, 2 or 3');
}, 30000);

test('an ask waits for the owner, who opens a project; the asking thread hears the answer as a message from the contact', async () => {
  const { host, guest, hostClient, guestClient, hostId, guestId } = await linked();
  const open = await project(host, hostClient, 'alpha');
  const hostThread = await thread(hostClient, open.id, 'Alpha work');
  const guestThread = await thread(guestClient, (await project(guest, guestClient, 'mine')).id, 'Guest work');
  // An agent names a contact as its owner did, in any case.
  const asked = await guestClient.call('collaboration.ask', { threadId: guestThread, contact: guest.core.contacts.find(hostId)!.name.toUpperCase(), text: 'an agent on a project like alpha' });
  expect(asked).toMatchObject({ direction: 'out', coreId: hostId, status: 'pending' });
  await waitFor(() => requestsOf(host).some(request => request.id === asked.id && request.direction === 'in'), 10000);
  const incoming = (await hostClient.call('contacts.get', {})).requests;
  expect(incoming[0]).toMatchObject({ id: asked.id, direction: 'in', status: 'pending', text: 'an agent on a project like alpha' });
  await expect(hostClient.call('contacts.decide', { id: asked.id, accept: true })).rejects.toThrow('projectId');
  const decided = await hostClient.call('contacts.decide', { id: asked.id, accept: true, projectId: open.id });
  expect(decided).toMatchObject({ status: 'accepted', decidedBy: 'owner', project: { id: open.id, name: 'alpha' } });
  expect(host.core.contacts.find(guestId)?.grants).toEqual([expect.objectContaining({ projectId: open.id, readThreads: false })]);
  await waitFor(() => letters(guest, guestThread).some(letter => letter.origin === 'contact'), 15000);
  const answer = letters(guest, guestThread).find(letter => letter.origin === 'contact')!;
  expect(answer.contact?.coreId).toBe(hostId);
  expect(answer.text).toContain('"alpha"');
  expect(answer.text).toContain(hostThread);
  const mine = (await guestClient.call('contacts.get', {})).requests.find(request => request.id === asked.id);
  expect(mine).toMatchObject({ status: 'accepted', decidedBy: 'owner', project: { id: open.id, name: 'alpha' } });
}, 30000);

test('a trusted contact whose git remote matches exactly one project is answered without the owner, and the concierge decides the rest', async () => {
  const { host, guest, hostClient, guestClient, hostId, guestId } = await linked();
  const app = await project(host, hostClient, 'app', 'git@github.com:Acme/App.git');
  const docs = await project(host, hostClient, 'docs', 'https://github.com/acme/docs');
  await thread(hostClient, app.id, 'App work');
  const mine = await project(guest, guestClient, 'mine', 'https://user:secret@github.com/acme/app');
  const guestThread = await thread(guestClient, mine.id, 'Guest work');
  const plainThread = await thread(guestClient, (await project(guest, guestClient, 'plain')).id, 'Guest notes');
  await hostClient.call('contacts.update', { coreId: guestId, trusted: true });

  const matched = await guestClient.call('collaboration.ask', { threadId: guestThread, contact: hostId, text: 'help on the app' });
  // Only host and path leave the guest: never the credentials its remote carries.
  expect(matched.gitRemote).toBe('github.com/acme/app');
  await waitFor(() => requestsOf(guest).find(request => request.id === matched.id)?.status === 'accepted', 15000);
  const answered = (await hostClient.call('contacts.get', {})).requests.find(request => request.id === matched.id);
  expect(answered).toMatchObject({ status: 'accepted', decidedBy: 'match', project: { id: app.id } });

  // No remote decides this one: the concierge, on the owner's "concierge" profile, opens docs.
  const echo = (await hostClient.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!;
  host.core.journal.setSetting('delegation:contacts-test', { enabled: true, paused: false, profiles: [{ id: 'concierge', name: 'Concierge', providerId: 'echo', accountId: echo.id, model: 'echo', effort: null }] });
  const prompts: string[] = [];
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      const id = ctx.emit.startMessage('assistant');
      const concierge = ctx.prompt.includes('You are the concierge');
      if (concierge) prompts.push(ctx.prompt);
      ctx.emit.part(id, 0, { type: 'text', text: concierge ? `The docs project fits.\nCONCIERGE: OPEN ${docs.id}` : 'Noted.' });
      ctx.emit.complete(id, 'complete');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
    },
  });
  const other = await guestClient.call('collaboration.ask', { threadId: plainThread, contact: hostId, text: 'someone who writes documentation' });
  expect(other.gitRemote).toBeUndefined();
  await waitFor(() => requestsOf(guest).find(request => request.id === other.id)?.status === 'accepted', 20000);
  const viaConcierge = (await hostClient.call('contacts.get', {})).requests.find(request => request.id === other.id);
  expect(viaConcierge).toMatchObject({ status: 'accepted', decidedBy: 'concierge', project: { id: docs.id } });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('someone who writes documentation');
  // The concierge never opens conversations to reading.
  expect(host.core.contacts.find(guestId)?.grants.every(grant => !grant.readThreads)).toBe(true);
  const conciergeThread = host.core.journal.listThreads().find(entry => entry.title.startsWith('Concierge'));
  expect(conciergeThread).toMatchObject({ permissionMode: 'plan', projectId: null });
  await waitFor(() => host.core.journal.getThread(conciergeThread!.id)?.archived === true);
}, 40000);

test('revoke rejects letters waiting for the closed project and hides it; remove closes the link', async () => {
  const { host, guest, hostClient, guestClient, hostId, guestId } = await linked();
  const open = await project(host, hostClient, 'alpha');
  const hostThread = await thread(hostClient, open.id, 'Alpha work');
  const guestThread = await thread(guestClient, (await project(guest, guestClient, 'mine')).id, 'Guest work');
  await hostClient.call('contacts.grant', { coreId: guestId, projectId: open.id });
  // Paused, the host thread keeps the letter waiting.
  host.core.coordination.configure(hostThread, { mode: 'brief', resources: '', remote: true, paused: true });
  const letter = await guest.core.coordination.send({ threadId: guestThread, to: { coreId: hostId, threadId: hostThread }, text: 'Can you free port 8080?', requestId: crypto.randomUUID() });
  await waitFor(() => letters(host, hostThread).find(entry => entry.id === letter.id)?.status === 'received', 10000);
  await hostClient.call('contacts.revoke', { coreId: guestId, projectId: open.id });
  expect(letters(host, hostThread).find(entry => entry.id === letter.id)).toMatchObject({ status: 'rejected', error: 'Project closed to this contact' });
  await waitFor(() => guest.core.contacts.find(hostId)?.offers.length === 0, 10000);
  expect((await guest.core.coordination.directory(guestThread)).agents.some(agent => agent.threadId === hostThread)).toBe(false);

  expect(await hostClient.call('contacts.remove', { coreId: guestId })).toEqual({ ok: true });
  expect((await hostClient.call('contacts.get', {})).contacts).toHaveLength(0);
  expect(host.core.coordination.trusted().some(peer => peer.coreId === guestId)).toBe(false);
  // The host closed the socket; the guest's redial is refused, its link stays down.
  await eventually(async () => (await guestClient.call('contacts.get', {})).contacts[0]?.link !== 'connected');
  await expect(host.core.coordination.check(guestId)).rejects.toThrow('not trusted');
  await expect(guest.core.coordination.check(hostId)).rejects.toThrow();
}, 30000);

test('the link refuses a replayed or stale hello, a contact\'s readable request, and a second join with a spent invitation', async () => {
  const { host, guest, guestClient, hostId, guestId, invite } = await linked();
  const helloHeaders = (at: number, nonce: string): Record<string, string> => {
    const hello = JSON.stringify({ v: 1, from: guestId, to: hostId, at, nonce });
    return {
      'x-boite-peer': guestId,
      'x-boite-hello': Buffer.from(hello).toString('base64url'),
      'x-boite-signature': guest.core.coordination.signature(Buffer.from(`boite-contact-hello\n${hello}`)).toString('base64'),
    };
  };
  const nonce = crypto.randomUUID();
  // Checked before the upgrade: a plain GET spends the nonce, then fails only for not being a websocket.
  expect((await fetch(`${host.url}${CONTACT_LINK_ROUTE}`, { headers: helloHeaders(Date.now(), nonce) })).status).toBe(400);
  const replayed = await fetch(`${host.url}${CONTACT_LINK_ROUTE}`, { headers: helloHeaders(Date.now(), nonce) });
  expect(replayed.status).toBe(403);
  expect(await replayed.text()).toContain('replayed');
  const stale = await fetch(`${host.url}${CONTACT_LINK_ROUTE}`, { headers: helloHeaders(Date.now() - 120_000, crypto.randomUUID()) });
  expect(stale.status).toBe(403);
  expect(await stale.text()).toContain('within a minute');
  const forged = { ...helloHeaders(Date.now(), crypto.randomUUID()), 'x-boite-signature': host.core.coordination.signature(Buffer.from('other')).toString('base64') };
  expect((await fetch(`${host.url}${CONTACT_LINK_ROUTE}`, { headers: forged })).status).toBe(403);

  // A readable envelope, correctly signed by the contact, is still refused.
  const body = JSON.stringify({ from: guestId, to: hostId, at: Date.now(), nonce: crypto.randomUUID(), operation: 'directory', payload: {} });
  const readable = await fetch(`${host.url}/agent-messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-boite-peer': guestId, 'x-boite-signature': guest.core.coordination.signature(Buffer.from(body)).toString('base64') },
    body,
  });
  expect(readable.status).toBe(400);
  expect((await readable.json() as { error: string }).error).toBe('contacts exchange sealed requests only');

  // The guest forgets the host and tries the same link again: the host spent its token at the first join.
  await guestClient.call('contacts.remove', { coreId: hostId });
  await expect(guestClient.call('contacts.join', { link: invite.link })).rejects.toThrow('already used or expired');
  expect(host.core.contacts.list()).toHaveLength(1);
}, 30000);
