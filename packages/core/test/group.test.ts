import { afterEach, expect, test } from 'bun:test';
import { GROUP_INVITE_PREFIX, type CoordinationConfig } from '@boite/contracts';
import { createHash } from 'node:crypto';
import { connect } from '../src/client.ts';
import { firstAnswer, settle } from '../src/coordination-wire.ts';
import { GroupStore } from '../src/group.ts';
import { group as groupCommand } from '../src/main.ts';
import { Refusals, REFUSALS_PER_MINUTE, senderOf } from '../src/server/refusals.ts';
import { advertisedAddresses, isTailnetAddress, tailnetAddress } from '../src/group/addresses.ts';
import { checkRoster, digestOf, fingerprint, liveCores, liveDevices, mergeRosters, type CoreEntry, type Roster } from '../src/group/roster.ts';
import { boxPublic, newBoxKey, open, openResponse, pack, seal, SEALED, sealResponse, unpack } from '../src/group/seal.ts';
import { parseInvite, parseTicket } from '../src/group/ticket.ts';
import { isAllowedOrigin } from '../src/server.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
afterEach(async () => {
  const stopping = cores.splice(0);
  // Every roster exchange still in flight ends while all the servers answer. Stopping
  // a server under a request made from this same process crashed Bun on Windows.
  await Promise.all(stopping.map((core) => core.core.group.close()));
  for (const core of stopping) await core.stop();
});

/**
 * Bun 1.4.2 on Windows crashes in its socket code when a socket is opened or
 * refused while another one of the same process is still closing: an event of
 * the old socket lands on memory the new one took. A test that closes a client
 * and opens the next lets the core finish with the first in between.
 */
