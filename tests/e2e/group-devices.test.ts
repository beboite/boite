import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { startCore, type RunningCore } from './lib/core.ts';
import { mobileAction } from './lib/mobile.ts';
import { codeVideo } from './lib/qr-video.ts';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';

/**
 * A phone is a device of the group, not of one machine.
 *
 * Two machines of one group, each behind an HTTPS reverse proxy of its own,
 * as two servers at home are: `a.test` serves the first, which knows that
 * address only as one it accepts; the second gives its proxy's address as its
 * public one. The phone app is installed from
 * the first machine's address. It is shown the code "Add a device" draws on
 * the second machine, scans it, and lists and opens the conversations of both
 * machines. Nobody tells either machine which page origins to accept: the
 * second learns the first one's from the group.
 *
 * Chromium resolves `a.test` to this computer (`--host-resolver-rules`), the
 * cores never dial it, a certificate made for the run covers both proxies, and
 * Chromium's fake camera plays the code.
 */

const id = (name: string) => `[data-testid="${name}"]`;
const scratch = mkdtempSync(join(tmpdir(), 'boite-e2e-devices-'));
const cores: RunningCore[] = [];
const clients: CoreClient[] = [];
const proxies: ReturnType<typeof Bun.serve>[] = [];
const pages: BrowserPage[] = [];
let ui: { close(): Promise<void> };
let uiUrl: string;
let tls: { key: string; cert: string };

interface Piped { path: string; origin: string | null; host: string; upstream?: WebSocket; queue: (string | Uint8Array<ArrayBuffer>)[] }

/**
 * An HTTPS reverse proxy in front of one core, as Caddy is: the page and its
 * assets come from the UI server of this run, the socket and the relay routes
 * go to the core with the browser's `Origin` and the `Host` it asked for.
 */
function proxy(core: RunningCore): ReturnType<typeof Bun.serve> {
  const server = Bun.serve<Piped>({
    hostname: '127.0.0.1',
    port: 0,
    tls,
    async fetch(request, self) {
      const target = new URL(request.url);
      if (target.pathname === '/rpc' || target.pathname.startsWith('/group/relay/')) {
        const data: Piped = { path: target.pathname, origin: request.headers.get('origin'), host: request.headers.get('host') ?? target.host, queue: [] };
        return self.upgrade(request, { data }) ? undefined : new Response('expected a websocket upgrade', { status: 400 });
      }
      // What the machines of the group say to each other, and what a page fetches from a core, goes to the core.
      const coreRoute = ['/file/', '/view/', '/group/'].some((prefix) => target.pathname.startsWith(prefix)) || ['/health', '/agent-messages'].includes(target.pathname);
      const headers = new Headers(request.headers);
      headers.delete('host');
      const answer = await fetch(`${coreRoute ? core.url : uiUrl}${target.pathname}${target.search}`, {
        method: request.method, headers, ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
      });
      // Bun's fetch hands the body back decompressed: what it said of its encoding and length no longer holds.
      const back = new Headers(answer.headers);
      back.delete('content-encoding');
      back.delete('content-length');
      return new Response(answer.body, { status: answer.status, headers: back });
    },
    websocket: {
      open(socket: ServerWebSocket<Piped>) {
        const headers: Record<string, string> = { host: socket.data.host, ...(socket.data.origin === null ? {} : { origin: socket.data.origin }) };
        const upstream = new WebSocket(`${core.url.replace(/^http/, 'ws')}${socket.data.path}`, { headers } as unknown as string[]);
        upstream.binaryType = 'arraybuffer';
        socket.data.upstream = upstream;
        upstream.onopen = () => {
          for (const frame of socket.data.queue.splice(0)) upstream.send(frame);
        };
        upstream.onmessage = (event) => socket.send(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer));
        upstream.onclose = (event) => socket.close(event.code >= 3000 || event.code === 1000 ? event.code : 1011, event.reason);
        upstream.onerror = () => socket.close(1011, 'the core dropped the connection');
      },
      message(socket: ServerWebSocket<Piped>, frame) {
        const upstream = socket.data.upstream;
        const copy = typeof frame === 'string' ? frame : new Uint8Array(frame);
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(copy);
        else socket.data.queue.push(copy);
      },
      close(socket: ServerWebSocket<Piped>) {
        socket.data.upstream?.close();
      },
    },
  });
  proxies.push(server);
  return server;
}

