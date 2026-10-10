import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupRelayUrl, RpcErrorCode, type PushPayload, type RpcEvents } from '@boite/contracts';
import { createECDH, randomBytes } from 'node:crypto';
import { connect } from '../src/client.ts';
import { parseRelayPath } from '../src/group/relay.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

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

/** What a refused hello said: its RPC code and message. */
async function refusal(attempt: Promise<unknown>): Promise<{ code: number | undefined; message: string }> {
  try {
    await attempt;
  } catch (error) {
    return { code: (error as { rpc?: { code?: number } }).rpc?.code, message: (error as Error).message };
  }
  throw new Error('expected the hello to be refused');
}

/** Two members, and a phone paired by hand with the first. */
async function home(): Promise<{ a: TestCore; b: TestCore; phone: Awaited<ReturnType<typeof connect>> }> {
  const a = await machine();
  const b = await machine();
  await a.core.group.create('Home');
  const { invite } = await a.core.group.invite();
  await b.core.group.join(invite);
  const grant = a.core.sessions.grant();
  const phone = await connect(a.url, '', { grant: grant.grant, client: { name: 'pwa', version: '1' } });
  return { a, b, phone };
}

test('a relay route names a machine by its id and carries the socket, files and views only', () => {
  const coreId = 'c'.repeat(64);
  expect(parseRelayPath(`/group/relay/${coreId}/rpc`)).toEqual({ coreId, rest: '/rpc' });
  expect(parseRelayPath(`/group/relay/${coreId}/file/abc`)).toEqual({ coreId, rest: '/file/abc' });
  expect(parseRelayPath('/group/relay/short/rpc')).toBeNull();
  expect(parseRelayPath('/rpc')).toBeNull();
  expect(groupRelayUrl('https://m2.example/', coreId)).toBe(`https://m2.example/group/relay/${coreId}`);
});

test('a phone paired with one member reaches another through it, and keeps the key it got there', async () => {
  const { a, b, phone } = await home();
  const relay = groupRelayUrl(a.url, id(b));
  const { ticket } = await phone.call('group.ticket', { coreId: id(b) });

  const onB = await connect(relay, '', { ticket, relay: phone.session!.token, client: { name: 'pwa', version: '1' } });
  expect(onB.principal).toBe('session');
  // It is b that answers, under b's own rules for a device.
  expect((await onB.call('group.get', {}))?.self).toBe(id(b));
  await expect(onB.call('projects.add', { path: b.dataDir, name: 'relay' })).rejects.toThrow('owner only');
  const key = onB.session!.token;
  onB.close();
  await waitFor(() => a.core.relays.size === 0);

  // Next time, the key b handed back opens b through a again, with no ticket.
  const again = await connect(relay, key, { relay: phone.session!.token, client: { name: 'pwa', version: '1' } });
  expect((await again.call('group.get', {}))?.self).toBe(id(b));
  again.close();
  phone.close();
});

test('a relay carries only a client of its own machine, and says so without touching its key on the other one', async () => {
  const { a, b, phone } = await home();
  const relay = groupRelayUrl(a.url, id(b));
  const { ticket } = await phone.call('group.ticket', { coreId: id(b) });
  const onB = await connect(relay, '', { ticket, relay: phone.session!.token, client: { name: 'pwa', version: '1' } });
  const key = onB.session!.token;
  onB.close();

  // No key for a, or a wrong one: refused by a, as Refused, never as Unauthorized, which would read as b revoking the phone.
  for (const relayKey of [undefined, 'wrong']) {
    const failure = await refusal(connect(relay, key, { ...(relayKey === undefined ? {} : { relay: relayKey }), client: { name: 'pwa', version: '1' } }));
    expect(failure.code).toBe(RpcErrorCode.Refused);
    expect(failure.message).toContain('carries to the other machines of its group only a client paired with it');
  }
  // An agent's token is no key for the relay either.
  expect((await refusal(connect(relay, key, { relay: a.core.agents.tokenFor('thr_none' as never), client: { name: 'pwa', version: '1' } }))).code).toBe(RpcErrorCode.Refused);
  // b still takes the key directly: nothing above reached it.
  const direct = await connect(b.url, key, { client: { name: 'pwa', version: '1' } });
  expect(direct.principal).toBe('session');
  direct.close();

  // Revoked on its home machine, the phone is carried no more, and b dropped the key it gave.
  a.core.sessions.revoke(phone.session!.id);
  await waitFor(() => b.core.sessions.list(null).length === 0);
  expect((await refusal(connect(relay, key, { relay: phone.session!.token, client: { name: 'pwa', version: '1' } }))).code).toBe(RpcErrorCode.Refused);
  phone.close();
});