async function settled(h: TestCore, open: number): Promise<void> {
  await waitFor(() => h.server.connections() <= open);
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function hangUp(h: TestCore, client: { close(): void }): Promise<void> {
  const open = h.server.connections();
  client.close();
  await settled(h, open - 1);
}

/** A hello the core refuses, and the socket it was said on gone before the test goes on. */
async function refusedHello(h: TestCore, token: string, options: Parameters<typeof connect>[2], message: string): Promise<void> {
  const open = h.server.connections();
  await expect(connect(h.url, token, options)).rejects.toThrow(message);
  await settled(h, open);
}

async function machine(): Promise<TestCore> {
  const core = await startTestCore();
  cores.push(core);
  return core;
}

/** `b` joins the group `a` belongs to, with an invitation `a` mints. */
async function join(a: TestCore, b: TestCore): Promise<void> {
  const { invite } = await a.core.group.invite();
  await b.core.group.join(invite);
}

function members(h: TestCore): string[] {
  return (h.core.group.view('owner')?.cores ?? []).map((core) => core.coreId).sort();
}

const id = (h: TestCore): string => h.core.coordination.card().coreId;

/** What a restart builds: a store reading the same journal, with nothing in memory, put in the core's place. */
function restart(h: TestCore): GroupStore {
  const store = new GroupStore(h.core);
  (h.core as unknown as { group: GroupStore }).group = store;
  store.restore();
  return store;
}

function entry(coreId: string, rev: number, extra: Partial<CoreEntry> = {}): CoreEntry {
  return { coreId, name: 'm', publicKey: 'k', box: 'b', boxSig: 's', addresses: [], epoch: 1, admit: { by: 'a', sig: 's' }, rev, ...extra };
}

test('a removal ends an epoch for good, and only a member this core already holds can open the next', () => {
  const live = (roster: Roster) => liveCores(roster).map((core) => core.coreId);
  const base: Roster = { id: 'grp', name: 'Home', founder: 'a', cores: [entry('a', 1), entry('b', 2)], devices: [] };
  const removed: Roster = { ...base, cores: [entry('a', 1), entry('b', 3, { removed: true })] };
  // The removed machine republishes itself at any revision it likes: it stays out, whichever side merges.
  const louder: Roster = { ...base, cores: [entry('a', 1), entry('b', 99)] };
  expect(live(mergeRosters(removed, louder))).toEqual(['a']);
  expect(live(mergeRosters(louder, removed))).toEqual(['a']);
  expect(digestOf(mergeRosters(removed, louder))).toBe(digestOf(mergeRosters(louder, removed)));
  // It admits itself for a new epoch, or shows the word of a machine this core does not hold as a member: still out.
  const self: Roster = { ...base, cores: [entry('a', 1), entry('b', 100, { epoch: 2, admit: { by: 'b', sig: 's' } })] };
  const stranger: Roster = { ...base, cores: [entry('a', 1), entry('b', 100, { epoch: 2, admit: { by: 'x', sig: 's' } }), entry('x', 5, { admit: { by: 'b', sig: 's' } })] };
  expect(live(mergeRosters(removed, self))).toEqual(['a']);
  expect(live(mergeRosters(removed, stranger))).toEqual(['a']);
  // A member lets it back in: a new epoch under that member's word.
  const readmitted: Roster = { ...base, cores: [entry('a', 1), entry('b', 4, { epoch: 2 })] };
  expect(live(mergeRosters(removed, readmitted))).toEqual(['a', 'b']);
  // A machine admitted by one just accepted in the same exchange is accepted too, in any listing order.
  const chain: Roster = { ...base, cores: [entry('d', 6, { admit: { by: 'c', sig: 's' } }), entry('a', 1), entry('b', 2), entry('c', 5)] };
  expect(live(mergeRosters(base, chain))).toEqual(['a', 'b', 'c', 'd']);
  // One admitted by a machine this core already removed is not, though the removal may come in the same roster as the admission.
  const byRemoved: Roster = { ...base, cores: [entry('a', 1), entry('b', 2), entry('e', 6, { admit: { by: 'b', sig: 's' } })] };
  expect(live(mergeRosters(removed, byRemoved))).toEqual(['a']);
  expect(live(mergeRosters(base, { ...byRemoved, cores: [entry('a', 1), entry('b', 7, { removed: true }), entry('e', 6, { admit: { by: 'b', sig: 's' } })] }))).toEqual(['a', 'e']);
  // A removal reported for an epoch this core has not seen is taken as it is: nobody gets in by it.
  expect(live(mergeRosters(base, { ...base, cores: [entry('a', 1), entry('b', 8, { epoch: 3, removed: true })] }))).toEqual(['a']);
  // Nothing is ever dropped, and merging twice changes nothing.
  const one = mergeRosters(removed, chain);
  expect(one.cores.map((core) => core.coreId)).toEqual(['a', 'b', 'c', 'd']);
  expect(digestOf(mergeRosters(one, one))).toBe(digestOf(one));
  // A device's removal is final: it wins over a later word of the device, in either order.
  const phone: Roster = { ...base, devices: [{ id: 'd', name: 'phone', role: 'device', rev: 9 }] };
  const revoked: Roster = { ...base, devices: [{ id: 'd', name: 'device', role: 'device', rev: 2, removed: true }] };
  expect(mergeRosters(phone, revoked).devices[0]?.removed).toBe(true);
  expect(digestOf(mergeRosters(phone, revoked))).toBe(digestOf(mergeRosters(revoked, phone)));
});

test('a device stops counting once the machine it paired with leaves', () => {
  const home = 'a'.repeat(64);
  const roster: Roster = { id: 'grp', name: 'Home', founder: home, cores: [entry(home, 1)], devices: [{ id: `${home}:ses_1`, name: 'phone', role: 'device', rev: 2 }] };
  expect(liveDevices(roster)).toHaveLength(1);
  expect(liveDevices({ ...roster, cores: [entry(home, 3, { removed: true })] })).toHaveLength(0);
});

test('a roster from another machine is read field by field', async () => {
  const a = await machine();
  await a.core.group.create('Home');
  const stored = a.core.journal.getSetting('group') as Roster;
  expect(checkRoster(stored).cores).toHaveLength(1);
  const forged = { ...stored, cores: [{ ...stored.cores[0], coreId: 'f'.repeat(64) }] };
  expect(() => checkRoster(forged)).toThrow('fingerprint');
  expect(() => checkRoster({ ...stored, cores: [{ ...stored.cores[0], addresses: ['http://user:pw@host:1'] }] })).toThrow('origin');
  expect(() => checkRoster({ ...stored, cores: [{ ...stored.cores[0], addresses: ['file:///etc/passwd'] }] })).toThrow('origin');
  expect(() => checkRoster({ ...stored, devices: [{ id: 'nope', name: 'x', role: 'device', rev: 1 }] })).toThrow('device');
  // The key the others seal to is the machine's own word: another member cannot put its own there.
  expect(() => checkRoster({ ...stored, cores: [{ ...stored.cores[0], box: boxPublic(newBoxKey()) }] })).toThrow('boxSig');
  expect(() => checkRoster({ ...stored, cores: [{ ...stored.cores[0], box: 'short' }] })).toThrow('box');
  // An admission is a signature: a made-up one, or one for another epoch, admits nobody.
  expect(() => checkRoster({ ...stored, cores: [{ ...stored.cores[0], admit: { by: stored.founder, sig: 'AAAA' } }] })).toThrow('no valid admission');
  expect(() => checkRoster({ ...stored, cores: [{ ...stored.cores[0], epoch: 2 }] })).toThrow('no valid admission');
  expect(() => checkRoster({ ...stored, founder: 'f'.repeat(64) })).toThrow('no valid admission');
  expect(() => fingerprint('not a key')).toThrow('Ed25519');
});

test('the tailnet address and name come first, then the LAN, and loopback only when nothing else answers', () => {
  const eth = { address: '192.168.1.20', family: 'IPv4', internal: false } as never;
  const ts = { address: '100.101.102.103', family: 'IPv4', internal: false } as never;
  expect(tailnetAddress({ eth0: [eth], tailscale0: [ts] }, {})).toBe('100.101.102.103');
  expect(tailnetAddress({ eth0: [eth] }, {})).toBeNull();
  // The range alone proves nothing: a carrier or another VPN hands out the same addresses.
  expect(tailnetAddress({ eth0: [ts] }, {})).toBeNull();
  expect(tailnetAddress({ utun4: [ts] }, {})).toBeNull();
  expect(tailnetAddress({ utun4: [ts, { address: 'fd7a:115c:a1e0::f', family: 'IPv6', internal: false } as never] }, {})).toBe('100.101.102.103');
  expect(tailnetAddress({ Tailscale: [ts] }, {})).toBe('100.101.102.103');
  expect(tailnetAddress({ tailscale0: [ts] }, { BOITE_TAILNET: '0' })).toBeNull();
  expect(isTailnetAddress('100.128.0.1')).toBe(false);
  const tailnet = { ip: '100.101.102.103', name: 'desk.tail.example' };
  expect(advertisedAddresses({ host: '127.0.0.1', port: 7000, tailnet: true, publicUrl: 'https://boite.example.com/' }, tailnet, '192.168.1.20'))
    .toEqual(['https://boite.example.com', 'http://desk.tail.example:7000', 'http://100.101.102.103:7000']);
  expect(advertisedAddresses({ host: '0.0.0.0', port: 7000, tailnet: false }, tailnet, '192.168.1.20'))
    .toEqual(['http://desk.tail.example:7000', 'http://100.101.102.103:7000', 'http://192.168.1.20:7000']);
  // No tailnet: the LAN address of a core listening on the network.
  expect(advertisedAddresses({ host: '0.0.0.0', port: 7000, tailnet: false }, null, '192.168.1.20')).toEqual(['http://192.168.1.20:7000']);
  // Listening on itself with a tailnet it does not answer on: only loopback is true.
  expect(advertisedAddresses({ host: '127.0.0.1', port: 7000, tailnet: false }, tailnet, '192.168.1.20')).toEqual(['http://127.0.0.1:7000']);
});

test('an invitation makes two machines members of one group, and a third joins through either', async () => {
  const a = await machine();
  const b = await machine();
  const c = await machine();
  expect(a.core.group.view('owner')).toBeNull();
  const group = await a.core.group.create('  Home  ');
  expect(group).toMatchObject({ name: 'Home', self: id(a), devices: [] });
  expect(group.cores).toEqual([expect.objectContaining({ coreId: id(a), addresses: [a.url] })]);
  await expect(a.core.group.create('Other')).rejects.toThrow('already belongs');

  const { invite, expiresAt } = await a.core.group.invite();
  expect(invite.startsWith(GROUP_INVITE_PREFIX)).toBe(true);
  expect(expiresAt).toBeGreaterThan(Date.now());
  expect(parseInvite(invite)).toMatchObject({ n: 'Home', c: id(a), a: [a.url], x: (a.core.journal.getSetting('group') as Roster).cores[0]!.box });
  await expect(a.core.group.join(invite)).rejects.toThrow('already belongs');

  const joined = await b.core.group.join(invite);
  expect(joined.name).toBe('Home');
  expect(members(a)).toEqual([id(a), id(b)].sort());
  expect(members(b)).toEqual(members(a));
  // The same machine asking again gets the same welcome; another one is refused.
  await expect(c.core.group.join(invite)).rejects.toThrow('already used');
  expect(c.core.group.view('owner')).toBeNull();

  // A member that did not mint the first invitation invites the third.
  await join(b, c);
  await waitFor(() => members(a).length === 3 && members(c).length === 3);
  expect(members(a)).toEqual(members(c));
  // The roster survives a restart of the store.
  expect(checkRoster(a.core.journal.getSetting('group')).cores).toHaveLength(3);
});

test('an invitation is refused when it is malformed, unknown, or answered by another key', async () => {
  const a = await machine();
  const b = await machine();
  const stranger = await machine();
  await a.core.group.create('Home');
  await expect(b.core.group.join('http://host/?grant=abc')).rejects.toThrow(GROUP_INVITE_PREFIX);
  const { invite } = await a.core.group.invite();
  const parsed = parseInvite(invite);
  const encode = (value: object) => GROUP_INVITE_PREFIX + Buffer.from(JSON.stringify({ v: 1, ...value })).toString('base64url');
  // A grant nobody minted names no invitation and seals with a key the inviter cannot open.
  await expect(b.core.group.join(encode({ ...parsed, t: 'f'.repeat(64) }))).rejects.toThrow('no machine accepted');
  // The address of a core that is not the one the invitation names: its answer does not verify.
  await stranger.core.group.create('Elsewhere');
  await expect(b.core.group.join(encode({ ...parsed, a: [stranger.url] }))).rejects.toThrow('no machine accepted');
  // Sealed to another key than the inviter's, the request does not open there.
  await expect(b.core.group.join(encode({ ...parsed, x: boxPublic(newBoxKey()) }))).rejects.toThrow('no machine accepted');
  expect(b.core.group.view('owner')).toBeNull();
  expect(members(a)).toEqual([id(a)]);
  // The untouched invitation still works after those attempts.
  await b.core.group.join(invite);
  expect(members(a)).toHaveLength(2);
});

test('the shell of one member is handed an owner key by another, once per ticket', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  const shell = await a.connect();
  const ticket = await shell.call('group.ticket', { coreId: id(b) });
  expect(ticket).toMatchObject({ coreId: id(b), addresses: [b.url] });
  expect(parseTicket(ticket.ticket).payload).toMatchObject({ iss: id(a), aud: id(b), sub: `core:${id(a)}`, role: 'owner' });

  const remote = await connect(b.url, '', { ticket: ticket.ticket });
  try {
    expect(remote.principal).toBe('owner');
    expect(remote.session?.token).toBeTruthy();
    expect((await remote.call('group.get', {}))?.self).toBe(id(b));
    const listed = await remote.call('sessions.list', {});
    expect(listed).toEqual([expect.objectContaining({ id: remote.session!.id, role: 'owner', group: true, current: true })]);
  } finally { await hangUp(b, remote); }
  // The key the ticket became keeps working; the ticket itself is spent.
  const again = await connect(b.url, remote.session!.token);
  expect(again.principal).toBe('owner');
  await hangUp(b, again);
  await refusedHello(b, '', { ticket: ticket.ticket }, 'already used');
  await expect(shell.call('group.ticket', { coreId: id(a) })).rejects.toThrow('not another machine');
  await expect(shell.call('group.ticket', { coreId: 'f'.repeat(64) })).rejects.toThrow('not another machine');
});

