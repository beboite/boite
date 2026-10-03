import { afterEach, expect, test } from 'bun:test';
import { GROUP_INVITE_PREFIX, type CoordinationConfig } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { advertisedAddresses, isTailnetAddress, tailnetAddress } from '../src/group/addresses.ts';
import { checkRoster, digestOf, fingerprint, liveCores, liveDevices, mergeRosters, type CoreEntry, type Roster } from '../src/group/roster.ts';
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

function entry(coreId: string, rev: number, extra: Partial<CoreEntry> = {}): CoreEntry {
  return { coreId, name: 'm', publicKey: 'k', addresses: [], rev, ...extra };
}

test('rosters merge to the same result in either order, and a removal survives a stale copy', () => {
  const base: Roster = { id: 'grp', name: 'Home', cores: [entry('a', 1), entry('b', 2)], devices: [] };
  const removed: Roster = { ...base, cores: [entry('a', 1), entry('b', 3, { removed: true })] };
  const stale: Roster = { ...base, cores: [entry('a', 1), entry('b', 2), entry('c', 3)], devices: [{ id: 'd', name: 'phone', role: 'device', rev: 4 }] };
  const one = mergeRosters(removed, stale);
  const two = mergeRosters(stale, removed);
  expect(digestOf(one)).toBe(digestOf(two));
  expect(liveCores(one).map((core) => core.coreId)).toEqual(['a', 'c']);
  // The stale member merged again later still cannot bring `b` back.
  expect(liveCores(mergeRosters(one, base)).map((core) => core.coreId)).toEqual(['a', 'c']);
  // At the same revision the removal wins on both sides.
  const tie = mergeRosters({ ...base, cores: [entry('a', 5)] }, { ...base, cores: [entry('a', 5, { removed: true })] });
  expect(tie.cores[0]?.removed).toBe(true);
  expect(digestOf(mergeRosters(one, one))).toBe(digestOf(one));
});

test('a device stops counting once the machine it paired with leaves', () => {
  const home = 'a'.repeat(64);
  const roster: Roster = { id: 'grp', name: 'Home', cores: [entry(home, 1)], devices: [{ id: `${home}:ses_1`, name: 'phone', role: 'device', rev: 2 }] };
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
  expect(() => fingerprint('not a key')).toThrow('Ed25519');
});

test('the tailnet address and name come first, then the LAN, and loopback only when nothing else answers', () => {
  const eth = { address: '192.168.1.20', family: 'IPv4', internal: false } as never;
  const ts = { address: '100.101.102.103', family: 'IPv4', internal: false } as never;
  expect(tailnetAddress({ eth0: [eth], tailscale0: [ts] }, {})).toBe('100.101.102.103');
  expect(tailnetAddress({ eth0: [eth] }, {})).toBeNull();
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
  expect(parseInvite(invite)).toMatchObject({ n: 'Home', c: id(a), a: [a.url] });
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
  await expect(b.core.group.join(encode({ ...parsed, t: 'f'.repeat(64) }))).rejects.toThrow('already used');
  // The address of a core that is not the one the invitation names: its answer does not verify.
  await stranger.core.group.create('Elsewhere');
  await expect(b.core.group.join(encode({ ...parsed, a: [stranger.url] }))).rejects.toThrow('no machine answered');
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
  } finally { remote.close(); }
  // The key the ticket became keeps working; the ticket itself is spent.
  const again = await connect(b.url, remote.session!.token);
  expect(again.principal).toBe('owner');
  again.close();
  await expect(connect(b.url, '', { ticket: ticket.ticket })).rejects.toThrow('already used');
  await expect(shell.call('group.ticket', { coreId: id(a) })).rejects.toThrow('not another machine');
  await expect(shell.call('group.ticket', { coreId: 'f'.repeat(64) })).rejects.toThrow('not another machine');
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
  await expect(connect(b.url, '', { ticket: `${tampered}.${signature}` })).rejects.toThrow('signature');
  await expect(connect(c.url, '', { ticket: forB })).rejects.toThrow('another machine');
  await expect(connect(outsider.url, '', { ticket: forB })).rejects.toThrow('another machine');
  expect(() => b.core.group.admit(forB, { name: 't', version: '1' }, Date.now() + 5 * 60_000)).toThrow('expired');
  await expect(connect(b.url, '', { ticket: 'nonsense' })).rejects.toThrow('malformed');
  // A core in no group has nothing to check a ticket against.
  const alone = await machine();
  await expect(connect(alone.url, '', { ticket: forB })).rejects.toThrow('no group');
  // An agent cannot ask for one, and a hello takes one credential.
  const owned = await a.connect();
  const { threadId } = await echoThread(a, owned);
  const agent = await connect(a.url, a.core.agents.tokenFor(threadId));
  await expect(agent.call('group.ticket', { coreId: id(b) })).rejects.toThrow("agent's methods");
  agent.close();
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
  await expect(connect(b.url, onB.session!.token)).rejects.toThrow('token is wrong');
  // And no member vouches for it again.
  expect(() => b.core.group.admit(ticket.ticket, { name: 'pwa', version: '1' })).toThrow();
  phone.close();
  onB.close();
});

test('revoking a device on another member reaches its home machine', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  await join(a, b);
  const phone = await connect(a.url, '', { grant: a.core.sessions.grant().grant });
  const onB = await connect(b.url, '', { ticket: (await phone.call('group.ticket', { coreId: id(b) })).ticket });
  b.core.sessions.revoke(onB.session!.id);
  await waitFor(() => a.core.sessions.list(null).length === 0);
  await expect(connect(a.url, phone.session!.token)).rejects.toThrow('token is wrong');
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
  key.close();
  expect(a.core.sessions.list(null)).toHaveLength(1);

  expect(a.core.group.remove(id(b)).cores.map((core) => core.coreId).sort()).toEqual([id(a), id(c)].sort());
  expect(() => a.core.group.remove(id(b))).toThrow('not a machine of this group');
  expect(() => a.core.group.remove(id(a))).toThrow('group.leave');
  expect(a.core.sessions.list(null)).toEqual([]);
  await waitFor(() => b.core.group.view('owner') === null && members(c).length === 2);
  // What b signs is no longer listened to, and a ticket from it opens nothing.
  await expect(connect(a.url, key.session!.token)).rejects.toThrow('token is wrong');
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

test('a roster is only taken from a member, never from a machine linked by hand', async () => {
  const a = await machine();
  const linked = await machine();
  await a.core.group.create('Home');
  a.core.coordination.trust(linked.core.coordination.identity());
  const roster = a.core.journal.getSetting('group') as Roster;
  const forged = { ...roster, cores: [...roster.cores, { ...linked.core.coordination.card(), name: 'Intruder', addresses: [linked.url], rev: 50 }] };
  await expect(linked.core.coordination.request({ ...a.core.coordination.identity() }, 'group.sync', forged)).rejects.toThrow('only a machine of this group');
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
