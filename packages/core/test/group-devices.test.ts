import { afterEach, expect, test } from 'bun:test';
import { deviceAdmitInput, deviceHelloInput } from '@boite/contracts';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { connect, type CoreClient } from '../src/client.ts';
import { isAllowedOrigin } from '../src/server.ts';
import { FORWARDS_PER_MINUTE } from '../src/group/clients.ts';
import { mergeDeviceKeys } from '../src/group/device-keys.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const clients: CoreClient[] = [];
/**
 * Bun 1.4.2 on Windows crashes in its socket code when a socket is opened or
 * refused while another one of the same process is still closing (see
 * group.test.ts): each refusal and each close is let finish on the core before
 * the next socket.
 */
async function settled(h: TestCore, open: number): Promise<void> {
  await waitFor(() => h.server.connections() <= open);
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function refused(h: TestCore, hello: Promise<unknown>, message?: string): Promise<void> {
  const open = h.server.connections();
  if (message === undefined) await expect(hello).rejects.toThrow();
  else await expect(hello).rejects.toThrow(message);
  await settled(h, open);
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const core of cores) await settled(core, 0);
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

/** A phone's one key, as the app makes it. */
function phoneKey(): { publicKey: string; key: KeyObject; sign(input: string): string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x!;
  return { publicKey: raw, key: privateKey, sign: (input) => sign(null, Buffer.from(input), privateKey).toString('base64url') };
}

function helloFor(phone: ReturnType<typeof phoneKey>, deviceId: string, coreId: string, at = Date.now()): object {
  const nonce = randomBytes(16).toString('hex');
  return { id: deviceId, at, nonce, sig: phone.sign(deviceHelloInput(coreId, at, nonce)) };
}

async function open(url: string, options: Parameters<typeof connect>[2]): Promise<CoreClient> {
  const client = await connect(url, '', { client: { name: 'pwa', version: '1' }, ...options });
  clients.push(client);
  return client;
}

/** Two machines of one group, `b` joined with an invitation of `a`. */
async function pair(): Promise<[TestCore, TestCore]> {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  const { invite } = await a.core.group.invite();
  await b.core.group.join(invite);
  return [a, b];
}

test('a phone added on one member says hello on every member with one key, and one revocation shuts it out everywhere', async () => {
  const [a, b] = await pair();
  const phone = phoneKey();
  // "Add a device" on b: one link and one code.
  const added = await b.core.group.clients.addDevice();
  const grant = new URL(added.url).searchParams.get('grant')!;
  expect(added.url).toContain('#join=');
  const admitted = await open(b.url, { grant, device: { publicKey: phone.publicKey, name: 'Phone', sig: phone.sign(deviceAdmitInput(grant, phone.publicKey)) } });
  expect(admitted.principal).toBe('session');
  const deviceId = admitted.device!;
  expect(deviceId).toMatch(/^[0-9a-f]{64}$/);
  // The other member hears of it with the roster and lets it in on its signature, with no pairing of its own.
  await waitFor(() => a.core.group.view('owner')?.devices.some((device) => device.id === deviceId) === true);
  const onA = await open(a.url, { device: helloFor(phone, deviceId, id(a)) });
  expect(onA.principal).toBe('session');
  expect((await onA.call('group.get', {}))?.devices.map((device) => device.id)).toEqual([deviceId]);
  // A signature made for b opens nothing on a, and the same hello twice is refused.
  await refused(a, open(a.url, { device: helloFor(phone, deviceId, id(b)) }), 'not signed by its key for this machine');
  const once = helloFor(phone, deviceId, id(a));
  clients.push(await connect(a.url, '', { device: once }));
  await refused(a, connect(a.url, '', { device: once }), 'already used');
  await refused(a, open(a.url, { device: helloFor(phone, deviceId, id(a), Date.now() - 10 * 60_000) }), 'two minutes');
  // The owner revokes it on b: a closes its socket and refuses its next hello.
  b.core.group.clients.revokeDevice(deviceId);
  await waitFor(() => a.core.group.view('owner')?.devices.length === 0);
  await waitFor(() => a.core.journal.listSessions().length === 0);
  // The revocation closed the phone's sockets on both machines: let them finish before the next one opens.
  await settled(a, 0);
  await settled(b, 0);
  await refused(a, open(a.url, { device: helloFor(phone, deviceId, id(a)) }), 'removed from the group');
  await refused(b, open(b.url, { device: helloFor(phone, deviceId, id(b)) }), 'removed from the group');
  // A device a machine never heard of is told to come back, never that it was removed.
  const stranger = phoneKey();
  await refused(a, open(a.url, { device: helloFor(stranger, 'f'.repeat(64), id(a)) }), 'has not heard of this device yet');
});

test('a code drawn on one member is typed on another and still admits the phone', async () => {
  const [a, b] = await pair();
  const phone = phoneKey();
  const drawn = (await b.core.group.clients.addDevice()).code;
  // The installed app sends the code to the machine that serves its page: a, which never drew it.
  // Typed as people type it, lower case and spaced: b reads it as a would have.
  const code = drawn.toLowerCase().replace('-', ' ');
  const admitted = await open(a.url, { grant: code, device: { publicKey: phone.publicKey, sig: phone.sign(deviceAdmitInput(code, phone.publicKey)) } });
  expect(admitted.device).toMatch(/^[0-9a-f]{64}$/);
  expect(b.core.group.view('owner')?.devices.map((device) => device.by)).toEqual([id(b)]);
  // Spent: another phone with the same code is refused.
  const other = phoneKey();
  await refused(a, open(a.url, { grant: code, device: { publicKey: other.publicKey, sig: other.sign(deviceAdmitInput(code, other.publicKey)) } }), 'wrong, expired, or was already used');
});

test('a phone paired the older way hands over its key and keeps both until revoked, and removing a machine keeps the phones it added', async () => {
  const [a, b] = await pair();
  const legacy = await open(a.url, { grant: a.core.sessions.grant().grant });
  const phone = phoneKey();
  const at = Date.now();
  const enrolled = await legacy.call('group.enrollDevice', { publicKey: phone.publicKey, at, sig: phone.sign(deviceHelloInput(id(a), at, 'enroll')) });
  expect(enrolled.group.devices.map((device) => device.id)).toEqual([enrolled.id]);
  await waitFor(() => b.core.group.view('owner')?.devices.some((device) => device.id === enrolled.id) === true);
  clients.push(await connect(b.url, '', { device: helloFor(phone, enrolled.id, id(b)) }));
  // a goes: b keeps the phone a let in, under its own word now.
  b.core.group.remove(id(a));
  expect(b.core.group.view('owner')?.devices.find((device) => device.id === enrolled.id)?.by).toBe(id(b));
  clients.push(await connect(b.url, '', { device: helloFor(phone, enrolled.id, id(b)) }));
  // Revoked on b: the older pairing it took over is revoked with it.
  b.core.group.clients.revokeDevice(enrolled.id);
  await settled(b, 0);
  await refused(b, connect(b.url, '', { device: helloFor(phone, enrolled.id, id(b)) }), 'removed from the group');
});

test('a machine alone with its phones joins a group and brings them', async () => {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  const phone = phoneKey();
  // Adding a device to a machine in no group starts one of its own.
  const added = await b.core.group.clients.addDevice();
  expect(b.core.group.view('owner')?.cores.map((core) => core.coreId)).toEqual([id(b)]);
  const grant = new URL(added.url).searchParams.get('grant')!;
  const admitted = await open(b.url, { grant, device: { publicKey: phone.publicKey, sig: phone.sign(deviceAdmitInput(grant, phone.publicKey)) } });
  // b pastes a's link: the invitation after #join.
  const link = await a.core.group.clients.addDevice();
  await b.core.group.join(link.url);
  expect(b.core.group.view('owner')?.id).toBe(a.core.group.view('owner')?.id);
  await waitFor(() => a.core.group.view('owner')?.devices.some((device) => device.id === admitted.device) === true);
  clients.push(await connect(a.url, '', { device: helloFor(phone, admitted.device!, id(a)) }));
});

test('a member trusts the origins the others are served from, learned from their own pages', async () => {
  const [a, b] = await pair();
  // a is behind a proxy at an origin its addresses do not list, which its owner allowed there.
  const proxied = 'https://a-proxy.example';
  a.core.settings.set({ browserOrigins: [proxied, 'https://other.example'] });
  const port = Number(new URL(b.url).port);
  expect(isAllowedOrigin(proxied, port, '127.0.0.1') || b.core.group.allowsOrigin(proxied)).toBe(false);
  // A page of a, served there, opens its socket: the Host it asked for is the origin's. A phone's first page
  // holds no key yet, and its hello is refused: the origin is learned all the same, before any hello.
  await refused(a, connect(a.url, 'no key yet', { headers: { origin: proxied, host: 'a-proxy.example' } }));
  await waitFor(() => b.core.group.allowsOrigin(proxied));
  // An origin a trusts but that does not name the host asked for is not one it is served at.
  await refused(a, connect(a.url, 'no key yet', { headers: { origin: 'https://other.example', host: 'a-proxy.example' } }));
  expect(b.core.group.allowsOrigin('https://other.example')).toBe(false);
  // A socket from that page to b passes b's gate with no setting on b.
  const phone = phoneKey();
  const added = await b.core.group.clients.addDevice();
  const grant = new URL(added.url).searchParams.get('grant')!;
  const cross = await open(b.url, { headers: { origin: proxied }, grant, device: { publicKey: phone.publicKey, sig: phone.sign(deviceAdmitInput(grant, phone.publicKey)) } });
  expect(cross.device).toMatch(/^[0-9a-f]{64}$/);
  // An origin nobody of the group is served from stays out.
  await refused(b, connect(b.url, '', { headers: { origin: 'https://elsewhere.example' }, device: helloFor(phone, cross.device!, id(b)) }));
});

test('a device redeeming its code again after a lost answer is answered until the grant expires, and a malformed key keeps its own refusal', async () => {
  const a = await machine();
  await a.core.group.create('Home');
  const { code } = await a.core.group.clients.addDevice();
  const now = Date.now();
  expect(a.core.sessions.redeem(code, 'f'.repeat(64), null, now)).toBe('device');
  // Past the code's five minutes, inside the grant's ten: the same device asking again gets the same answer.
  expect(a.core.sessions.redeem(code, 'f'.repeat(64), null, now + 6 * 60_000)).toBe('device');
  expect(() => a.core.sessions.redeem(code, 'e'.repeat(64), null, now + 6 * 60_000)).toThrow('already used');
  // A key that is no key is invalid, said so with its field: never taken for a removal.
  const fresh = await a.core.group.clients.addDevice();
  const grant = new URL(fresh.url).searchParams.get('grant')!;
  const before = a.server.connections();
  const refusal = await connect(a.url, '', { grant, device: { publicKey: 'not-a-key', sig: 'x' } }).catch((error: { rpc?: { code: number; data?: { field?: string } } }) => error);
  await settled(a, before);
  expect((refusal as { rpc?: { code: number; data?: { field?: string } } }).rpc).toMatchObject({ code: -32602, data: { field: 'device.publicKey' } });
});

test('a key handed over on two members keeps both older pairings, a removed key spends no code through another member, and a device key gets no ticket', async () => {
  const merged = mergeDeviceKeys(
    [{ id: 'k', publicKey: 'p', name: 'Phone', role: 'device', admit: { by: 'a', sig: 's' }, at: 1, rev: 3, legacy: [`${'a'.repeat(64)}:ses_1`] }],
    [{ id: 'k', publicKey: 'p', name: 'Phone', role: 'device', admit: { by: 'b', sig: 's' }, at: 1, rev: 4, legacy: [`${'b'.repeat(64)}:ses_2`] }],
  );
  expect(merged[0]?.legacy).toEqual([`${'a'.repeat(64)}:ses_1`, `${'b'.repeat(64)}:ses_2`]);

  const [a, b] = await pair();
  const phone = phoneKey();
  const first = await b.core.group.clients.addDevice();
  const grant = new URL(first.url).searchParams.get('grant')!;
  const admitted = await open(b.url, { grant, device: { publicKey: phone.publicKey, sig: phone.sign(deviceAdmitInput(grant, phone.publicKey)) } });
  // A device key asks a ticket for nothing: it signs its own way into the other machine.
  await expect(admitted.call('group.ticket', { coreId: id(a) })).rejects.toThrow('needs no ticket');
  b.core.group.clients.revokeDevice(admitted.device!);
  await settled(b, 0);
  await waitFor(() => (a.core.group.view('owner')?.devices.length ?? 1) === 0);
  // The removed key types a code b drew on a: refused, and the code still admits the next key.
  const { code } = await b.core.group.clients.addDevice();
  await refused(a, open(a.url, { grant: code, device: { publicKey: phone.publicKey, sig: phone.sign(deviceAdmitInput(code, phone.publicKey)) } }));
  const next = phoneKey();
  const again = await open(a.url, { grant: code, device: { publicKey: next.publicKey, sig: next.sign(deviceAdmitInput(code, next.publicKey)) } });
  expect(again.device).toMatch(/^[0-9a-f]{64}$/);
  // An origin the roster could not read back is never written into it.
  a.core.group.servedFrom('null');
  a.core.group.servedFrom('ftp://a.example');
  expect(a.core.group.view('owner')).not.toBeNull();
  expect(a.core.group.allowsOrigin('null')).toBe(false);
});

test('wrong codes typed on one member drop none of the codes another member drew, and only a few a minute are passed on', async () => {
  const [a, b] = await pair();
  const { code } = await b.core.group.clients.addDevice();
  const guesser = phoneKey();
  // A minute's worth of wrong codes typed on a's page: a counts them, b, which only hears them passed on, does not.
  for (let i = 0; i < FORWARDS_PER_MINUTE; i++) {
    const wrong = `ZZZZ-ZZ${String(i).padStart(2, '0')}`;
    await refused(a, open(a.url, { grant: wrong, device: { publicKey: guesser.publicKey, sig: guesser.sign(deviceAdmitInput(wrong, guesser.publicKey)) } }));
  }
  // The next one is not passed on, good as it is: a refuses it alone, and b's code is not spent.
  const phone = phoneKey();
  const offer = { publicKey: phone.publicKey, sig: phone.sign(deviceAdmitInput(code, phone.publicKey)) };
  await refused(a, open(a.url, { grant: code, device: offer }), 'wrong, expired, or was already used');
  const admitted = await open(b.url, { grant: code, device: offer });
  expect(admitted.device).toMatch(/^[0-9a-f]{64}$/);
});