test('a ticket opens only at the address it names, and the key it becomes dies when the machine stops giving that address', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  await waitFor(() => members(b).length === 2);
  const shell = await a.connect();
  // Asked for an address b does not have: a vouches for none.
  await expect(shell.call('group.ticket', { coreId: id(b), url: 'http://10.9.9.9:1' })).rejects.toThrow('expected an address of');
  const ticket = await shell.call('group.ticket', { coreId: id(b), url: b.url });
  expect(ticket.url).toBe(b.url);
  expect(parseTicket(ticket.ticket).payload.u).toBe(b.url);
  const key = await connect(b.url, '', { ticket: ticket.ticket });
  await hangUp(b, key);
  // Between a move and the next publication, b's own roster entry is behind what b gives. A ticket for the
  // address that entry still lists is refused all the same: b reads what it gives at that moment.
  const behind = (h: TestCore): void => {
    const held = h.core.group as unknown as { roster: Roster };
    held.roster = { ...held.roster, cores: held.roster.cores.map((core) => (core.coreId === id(b) ? { ...core, addresses: ['http://10.9.9.9:1'] } : core)) };
  };
  const rosters = [a, b].map((h) => (h.core.group as unknown as { roster: Roster }).roster);
  behind(a);
  behind(b);
  await refusedHello(b, '', { ticket: (await shell.call('group.ticket', { coreId: id(b), url: 'http://10.9.9.9:1' })).ticket }, 'does not give');
  expect(b.core.group.honours(key.session!.id)).toBe(true);
  for (const [index, h] of [a, b].entries()) (h.core.group as unknown as { roster: Roster }).roster = rosters[index]!;
  // a makes another ticket on what it still lists, then b moves: it now gives an HTTPS address, and its plain HTTP one is given up.
  const late = await shell.call('group.ticket', { coreId: id(b), url: b.url });
  b.core.settings.set({ publicUrl: 'https://b.example' });
  await waitFor(() => b.core.group.view('owner')!.cores.find((core) => core.coreId === id(b))!.addresses[0] === 'https://b.example');
  // Whoever now sits where b was is sent that ticket and carries it to b: it opens nothing.
  await refusedHello(b, '', { ticket: late.ticket }, 'does not give');
  // The key issued for the old address went with it, so sending it there gives nothing away either.
  await refusedHello(b, key.session!.token, undefined, 'token is wrong');
  expect(await b.connect().then((owner) => owner.call('sessions.list', {}))).toEqual([]);

  // A key the group issued with no address remembered, as before addresses were, is revoked at the next start.
  const c = await machine();
  await join(a, c);
  await waitFor(() => members(c).length === 3);
  const old = await connect(c.url, '', { ticket: (await shell.call('group.ticket', { coreId: id(c) })).ticket });
  await hangUp(c, old);
  c.core.journal.deleteSetting('group:session-addresses');
  restart(c);
  await refusedHello(c, old.session!.token, undefined, 'token is wrong');

  // At a start the group is read back before the server listens, when nothing can be read yet of what this
  // machine gives: a key stands on what was last published. Once it listens, what it gives decides again.
  const kept = await connect(c.url, '', { ticket: (await shell.call('group.ticket', { coreId: id(c) })).ticket });
  await hangUp(c, kept);
  const bound = c.core.boundEndpoint.bind(c.core);
  (c.core as unknown as { boundEndpoint: () => unknown }).boundEndpoint = () => ({ host: '127.0.0.1', port: 0 });
  const starting = restart(c);
  expect(c.core.journal.getSession(kept.session!.id)).not.toBeNull();
  (c.core as unknown as { boundEndpoint: () => unknown }).boundEndpoint = bound;
  starting.start();
  expect(starting.honours(kept.session!.id)).toBe(true);
  (await connect(c.url, kept.session!.token)).close();
});

test('a ticket is refused when forged, expired, for another machine or from outside the group', async () => {
  const a = await machine();
  const b = await machine();
  const c = await machine();
  const outsider = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  await join(a, c);
  await outsider.core.group.create('Home');
  const owner = { principal: 'owner' as const, sessionId: null, threadId: null };
  const forB = a.core.group.ticket(id(b), owner).ticket;
  const [payload, signature] = forB.split('.') as [string, string];
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), role: 'owner', sub: `core:${id(c)}` })).toString('base64url');
  await refusedHello(b, '', { ticket: `${tampered}.${signature}` }, 'signature');
  await refusedHello(c, '', { ticket: forB }, 'another machine');
  await refusedHello(outsider, '', { ticket: forB }, 'another machine');
  expect(() => b.core.group.admit(forB, { name: 't', version: '1' }, Date.now() + 5 * 60_000)).toThrow('expired');
  await refusedHello(b, '', { ticket: 'nonsense' }, 'malformed');
  // A core in no group has nothing to check a ticket against.
  const alone = await machine();
  await refusedHello(alone, '', { ticket: forB }, 'no group');
  // An agent cannot ask for one, and a hello takes one credential.
  const owned = await a.connect();
  const { threadId } = await echoThread(a, owned);
  const agent = await connect(a.url, a.core.agents.tokenFor(threadId));
  await expect(agent.call('group.ticket', { coreId: id(b) })).rejects.toThrow("agent's methods");
  await hangUp(a, agent);
  // Nothing above left a session behind on b.
  expect(b.core.sessions.list(null)).toEqual([]);
});