test('a relay leads only to another live member, and reports one that does not answer as unavailable', async () => {
  const { a, b, phone } = await home();
  // A machine outside the group, or the relay itself: nothing there.
  for (const target of ['f'.repeat(64), id(a)]) {
    const response = await fetch(`${groupRelayUrl(a.url, target)}/file/x`);
    expect(response.status).toBe(404);
  }
  // Only the socket, files and views are carried, nothing else of the other member.
  expect((await fetch(`${groupRelayUrl(a.url, id(b))}/health`)).status).toBe(404);
  expect((await fetch(`${groupRelayUrl(a.url, id(b))}/file/x`, { method: 'POST' })).status).toBe(405);

  const { ticket } = await phone.call('group.ticket', { coreId: id(b) });
  await b.core.group.close();
  await b.stop();
  cores.splice(cores.indexOf(b), 1);
  const failure = await refusal(connect(groupRelayUrl(a.url, id(b)), '', { ticket, relay: phone.session!.token, client: { name: 'pwa', version: '1' }, timeoutMs: 15_000 }));
  expect(failure.code).toBe(RpcErrorCode.Unavailable);
  phone.close();
});

test('a file and a view of the other member come through the relay with their headers and ranges', async () => {
  const { a, b, phone } = await home();
  // Under the core's data directory, which its stop removes.
  const dir = b.dataDir;
  const path = join(dir, 'note.txt');
  writeFileSync(path, 'carried across the group');
  const ticket = b.core.fileTickets.mint(path, 'text/plain');
  const base = groupRelayUrl(a.url, id(b));

  const whole = await fetch(`${base}/file/${ticket}`);
  expect(whole.status).toBe(200);
  expect(whole.headers.get('content-type')).toContain('text/plain');
  expect(await whole.text()).toBe('carried across the group');
  const part = await fetch(`${base}/file/${ticket}`, { headers: { range: 'bytes=0-6' } });
  expect(part.status).toBe(206);
  expect(await part.text()).toBe('carried');

  const page = join(dir, 'view.html');
  writeFileSync(page, '<p>view</p>');
  const view = await fetch(`${base}/view/${b.core.fileTickets.mint(page, 'text/html', Date.now(), undefined, undefined, true)}`);
  expect(view.status).toBe(200);
  expect(view.headers.get('content-security-policy')).toContain('sandbox');
  // An unknown ticket is b's 404, carried as it is.
  expect((await fetch(`${base}/file/unknown`)).status).toBe(404);
  phone.close();
});

test('a socket carried to a machine that leaves the group is closed', async () => {
  const { a, b, phone } = await home();
  const { ticket } = await phone.call('group.ticket', { coreId: id(b) });
  const onB = await connect(groupRelayUrl(a.url, id(b)), '', { ticket, relay: phone.session!.token, client: { name: 'pwa', version: '1' } });
  expect(a.core.relays.size).toBe(1);
  a.core.group.remove(id(b));
  a.core.relays.sweep();
  await waitFor(() => a.core.relays.size === 0);
  await expect(onB.call('group.get', {})).rejects.toThrow();
  phone.close();
});