async function capture(page: BrowserPage, name: string): Promise<void> {
  await page.evaluate(
    `Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`
  );
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

async function owner(core: RunningCore): Promise<CoreClient> {
  const client = await connect(core.url, core.token);
  clients.push(client);
  return client;
}

async function echoThread(client: CoreClient, dataDir: string, project: string, title: string): Promise<string> {
  const added = await client.call('projects.add', { path: dataDir, name: project });
  const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo')!;
  return (await client.call('threads.create', { projectId: added.id, providerId: 'echo', accountId: account.id, title })).id;
}

beforeAll(async () => {
  const port = await freePort();
  ui = await startUi(port);
  uiUrl = `http://127.0.0.1:${port}`;
  const made = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=a.test',
    '-addext', 'subjectAltName=DNS:a.test,IP:127.0.0.1', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], { stdout: 'ignore', stderr: 'pipe' });
  if (made.exitCode !== 0) throw new Error(`openssl could not make a certificate: ${made.stderr.toString()}`);
  tls = { key: readFileSync(join(scratch, 'key.pem'), 'utf8'), cert: readFileSync(join(scratch, 'cert.pem'), 'utf8') };
}, 90_000);

afterAll(async () => {
  for (const page of pages) await page.close();
  for (const client of clients) client.close();
  for (const server of proxies) await server.stop(true);
  await ui?.close();
  for (const core of cores) await core.stop();
  rmSync(scratch, { recursive: true, force: true });
}, 20_000);

/** What the first test leaves for the second: the two machines, their owners, the phone and the owner's computer. */
let first: RunningCore, second: RunningCore;
let a: CoreClient, b: CoreClient;
let phone: BrowserPage, desk: BrowserPage;
let originA = '';
let deviceId = '';