test('a phone paired with one member reaches the others as a device, and one revoke takes it off all of them', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  const grant = a.core.sessions.grant();
  const phone = await connect(a.url, '', { grant: grant.grant, client: { name: 'pwa', version: '1' } });
  expect(phone.principal).toBe('session');
  const group = await phone.call('group.get', {});
  expect(group?.cores.map((core) => core.coreId).sort()).toEqual([id(a), id(b)].sort());
  // Who else is paired is not a phone's to read.
  expect(group?.devices).toEqual([]);
  await expect(phone.call('group.invite', {})).rejects.toThrow('owner only');
  await expect(phone.call('group.remove', { coreId: id(b) })).rejects.toThrow('owner only');

  const ticket = await phone.call('group.ticket', { coreId: id(b) });
  const deviceId = `${id(a)}:${phone.session!.id}`;
  expect(parseTicket(ticket.ticket).payload).toMatchObject({ sub: `device:${deviceId}`, role: 'device' });
  expect(a.core.group.view('owner')?.devices).toEqual([{ id: deviceId, name: 'pwa', role: 'device' }]);
  const onB = await connect(b.url, '', { ticket: ticket.ticket, client: { name: 'pwa', version: '1' } });
  expect(onB.principal).toBe('session');
  await expect(onB.call('projects.add', { path: b.dataDir })).rejects.toThrow('owner only');
  // From b it can ask a ticket back to a, under the same device.
  expect(parseTicket((await onB.call('group.ticket', { coreId: id(a) })).ticket).payload.sub).toBe(`device:${deviceId}`);
  await waitFor(() => b.core.group.view('owner')?.devices.length === 1);

  // Revoked on its home machine: the other member drops the key it handed out.
  a.core.sessions.revoke(phone.session!.id);
  expect(a.core.group.view('owner')?.devices).toEqual([]);
  await waitFor(() => b.core.sessions.list(null).length === 0);
  await refusedHello(b, onB.session!.token, undefined, 'token is wrong');
  // And no member vouches for it again.
  expect(() => b.core.group.admit(ticket.ticket, { name: 'pwa', version: '1' })).toThrow();
  phone.close();
  onB.close();
});

test('revoking a device on another member reaches its home machine, even before that member heard of the device', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  const phone = await connect(a.url, '', { grant: a.core.sessions.grant().grant });
  const onB = await connect(b.url, '', { ticket: (await phone.call('group.ticket', { coreId: id(b) })).ticket });
  // The ticket may have reached b before the roster that lists the device: b forgets the entry, as if it had.
  const held = b.core.group as unknown as { roster: Roster };
  held.roster = { ...held.roster, devices: [] };
  b.core.sessions.revoke(onB.session!.id);
  await waitFor(() => a.core.sessions.list(null).length === 0);
  await refusedHello(a, phone.session!.token, undefined, 'token is wrong');
  phone.close();
  onB.close();
});

test('a removed machine is told, leaves, and its keys die on the members that stay', async () => {
  const a = await machine();
  const b = await machine();
  const c = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  await join(a, c);
  await waitFor(() => members(b).length === 3 && members(c).length === 3);
  // b's shell holds an owner key on a.
  const key = await connect(a.url, '', { ticket: b.core.group.ticket(id(a), { principal: 'owner', sessionId: null, threadId: null }).ticket });
  await hangUp(a, key);
  expect(a.core.sessions.list(null)).toHaveLength(1);

  expect(a.core.group.remove(id(b)).cores.map((core) => core.coreId).sort()).toEqual([id(a), id(c)].sort());
  expect(() => a.core.group.remove(id(b))).toThrow('not a machine of this group');
  expect(() => a.core.group.remove(id(a))).toThrow('group.leave');
  expect(a.core.sessions.list(null)).toEqual([]);
  await waitFor(() => b.core.group.view('owner') === null && members(c).length === 2);
  // What b signs is no longer listened to, and a ticket from it opens nothing.
  await refusedHello(a, key.session!.token, undefined, 'token is wrong');
  expect(a.core.group.peers().map((peer) => peer.coreId)).toEqual([id(c)]);
});

test('a machine removed while it was unreachable learns it from the first member it asks', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  const roster = a.core.journal.getSetting('group') as Roster;
  // a removes b without b hearing: the roster is written as a removal would leave it.
  const removed = { ...roster, cores: roster.cores.map((core) => (core.coreId === id(b) ? { ...core, rev: 99, removed: true as const } : core)) };
  a.core.journal.setSetting('group', removed);
  (a.core.group as unknown as { roster: Roster }).roster = checkRoster(removed);
  expect(b.core.group.view('owner')).not.toBeNull();
  await (b.core.group as unknown as { syncPending(): Promise<void> }).syncPending();
  expect(b.core.group.view('owner')).toBeNull();
  expect(b.core.journal.getSetting('group')).toBeUndefined();
});

test('leaving tells the others first, and the last member leaving ends the group', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  await a.connect().then((client) => client.call('group.leave', {}));
  expect(a.core.group.view('owner')).toBeNull();
  expect(members(b)).toEqual([id(b)]);
  await b.core.group.leave();
  expect(b.core.group.view('owner')).toBeNull();
  await expect(b.core.group.leave()).rejects.toThrow('no group');
  // Both are free to start again, a under a new group.
  expect((await a.core.group.create('Again')).cores).toHaveLength(1);
});

test('members reach each other for agent messages and browser origins without a link made by hand', async () => {
  const a = await machine();
  const b = await machine();
  const ownerA = await a.connect();
  const ownerB = await b.connect();
  const brief: CoordinationConfig = { mode: 'brief', resources: 'shared VM', remote: true, paused: false };
  const ta = (await echoThread(a, ownerA, 'Maintenance')).threadId;
  const tb = (await echoThread(b, ownerB, 'Deployment')).threadId;
  a.core.coordination.configure(ta, brief);
  b.core.coordination.configure(tb, brief);
  expect((await a.core.coordination.directory(ta)).agents).toEqual([]);
  expect(a.core.group.allowsOrigin(b.url)).toBe(false);
  await a.core.group.create('Home');
  await join(a, b);
  const directory = await a.core.coordination.directory(ta);
  expect(directory.unavailable).toEqual([]);
  expect(directory.agents.map((agent) => agent.threadId)).toEqual([tb]);
  // The hand-made list stays what the owner made: the group's members are not copied into it.
  expect(a.core.coordination.peers()).toEqual([]);
  // A page served by b may open its socket on a, and a stranger's page still may not.
  expect(a.core.group.allowsOrigin(b.url)).toBe(true);
  expect(a.core.group.allowsOrigin('http://evil.test')).toBe(false);
  expect(isAllowedOrigin(b.url, a.server.port, '127.0.0.1')).toBe(false);
  const response = await fetch(`${a.url}/rpc`, { headers: { origin: 'http://evil.test', upgrade: 'websocket', connection: 'Upgrade' } });
  expect(response.status).toBe(403);
});