function subscription() {
  const ecdh = createECDH('prime256v1');
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`, keys: {
    p256dh: ecdh.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url'),
  } };
}

test('a notification of another member reaches a phone through the machine it installed, marked with where the thread is', async () => {
  const { a, b, phone } = await home();
  // The phone's push subscription is on a, the machine whose page it installed.
  await phone.call('push.subscribe', subscription());
  const onA: PushPayload[] = [];
  a.core.push.send = async (_target, payload) => { onA.push(JSON.parse(payload) as PushPayload); };
  const onB: unknown[] = [];
  b.core.push.send = async (_target, payload) => { onB.push(JSON.parse(payload)); };

  const owner = await b.connect();
  const { threadId } = await echoThread(b, owner, 'on b');
  // Not yet a device of b: b has nobody to tell.
  b.core.bus.emit('question.asked', { id: 'before', threadId, text: 'Which branch?' } as RpcEvents['question.asked']);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(onA).toEqual([]);

  const { ticket } = await phone.call('group.ticket', { coreId: id(b) });
  const onBSocket = await connect(groupRelayUrl(a.url, id(b)), '', { ticket, relay: phone.session!.token, client: { name: 'pwa', version: '1' } });
  // A subscription of its own on b would send b's news without the machine its thread is on.
  await expect(onBSocket.call('push.subscribe', subscription())).rejects.toThrow('come through');
  onBSocket.close();
  await waitFor(() => a.core.relays.size === 0);
  b.core.bus.emit('question.asked', { id: 'after', threadId, text: 'Which branch?' } as RpcEvents['question.asked']);
  await waitFor(() => onA.length === 1);
  expect(onA[0]).toMatchObject({ title: 'on b', body: 'Which branch?', threadId, core: id(b), tag: `${id(b).slice(0, 16)}:request-after` });
  // b has no subscription of its own for the phone: nothing went out from there.
  expect(onB).toEqual([]);
  // A title longer than what a's reads is cut on the way, not dropped there.
  const { threadId: longId } = await echoThread(b, owner, 'T'.repeat(400));
  b.core.bus.emit('question.asked', { id: 'long', threadId: longId, text: 'Which branch?' } as RpcEvents['question.asked']);
  await waitFor(() => onA.length === 2);
  expect(onA[1]?.title).toBe('T'.repeat(300));
  // The same forward asked on two addresses that both lead to a: one notification.
  const fromB = a.core.group.peers().find((peer) => peer.coreId === id(b))!;
  const twice = { id: 'twice', device: `${id(a)}:${phone.session!.id}`, push: { title: 't', body: 'b', threadId: null, tag: 'twice' } };
  expect(a.core.push.relayed(fromB, twice)).toEqual({ delivered: true });
  expect(a.core.push.relayed(fromB, twice)).toEqual({ delivered: true });
  await waitFor(() => onA.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(onA).toHaveLength(3);

  // A member cannot use a's push for anything but a device of a's.
  await expect(b.core.coordination.request(b.core.group.peers()[0]!, 'group.push', { id: 'x', device: `${id(b)}:ses_x`, push: { title: 't', body: 'b', threadId: null, tag: 'x' } }))
    .rejects.toThrow('not a device of this machine');
  await expect(b.core.coordination.request(b.core.group.peers()[0]!, 'group.push', { id: 'y', device: `${id(a)}:${phone.session!.id}`, push: { title: 't', body: 1, threadId: null, tag: 'x' } }))
    .rejects.toThrow('push.body');

  // Revoked on a: b drops its key and forwards nothing more.
  a.core.sessions.revoke(phone.session!.id);
  await waitFor(() => b.core.sessions.list(null).length === 0);
  b.core.bus.emit('question.asked', { id: 'revoked', threadId, text: 'Which branch?' } as RpcEvents['question.asked']);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(onA).toHaveLength(3);
  owner.close();
  phone.close();
});

test('a relayed socket is held to the bounds of one waiting for its hello, and goes with the key it came in with', async () => {
  const { a, b, phone } = await home();
  const relay = groupRelayUrl(a.url, id(b));
  const socketUrl = `${relay.replace(/^http/, 'ws')}/rpc`;
  const opened = (headers?: Record<string, string>) => new Promise<WebSocket>((resolve, reject) => {
    const socket = headers === undefined ? new WebSocket(socketUrl) : new WebSocket(socketUrl, { headers } as unknown as string[]);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error('refused'));
  });
  const closed = (socket: WebSocket) => new Promise<string>((resolve) => { socket.onclose = (event) => resolve(`${event.code} ${event.reason}`); });

  // No first frame larger than a hello is read: refused before it is parsed.
  const large = await opened();
  const ended = closed(large);
  large.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { pad: 'x'.repeat(70 * 1024) } }));
  expect(await ended).toBe('4001 hello frame too large');

  // Sockets that say nothing count against the places for sockets waiting for their hello, as direct ones do.
  // A Host that is not loopback makes them a remote peer's, as behind a reverse proxy.
  const waiting: WebSocket[] = [];
  let refusedAt = -1;
  for (let index = 0; index < 40 && refusedAt < 0; index++) {
    try { waiting.push(await opened({ host: 'phone.example' })); } catch { refusedAt = index; }
  }
  expect(refusedAt).toBe(32);
  for (const socket of waiting) socket.close();
  await waitFor(() => a.core.relays.size === 0);

  // Revoked on the machine that carries it: the carried socket closes at once.
  const { ticket } = await phone.call('group.ticket', { coreId: id(b) });
  const onB = await connect(relay, '', { ticket, relay: phone.session!.token, client: { name: 'pwa', version: '1' } });
  expect(a.core.relays.size).toBe(1);
  a.core.sessions.revoke(phone.session!.id);
  await waitFor(() => a.core.relays.size === 0);
  await expect(onB.call('group.get', {})).rejects.toThrow();
  phone.close();
});