test('a phone installed from one machine scans the code of another and lists and opens the conversations of both', async () => {
  // The first machine reaches the second at its proxy, whose certificate was made for this run.
  const trusting = { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } };
  first = await startCore(trusting);
  second = await startCore(trusting);
  cores.push(first, second);
  a = await owner(first);
  b = await owner(second);
  originA = `https://a.test:${proxy(first).port}`;
  const originB = `https://127.0.0.1:${proxy(second).port}`;
  // Each machine knows its own proxy, as a server deployed behind one does, and nothing of the other's.
  await a.call('settings.set', { browserOrigins: [originA] });
  await b.call('settings.set', { publicUrl: originB });
  await a.call('group.create', { name: 'Home' });
  const { invite } = await a.call('group.invite', {});
  await b.call('group.join', { invite });
  const threadA = await echoThread(a, first.dataDir, 'Server project', 'On the server');
  const threadB = await echoThread(b, second.dataDir, 'Box project', 'On the box');

  // "Add a device" on the second machine: the code its page draws.
  const added = await b.call('group.addDevice', {});
  expect(added.url.startsWith(`${originB}/?grant=`)).toBe(true);
  const video = join(scratch, 'code.y4m');
  writeFileSync(video, codeVideo(added.url.split('#')[0]!));

  phone = await BrowserPage.launch({
    url: `${originA}/`,
    windowSize: { width: 390, height: 844 },
    args: ['--ignore-certificate-errors', '--host-resolver-rules=MAP a.test 127.0.0.1',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
  pages.push(phone);
  // A phone: its width, and a finger for a pointer, so the app calls it one.
  await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await phone.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await phone.reload();

  // The app opens on a screen with one way in: scan the code, or paste the link behind a button. No machine to add by hand.
  await phone.waitFor(`document.querySelector('${id('mobile-connect')} ${id('machine-scan')}')`, 30_000);
  expect(await phone.evaluate(`!!document.querySelector('${id('machine-paste-open')}')`)).toBe(true);
  expect(await phone.evaluate(`!document.querySelector('${id('machine-add-open')}') && !document.querySelector('${id('machine-link')}')`)).toBe(true);
  await capture(phone, 'devices-phone-unpaired.png');

  await phone.click(id('machine-scan'));
  // One scan: the second machine lets the phone's key into the group, and the first machine, whose page this is, follows.
  const both = `globalThis.__boiteTest.workspace.machines.length === 2 && globalThis.__boiteTest.workspace.machines.every(machine => machine.store.connection === 'ready')`;
  await phone.waitFor(both, 45_000).catch(async (error) => {
    console.log('DEBUG A', first.output().split('\n').filter((line) => /origin|refused|group/.test(line)).join('\n'));
    console.log('DEBUG B', second.output().split('\n').filter((line) => /origin|refused|group/.test(line)).join('\n'));
    console.log('DEBUG roster', JSON.stringify(await b.call('group.get', {})));
    throw error;
  });
  expect(await phone.evaluate<string[]>(`globalThis.__boiteTest.workspace.machines.map(machine => machine.id).sort()`)).toEqual([originA, originB].sort());
  // Nobody was told an origin by hand: the second machine never heard of the first one's address but from the group.
  expect((await b.call('settings.get', {})).browserOrigins ?? []).toEqual([]);
  // One device in the group, on both machines, under one key.
  const groupA = await a.call('group.get', {}), groupB = await b.call('group.get', {});
  expect(groupA?.devices.map((device) => device.id)).toEqual(groupB?.devices.map((device) => device.id));
  expect(groupA?.devices).toHaveLength(1);
  deviceId = groupA!.devices[0]!.id;
  expect(groupA!.devices[0]!.name).toBe('phone');

  // Both cores run on this computer under its name: each gets a name of its own here, as an owner would give it.
  const names = (page: BrowserPage) => page.evaluate(`(() => { const w = globalThis.__boiteTest.workspace; for (const m of w.machines) w.customize(m.id, m.id.includes('a.test') ? 'Server' : 'Box'); })()`);
  await names(phone);
  // Both machines' conversations are on the phone, and each opens and answers.
  await mobileAction(phone, 'mobile-conversations');
  for (const thread of [threadA, threadB]) await phone.waitFor(`document.querySelector('${id(`mobile-thread-${thread}`)}')`, 20_000);
  await capture(phone, 'devices-phone-list.png');
  for (const [thread, words] of [[threadA, 'Hello server'], [threadB, 'Hello box']] as const) {
    await mobileAction(phone, 'mobile-conversations');
    await phone.click(id(`mobile-thread-${thread}`));
    await phone.waitFor(`globalThis.__boiteTest.workspace.active.openThread?.id === ${JSON.stringify(thread)}`);
    await phone.waitFor(`document.querySelector('${id('composer-input')}')`);
    await phone.type(id('composer-input'), words);
    await phone.click(id('composer-send'));
    await phone.waitFor(`document.querySelector('${id('chat')}')?.textContent.split(${JSON.stringify(words)}).length > 2`, 20_000);
  }
  expect(await phone.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);

  // Settings, Machines on the phone: the group, its two machines and this phone, in one list.
  await mobileAction(phone, 'mobile-settings');
  await phone.click(id('settings-tab-machines'));
  await phone.waitFor(`document.querySelectorAll('${id('machine-card')}').length === 2 && document.querySelector('${id('group-device')}')`);
  expect(await phone.evaluate(`document.body.textContent.includes('Phones and other devices')`)).toBe(false);
  await capture(phone, 'devices-phone-machines.png');

  // The owner, on a computer's browser at the first machine's address: machines and the phone in one group.
  await a.call('settings.set', { publicUrl: originA });
  desk = await BrowserPage.launch({
    url: `${originA}/?token=${encodeURIComponent(first.token)}`,
    windowSize: { width: 1440, height: 900 },
    args: ['--ignore-certificate-errors', '--host-resolver-rules=MAP a.test 127.0.0.1'],
  });
  pages.push(desk);
  await desk.waitFor(`globalThis.__boiteTest?.workspace.machines.length === 2 && globalThis.__boiteTest.workspace.machines.every(machine => machine.store.connection === 'ready')`, 45_000);
  await desk.evaluate(`(() => { const w = globalThis.__boiteTest.workspace; for (const m of w.machines) w.customize(m.id, m.store === w.primary ? 'Server' : 'Box'); })()`);
  await desk.evaluate(`globalThis.__boiteTest.workspace.active.showSettings('machines')`);
  await desk.waitFor(`document.querySelector('${id('group-card')} ${id('group-device')}') && document.querySelectorAll('${id('machine-card')}').length === 2`);
  expect(await desk.evaluate(`document.body.textContent.includes('Phones and other devices')`)).toBe(false);
  await desk.click(id('group-add-device'));
  await desk.waitFor(`document.querySelector('${id('add-device-qr')} svg') && document.querySelector('${id('add-device')}').textContent.includes('Scan with your phone')`);
  await desk.evaluate(`document.querySelector('${id('group-card')}').scrollIntoView({ block: 'start' })`);
  await capture(desk, 'devices-desktop-machines.png');
  await desk.click(id('add-device-close'));
}, 180_000);

test('a phone removed from the group on one machine is refused by every machine', async () => {
  // Removed from the group on the first machine: the second refuses it too, and the phone is back on its screen with one way in.
  await desk.click(`${id('group-device')}[data-device-id="${deviceId}"] ${id('group-device-remove')}`);
  await desk.waitFor(`document.querySelector('${id('confirm-ok')}')`);
  await desk.click(id('confirm-ok'));
  for (let attempt = 0; attempt < 100 && ((await b.call('group.get', {}))?.devices.length ?? 0) > 0; attempt++) await Bun.sleep(100);
  expect((await b.call('group.get', {}))?.devices).toEqual([]);
  expect((await b.call('sessions.list', {})).filter((session) => session.role === 'device')).toEqual([]);
  await phone.waitFor(`globalThis.__boiteTest.workspace.machines.every(machine => machine.store.connection !== 'ready')`, 30_000);
  await phone.reload();
  await phone.waitFor(`document.querySelector('${id('mobile-connect')} ${id('machine-scan')}')`, 30_000);
}, 180_000);