test('the owner\'s app carries what two members cannot send each other directly, still sealed', async () => {
  const a = await machine();
  const b = await machine();
  const ownerA = await a.connect();
  const ownerB = await b.connect();
  const brief: CoordinationConfig = { mode: 'brief', resources: 'shared VM', remote: true, paused: false };
  const ta = (await echoThread(a, ownerA, 'Maintenance')).threadId;
  const tb = (await echoThread(b, ownerB, 'Relayed-title')).threadId;
  a.core.coordination.configure(ta, brief);
  b.core.coordination.configure(tb, brief);
  await a.core.group.create('Home');
  await join(a, b);
  await waitFor(() => members(b).length === 2);
  const carried: { body: string; signature: string }[] = [];
  const forwarding: Promise<unknown>[] = [];
  ownerA.on('collaboration.bridge.request', (request) => {
    carried.push({ body: request.body, signature: request.signature });
    forwarding.push(ownerB.call('collaboration.bridge.forward', { coreId: request.fromCoreId, body: request.body, signature: request.signature })
      .then((response) => ownerA.call('collaboration.bridge.reply', { requestId: request.requestId, response })));
  });
  // No link was made by hand: being members of one group is enough for the app to relay between them.
  expect(a.core.coordination.peers()).toEqual([]);
  await ownerA.call('collaboration.bridge.register', { coreId: id(b), enabled: true });
  await expect(ownerA.call('collaboration.bridge.register', { coreId: 'f'.repeat(64), enabled: true })).rejects.toThrow('trusted for coordination');
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).endsWith('/agent-messages')) throw new Error('no route between the two machines');
    return real(input, init);
  }) as typeof fetch;
  try {
    expect((await a.core.coordination.directory(ta)).agents.map((agent) => agent.title)).toEqual(['Relayed-title']);
  } finally {
    globalThis.fetch = real;
  }
  await Promise.all(forwarding);
  expect(carried.length).toBeGreaterThan(0);
  expect(carried.every((entry) => entry.signature === SEALED && !entry.body.includes('operation'))).toBe(true);
});

test('a member is asked on the address that answered last, and on the others only once that one fails or stays silent', async () => {
  const asked: string[] = [];
  const send = (answers: Record<string, 'ok' | 'down' | 'silent'>) => (url: string): Promise<string> => {
    asked.push(url);
    if (answers[url] === 'ok') return Promise.resolve(url);
    return answers[url] === 'down' ? Promise.reject(new Error('down')) : new Promise<string>(() => undefined);
  };
  expect(await firstAnswer(['x', 'y', 'z'], send({ x: 'ok', y: 'ok', z: 'ok' }), 20)).toBe('x');
  expect(asked).toEqual(['x']);
  expect(await firstAnswer(['x', 'y', 'z'], send({ x: 'down', y: 'ok', z: 'silent' }), 20)).toBe('y');
  expect(await firstAnswer(['x', 'y'], send({ x: 'silent', y: 'ok' }), 20)).toBe('y');
  await expect(firstAnswer(['x', 'y'], send({ x: 'down', y: 'down' }), 20)).rejects.toBeInstanceOf(AggregateError);

  // Two addresses that lead to the same core, as a tailnet name and its address do: the copy a second
  // one would carry is a replay there, refused and counted against the sender. It is never sent.
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  await waitFor(() => members(b).length === 2);
  const held = b.core.group as unknown as { roster: Roster };
  const twice = [a.url, a.url.replace('127.0.0.1', 'localhost')];
  held.roster = { ...held.roster, cores: held.roster.cores.map((core) => (core.coreId === id(a) ? { ...core, addresses: twice } : core)) };
  const entry = held.roster.cores.find((core) => core.coreId === id(a))!;
  const real = globalThis.fetch;
  const dialled: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).endsWith('/agent-messages')) dialled.push(String(input));
    return real(input, init);
  }) as typeof fetch;
  try {
    const peer = { coreId: entry.coreId, name: entry.name, url: entry.addresses[0]!, publicKey: entry.publicKey };
    for (let index = 0; index < 3; index += 1) expect(await b.core.coordination.request(peer, 'directory', {})).toEqual([]);
  } finally {
    globalThis.fetch = real;
  }
  expect(dialled.filter((url) => url.startsWith(a.url)).length).toBeGreaterThanOrEqual(3);
  expect(dialled.filter((url) => url.includes('localhost'))).toEqual([]);
});

test('a roster is only taken from a member, never from a machine linked by hand', async () => {
  const a = await machine();
  const linked = await machine();
  await a.core.group.create('Home');
  a.core.coordination.trust(linked.core.coordination.identity());
  const roster = a.core.journal.getSetting('group') as Roster;
  const forged = { ...roster, cores: [...roster.cores, { ...linked.core.coordination.card(), name: 'Intruder', addresses: [linked.url], rev: 50 }] };
  await expect(linked.core.coordination.request({ ...a.core.coordination.identity() }, 'group.sync', forged)).rejects.toThrow('sealed requests only');
  expect(members(a)).toEqual([id(a)]);
});

test('a public address replaces the loopback one in what the group gives for this machine', async () => {
  const a = await machine();
  await a.core.group.create('Home');
  a.core.settings.set({ publicUrl: 'https://boite.example.com' });
  // Behind a proxy the core listens on itself: the public address is the only one another machine can dial.
  expect(a.core.group.view('owner')?.cores[0]?.addresses).toEqual(['https://boite.example.com']);
  const client = await a.connect();
  const updated = client.next('group.updated');
  a.core.settings.set({ publicUrl: null });
  await updated;
  expect((await client.call('group.get', {}))?.cores[0]?.addresses).toEqual([a.url]);
});

test('a sealed message opens only for the machine it was sealed to, from the machine it says, unaltered', () => {
  const recipient = newBoxKey();
  const context = { from: 'a'.repeat(64), to: 'b'.repeat(64) };
  const sealed = seal(pack('{"hello":1}', 'c2lnbmF0dXJl'), boxPublic(recipient), context);
  expect(sealed.body).not.toContain('hello');
  const opened = open(sealed.body, recipient, context);
  expect(unpack(opened.plaintext)).toEqual({ body: '{"hello":1}', signature: 'c2lnbmF0dXJl' });
  expect(opened.responseKey.equals(sealed.responseKey)).toBe(true);
  // Another machine's key, another claimed sender, another recipient, another pre-shared key: none opens.
  expect(() => open(sealed.body, newBoxKey(), context)).toThrow('does not open');
  expect(() => open(sealed.body, recipient, { ...context, from: 'c'.repeat(64) })).toThrow('does not open');
  expect(() => open(sealed.body, recipient, { ...context, to: 'c'.repeat(64) })).toThrow('does not open');
  expect(() => open(sealed.body, recipient, context, Buffer.alloc(32, 7))).toThrow('does not open');
  // One flipped bit of the ciphertext, or a swapped one-time key, is noticed.
  const wire = JSON.parse(sealed.body) as { epk: string; iv: string; ct: string };
  const flipped = Buffer.from(wire.ct, 'base64url');
  flipped[0] = flipped[0]! ^ 1;
  expect(() => open(JSON.stringify({ ...wire, ct: flipped.toString('base64url') }), recipient, context)).toThrow('does not open');
  expect(() => open(JSON.stringify({ ...wire, epk: boxPublic(newBoxKey()) }), recipient, context)).toThrow('does not open');
  expect(() => open(JSON.stringify({ ...wire, epk: Buffer.alloc(32).toString('base64url') }), recipient, context)).toThrow('key agreement');
  expect(() => open('{"v":2}', recipient, context)).toThrow('not a sealed message');
  // The answer opens with the key of that one exchange, in that direction only.
  const answer = sealResponse(pack('{"ok":true}', 'c2ln'), opened.responseKey, context);
  expect(unpack(openResponse(answer, sealed.responseKey, context)).body).toBe('{"ok":true}');
  expect(() => openResponse(answer, seal('x', boxPublic(recipient), context).responseKey, context)).toThrow('does not open');
  expect(() => open(JSON.stringify({ v: 1, epk: wire.epk, ...JSON.parse(answer) }), recipient, context)).toThrow('does not open');
  // Two seals of the same text share nothing.
  expect(seal('same', boxPublic(recipient), context).body).not.toBe(seal('same', boxPublic(recipient), context).body);
});

test('nothing a member sends another is readable on the wire, and a readable roster is refused', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Maison-du-test');
  const real = globalThis.fetch;
  const wire: { url: string; signature: string; body: string; status: number; answer: string }[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await real(input, init);
    const headers = new Headers(init?.headers);
    wire.push({ url: String(input), signature: headers.get('x-boite-signature') ?? '', body: String(init?.body ?? ''), status: response.status, answer: await response.clone().text() });
    return response;
  }) as typeof fetch;
  try {
    await join(a, b);
    await waitFor(() => wire.some((entry) => entry.url.endsWith('/agent-messages')));
    const ownerA = await a.connect();
    const ownerB = await b.connect();
    const brief: CoordinationConfig = { mode: 'brief', resources: 'secret-resource-name', remote: true, paused: false };
    const ta = (await echoThread(a, ownerA, 'Maintenance')).threadId;
    const tb = (await echoThread(b, ownerB, 'Secret-thread-title')).threadId;
    a.core.coordination.configure(ta, brief);
    b.core.coordination.configure(tb, brief);
    expect((await a.core.coordination.directory(ta)).agents.map((agent) => agent.title)).toEqual(['Secret-thread-title']);
  } finally {
    globalThis.fetch = real;
  }
  expect(wire.some((entry) => entry.url.endsWith('/group/join'))).toBe(true);
  expect(wire.filter((entry) => entry.url.endsWith('/agent-messages')).length).toBeGreaterThan(1);
  const publicKey = a.core.coordination.card().publicKey;
  expect(wire.filter((entry) => entry.status === 200).length).toBeGreaterThan(2);
  for (const entry of wire) {
    expect(entry.signature).toBe(SEALED);
    for (const text of [entry.body, entry.answer]) {
      for (const secret of ['Maison-du-test', 'Secret-thread-title', 'secret-resource-name', 'BEGIN PUBLIC KEY', publicKey.split('\n')[1]!, 'group.sync', 'directory']) {
        expect(text).not.toContain(secret);
      }
    }
    expect(Object.keys(JSON.parse(entry.body) as object).sort().join()).toBe('ct,epk,iv,v');
    // An offer that reached the joining machine before it had the roster is turned away in two words, with nothing in them.
    if (entry.status === 403) expect(entry.answer).toBe('unknown peer');
    else expect(Object.keys(JSON.parse(entry.answer) as object).sort().join()).toBe('ct,iv,v');
  }
  // The same roster, signed but readable, is not taken: a member's word arrives sealed or not at all.
  const self = a.core.coordination.card();
  const body = JSON.stringify({ from: id(b), to: self.coreId, at: Date.now(), nonce: crypto.randomUUID(), operation: 'group.sync', payload: b.core.journal.getSetting('group') });
  const clear = await fetch(`${a.url}/agent-messages`, { method: 'POST', body, headers: { 'x-boite-peer': id(b), 'x-boite-signature': b.core.coordination.signature(Buffer.from(body)).toString('base64') } });
  expect(clear.status).toBe(400);
  expect(await clear.json()).toMatchObject({ error: 'machines of a group exchange sealed requests only' });
  // And a sealed body that was tampered with gets no answer at all.
  const sealed = b.core.group.sealFor(self.coreId, pack(body, 'AAAA'))!;
  const broken = await fetch(`${a.url}/agent-messages`, { method: 'POST', body: sealed.body.replace(/"ct":"(.)/, (_m, c: string) => `"ct":"${c === 'A' ? 'B' : 'A'}`), headers: { 'x-boite-peer': id(b), 'x-boite-signature': SEALED } });
  expect(broken.status).toBe(403);
  expect(await broken.text()).toBe('invalid signed message');
});

test('a used invitation welcomes its machine again without writing, and never after that machine was removed', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  const { invite } = await a.core.group.invite();
  await b.core.group.join(invite);
  const stored = () => digestOf(checkRoster(a.core.journal.getSetting('group')));
  const before = stored();
  await b.core.group.leave();
  expect(members(a)).toEqual([id(a)]);
  // It left, which is a removal: the invitation it came in with does not bring it back.
  await expect(b.core.group.join(invite)).rejects.toThrow('has since been removed');
  expect(members(a)).toEqual([id(a)]);
  expect(b.core.group.view('owner')).toBeNull();
  // A fresh invitation does, under a new admission.
  const c = await machine();
  const second = (await a.core.group.invite()).invite;
  await c.core.group.join(second);
  const admitted = stored();
  expect(admitted).not.toBe(before);
  // The answer was lost and the machine asks again: same welcome, nothing rewritten.
  const retry = c.core.group as unknown as { roster: Roster | null };
  retry.roster = null;
  await c.core.group.join(second);
  expect(members(c)).toEqual([id(a), id(c)].sort());
  expect(stored()).toBe(admitted);
  await b.core.group.join((await a.core.group.invite()).invite);
  expect((a.core.journal.getSetting('group') as Roster).cores.find((core) => core.coreId === id(b))).toMatchObject({ epoch: 2, admit: { by: id(a) } });
});

test('a ticket stays spent across a restart of the machine it was used on', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  const ticket = a.core.group.ticket(id(b), { principal: 'owner', sessionId: null, threadId: null }).ticket;
  const first = b.core.group.admit(ticket, { name: 'shell', version: '1' });
  expect(first.role).toBe('owner');
  const before = b.core.group;
  const restarted = restart(b);
  expect(() => restarted.admit(ticket, { name: 'shell', version: '1' })).toThrow('already used');
  expect(b.core.sessions.list(null)).toHaveLength(1);
  await before.close();
});

test('keys die with what they stood for even when the core stopped between the removal and the cleanup', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  const key = b.core.group.admit(a.core.group.ticket(id(b), { principal: 'owner', sessionId: null, threadId: null }).ticket, { name: 'shell', version: '1' });
  const roster = b.core.journal.getSetting('group') as Roster;
  // The removal of `a` reached the journal, the session it vouched for was not dropped yet: the core died there.
  b.core.journal.setSetting('group', { ...roster, cores: roster.cores.map((core) => (core.coreId === id(a) ? { ...core, rev: 50, removed: true } : core)) });
  expect(b.core.sessions.list(null).map((session) => session.id)).toEqual([key.id]);
  const first = b.core.group;
  const afterRemoval = restart(b);
  expect(b.core.sessions.list(null)).toEqual([]);
  await first.close();
  // Same for a machine that left: the group setting is gone, a key it had handed out is not.
  const leftover = b.core.sessions.issue('owner', { name: 'shell', version: '1' });
  b.core.journal.setSetting('group:sessions', { [leftover.id]: `core:${id(a)}` });
  b.core.journal.deleteSetting('group');
  restart(b);
  expect(b.core.sessions.list(null)).toEqual([]);
  await afterRemoval.close();
});

test('an answer that arrives after its sender was removed changes nothing', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  const coordination = a.core.coordination;
  const real = coordination.request.bind(coordination);
  let removedDuring = false;
  // b holds its answer; a removes b; then the answer lands, signed by b and naming b alive at a later revision.
  coordination.request = async (peer, operation, payload) => {
    const answer = await real(peer, operation, payload) as { roster?: Roster };
    if (peer.coreId !== id(b) || removedDuring || answer?.roster === undefined) return answer;
    removedDuring = true;
    coordination.request = real;
    a.core.group.remove(id(b));
    return { roster: { ...answer.roster, cores: answer.roster.cores.map((core) => (core.coreId === id(b) ? { ...core, rev: 500 } : core)) } };
  };
  const entryOfB = (a.core.journal.getSetting('group') as Roster).cores.find((core) => core.coreId === id(b))!;
  await (a.core.group as unknown as { syncWith(entry: CoreEntry): Promise<void> }).syncWith(entryOfB);
  expect(removedDuring).toBe(true);
  expect(members(a)).toEqual([id(a)]);
  expect((a.core.journal.getSetting('group') as Roster).cores.find((core) => core.coreId === id(b))).toMatchObject({ removed: true });
});

test('"you were removed" counts only signed inside a sealed answer, never from a status line', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  const nonce = 'n-1';
  const sign = (body: string) => b.core.coordination.signature(Buffer.from(body)).toString('base64');
  const key = b.core.coordination.card().publicKey;
  // A genuine answer whose status somebody on the path rewrote to 410: not a removal.
  const ok = JSON.stringify({ nonce, result: { roster: null } });
  expect(() => settle('http://b', key, nonce, 410, ok, sign(ok))).toThrow('peer request failed');
  // A genuine "removed" made for another machine's exchange, readable: not a removal for this one.
  const gone = JSON.stringify({ nonce, error: 'this machine was removed from the group', gone: true });
  expect(() => settle('http://b', key, nonce, 410, gone, sign(gone))).toThrow('peer request failed');
  // Sealed to this exchange it is one, whatever the status line says.
  const context = { from: id(a), to: id(b) };
  const sealed = seal('request', (b.core.journal.getSetting('group') as Roster).cores.find((core) => core.coreId === id(b))!.box, context);
  const answer = sealResponse(pack(gone, sign(gone)), sealed.responseKey, context);
  expect(settle('http://b', key, nonce, 200, answer, SEALED, { responseKey: sealed.responseKey, context })).toEqual({ url: 'http://b', gone: true });
  // And a sealed request is never answered in the clear.
  expect(() => settle('http://b', key, nonce, 200, ok, sign(ok), { responseKey: sealed.responseKey, context })).toThrow('in the clear');
});

test('only a holder of the invitation spends the join allowance, and a pairing link never names a machine by a plain-HTTP name', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  const { invite } = await a.core.group.invite();
  const inviteId = createHash('sha256').update(`boite-group-invite-id\n${parseInvite(invite).t}`).digest('hex');
  const attempt = (named: string) => fetch(`${a.url}/group/join`, { method: 'POST', body: '{"v":1}', headers: { 'x-boite-peer': 'c'.repeat(64), 'x-boite-invite': named, 'x-boite-signature': SEALED } });
  // Naming an invitation, known or not, without holding it: refused each time, and the allowance is untouched.
  for (let index = 0; index < 20; index += 1) expect((await attempt('0'.repeat(64))).status).toBe(403);
  for (let index = 0; index < 40; index += 1) expect((await attempt(inviteId)).status).toBe(403);
  const retry = b.core.group as unknown as { roster: Roster | null };
  const real = globalThis.fetch;
  let recorded: { body: string; headers: Headers } | undefined;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).endsWith('/group/join')) recorded = { body: String(init?.body ?? ''), headers: new Headers(init?.headers) };
    return real(input, init);
  }) as typeof fetch;
  try {
    expect((await b.core.group.join(invite)).cores).toHaveLength(2);
  } finally {
    globalThis.fetch = real;
  }
  // That join, recorded on the path and sent again forty times, as it was or written another way:
  // refused before it is opened, and never charged.
  const respaced = JSON.stringify({ extra: 1, ...(JSON.parse(recorded!.body) as object) }, null, 2);
  for (let index = 0; index < 40; index += 1) {
    const replay = await fetch(`${a.url}/group/join`, { method: 'POST', body: index % 2 === 0 ? recorded!.body : respaced, headers: recorded!.headers });
    expect([replay.status, await replay.text()]).toEqual([403, 'this join request was already received']);
  }
  for (let index = 0; index < 29; index += 1) {
    retry.roster = null;
    expect((await b.core.group.join(invite)).cores).toHaveLength(2);
  }
  // The thirty-first request that opens, within the minute, is one too many, and one turned away is not remembered.
  retry.roster = null;
  await expect(b.core.group.join(invite)).rejects.toThrow('no machine accepted');
  expect((a.core.group as unknown as { invites: Map<string, { seen: Set<string> }> }).invites.get(inviteId)!.seen.size).toBe(30);
  retry.roster = a.core.journal.getSetting('group') as Roster;

  const held = a.core.group as unknown as { roster: Roster };
  const withAddresses = (addresses: string[]) => { held.roster = { ...held.roster, cores: held.roster.cores.map((core) => ({ ...core, addresses })) }; };
  withAddresses(['http://desk.tail.example:7000', 'http://100.101.102.103:7000', 'http://192.168.1.20:7000']);
  expect(a.core.group.ownAddress()).toBe('http://100.101.102.103:7000');
  expect(a.core.reachableUrl()).toBe('http://100.101.102.103:7000');
  withAddresses(['http://desk.tail.example:7000', 'https://desk.tail.example']);
  expect(a.core.group.ownAddress()).toBe('https://desk.tail.example');
  withAddresses(['http://desk.tail.example:7000']);
  expect(a.core.group.ownAddress()).toBeNull();
  withAddresses([a.url]);
  expect(a.core.group.ownAddress()).toBeNull();
});

test('a recorded request sent again and again never spends the member\'s allowance', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  await waitFor(() => members(b).length === 2);
  const body = JSON.stringify({ from: id(b), to: id(a), at: Date.now(), nonce: crypto.randomUUID(), operation: 'directory', payload: {} });
  const sealed = b.core.group.sealFor(id(a), pack(body, b.core.coordination.signature(Buffer.from(body)).toString('base64')))!;
  const send = () => fetch(`${a.url}/agent-messages`, { method: 'POST', body: sealed.body, headers: { 'x-boite-peer': id(b), 'x-boite-signature': SEALED } });
  expect((await send()).status).toBe(200);
  // What somebody on the path recorded, sent 150 times: each is refused as seen before, none is charged to b.
  for (let index = 0; index < 150; index += 1) expect((await send()).status).toBe(403);
  const entryOfA = (b.core.journal.getSetting('group') as Roster).cores.find((core) => core.coreId === id(a))!;
  const peer = { coreId: entryOfA.coreId, name: entryOfA.name, url: entryOfA.addresses[0]!, publicKey: entryOfA.publicKey };
  expect(await b.core.coordination.request(peer, 'directory', {})).toEqual([]);
});

test('requests are counted against the address they come from as they arrive, and a refusal keeps its place for a minute', () => {
  const refusals = new Refusals();
  const start = 1_000_000;
  // Sixty requests held open at once take every place: the next is turned away before its body is read.
  const held = Array.from({ length: REFUSALS_PER_MINUTE }, () => refusals.begin('10.0.0.9', start));
  expect(held.every((answered) => answered !== null)).toBe(true);
  expect(refusals.begin('10.0.0.9', start)).toBeNull();
  // Answered well, a request gives its place back. Refused, as unproven, removed or over quota, it keeps it.
  held[0]!(400);
  refusals.begin('10.0.0.9', start + 1)!(403);
  for (const [index, answered] of held.slice(1).entries()) answered!(index % 2 === 0 ? 410 : 429);
  expect(refusals.begin('10.0.0.9', start + 2)).toBeNull();
  // Another address is not the one that misbehaved, and the minute ends.
  refusals.begin('10.0.0.10', start + 2)!(400);
  refusals.begin('10.0.0.9', start + 60_001)!(403);
  expect(refusals.begin('10.0.0.9', start + 60_002)).not.toBeNull();

  // A host on IPv6 has a whole /64 to send from: it is one sender. An IPv4 address inside an IPv6 one is that address.
  expect(['2001:db8:1:2:aaaa::1', '2001:0db8:0001:0002::9', '2001:db8:1:3::1', '::ffff:10.0.0.9', 'fe80::1%eth0'].map(senderOf))
    .toEqual(['2001:db8:1:2::/64', '2001:db8:1:2::/64', '2001:db8:1:3::/64', '10.0.0.9', 'fe80:0:0:0::/64']);

  // A table with no room left counts the addresses it cannot hold together, never leaves them uncounted.
  const full = new Refusals(2);
  // Two members were served before the flood, one on IPv6: each keeps an allowance of its own.
  full.begin('10.0.5.5', start)!(200, 'member-a');
  full.begin('2001:db8:1:2::5', start)!(200, 'member-b');
  full.begin('10.0.1.1', start)!(403);
  full.begin('10.0.1.2', start)!(403);
  for (let index = 0; index < REFUSALS_PER_MINUTE; index += 1) full.begin(`10.0.2.${index}`, start)!(403);
  expect(full.begin('10.0.3.1', start)).toBeNull();
  expect(full.begin('10.0.1.1', start)).not.toBeNull();
  expect(full.begin('10.0.5.5', start)).not.toBeNull();
  // A stranger in that member's /64 is refused sixty times: the member's own address is not the one that pays.
  const prefix = new Refusals();
  prefix.begin('2001:db8:1:2::5', start)!(200, 'member-b');
  for (let index = 0; index < REFUSALS_PER_MINUTE; index += 1) prefix.begin('2001:db8:1:2::bad', start)!(403);
  expect(prefix.begin('2001:db8:1:2::bad', start)).toBeNull();
  expect(prefix.begin('2001:db8:1:2::5', start)).not.toBeNull();
  // Requests of one member carried from many addresses take neither another member's place nor the address it really uses.
  for (let index = 0; index < 200; index += 1) full.begin(`10.7.${index}.1`, start + 60_001 + index)!(200, 'member-a');
  for (let index = 0; index < REFUSALS_PER_MINUTE + 2; index += 1) full.begin(`10.8.${index}.1`, start + 61_000)?.(403);
  expect(full.begin('10.8.99.1', start + 61_000)).toBeNull();
  expect(full.begin('2001:db8:1:2::5', start + 61_000)).not.toBeNull();
  expect(full.begin('10.0.5.5', start + 61_000)).not.toBeNull();
  expect(full.begin('10.7.199.1', start + 61_000)).toBeNull();
  // Two members behind one address. One moves away for good and its places go to its new addresses:
  // the address stays the other member's.
  const shared = new Refusals(1);
  shared.begin('10.4.4.4', start)!(200, 'member-a');
  shared.begin('10.4.4.4', start)!(200, 'member-b');
  const later = start + 660_000;
  for (let index = 0; index < 4; index += 1) shared.begin(`10.5.${index}.1`, later)!(200, 'member-a');
  shared.begin('10.0.1.1', later)!(403);
  for (let index = 0; index < REFUSALS_PER_MINUTE; index += 1) shared.begin(`10.0.2.${index}`, later)!(403);
  expect(shared.begin('10.0.3.1', later)).toBeNull();
  expect(shared.begin('10.4.4.4', later)).not.toBeNull();
  // A request served that proved no name keeps no place of its own.
  const nameless = new Refusals(1);
  nameless.begin('10.9.9.9', start)!(200);
  nameless.begin('10.0.1.1', start)!(403);
  for (let index = 0; index < REFUSALS_PER_MINUTE; index += 1) nameless.begin(`10.0.2.${index}`, start)!(403);
  expect(nameless.begin('10.9.9.9', start)).toBeNull();
});

test('a removal needs no admission behind it, and the invitation is never a command-line argument', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  const roster = a.core.journal.getSetting('group') as Roster;
  const other = roster.cores.find((core) => core.coreId === id(b))!;
  // A machine admitted by one this core never accepted, and since removed: kept as a removal, readable back.
  const orphan = { ...other, admit: { by: 'e'.repeat(64), sig: 'AAAA' }, rev: 40, removed: true as const };
  expect(checkRoster({ ...roster, cores: [roster.cores.find((core) => core.coreId === id(a))!, orphan] }).cores).toHaveLength(2);
  expect(() => checkRoster({ ...roster, cores: [roster.cores.find((core) => core.coreId === id(a))!, { ...orphan, removed: undefined }] })).toThrow('no valid admission');
  await expect(groupCommand(['join', 'boite-group:anything', '--data-dir', a.dataDir])).rejects.toThrow('takes no argument');
});
