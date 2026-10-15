import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { startCore, type RunningCore } from './lib/core.ts';
import { mobileAction } from './lib/mobile.ts';
import { codeVideo } from './lib/qr-video.ts';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';

/**
 * The phone app on its own address: a page no machine serves.
 *
 * The app is served over HTTPS at `app.test`, which no core answers on, and
 * every core is told it is the app's address (`BOITE_APP_ORIGIN`), as every
 * core knows the published one. Nothing else is set on any core. The app opens
 * on its way in alone, scans the code a machine of a group draws, and reaches
 * both machines of that group. A second phone pastes the link another machine
 * drew.
 *
 * The first phone sees the page as Chrome does in the field: the app's address
 * public, every machine's private, so its sockets need "Local network" allowed
 * (`--ip-address-space-overrides`; without it everything here is loopback and
 * nothing is checked).
 */

const id = (name: string) => `[data-testid="${name}"]`;
const scratch = mkdtempSync(join(tmpdir(), 'boite-e2e-app-'));
const cores: RunningCore[] = [];
const clients: CoreClient[] = [];
const pages: BrowserPage[] = [];
let ui: { close(): Promise<void> };
let app: ReturnType<typeof Bun.serve> | undefined;
let appUrl = '';

async function capture(page: BrowserPage, name: string): Promise<void> {
  await page.evaluate(
    `Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`
  );
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

/** A phone at the app's address, the app's address known to its page before anything loads. `machines`: the app public and those private, as in the field. */
async function phone(video?: string, machines: RunningCore[] = []): Promise<BrowserPage> {
  const spaces = machines.length === 0 ? [] : [`--ip-address-space-overrides=${[`127.0.0.1:${app!.port}=public`, ...machines.map((core) => `${new URL(core.url).host}=local`)].join(',')}`];
  const page = await BrowserPage.launch({
    url: 'about:blank',
    windowSize: { width: 390, height: 844 },
    args: ['--ignore-certificate-errors', '--host-resolver-rules=MAP app.test 127.0.0.1', ...spaces,
      ...(video === undefined ? [] : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`])],
  });
  pages.push(page);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // An Android phone's browser, as the app runs in: Troubleshoot names Nearby devices there only.
  await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36' });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__BOITE_APP_ORIGIN__ = ${JSON.stringify(appUrl)}` });
  await page.navigate(`${appUrl}/`);
  return page;
}

async function echoThread(client: CoreClient, dataDir: string, project: string, title: string): Promise<string> {
  const added = await client.call('projects.add', { path: dataDir, name: project });
  const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo')!;
  return (await client.call('threads.create', { projectId: added.id, providerId: 'echo', accountId: account.id, title })).id;
}

beforeAll(async () => {
  const port = await freePort();
  ui = await startUi(port);
  const made = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=app.test',
    '-addext', 'subjectAltName=DNS:app.test', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], { stdout: 'ignore', stderr: 'pipe' });
  if (made.exitCode !== 0) throw new Error(`openssl could not make a certificate: ${made.stderr.toString()}`);
  // The app's address serves the page and its files, and nothing of a core.
  app = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: readFileSync(join(scratch, 'key.pem'), 'utf8'), cert: readFileSync(join(scratch, 'cert.pem'), 'utf8') },
    async fetch(request) {
      const target = new URL(request.url);
      if (target.pathname === '/rpc') return new Response('no core here', { status: 404 });
      const answer = await fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, { method: request.method });
      const headers = new Headers(answer.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Response(answer.body, { status: answer.status, headers });
    },
  });
  appUrl = `https://app.test:${app.port}`;
}, 90_000);

afterAll(async () => {
  for (const page of pages) await page.close();
  for (const client of clients) client.close();
  await app?.stop(true);
  await ui?.close();
  for (const core of cores) await core.stop();
  rmSync(scratch, { recursive: true, force: true });
}, 20_000);

/** What the user answers when Chrome asks whether the app may reach the local network. */
async function localNetwork(page: BrowserPage, setting: 'granted' | 'denied'): Promise<void> {
  await page.send('Browser.setPermission', { origin: appUrl, permission: { name: 'local-network' }, setting });
}

test('the app on an address no machine serves scans one machine\'s code and reaches the whole group, once the local network is allowed; another pastes a link', async () => {
  const env = { env: { BOITE_APP_ORIGIN: appUrl } };
  const first = await startCore(env), second = await startCore(env);
  cores.push(first, second);
  const a = await connect(first.url, first.token), b = await connect(second.url, second.token);
  clients.push(a, b);
  await a.call('group.create', { name: 'Home' });
  const { invite } = await a.call('group.invite', {});
  await b.call('group.join', { invite });
  const threadA = await echoThread(a, first.dataDir, 'Server project', 'On the server');
  const threadB = await echoThread(b, second.dataDir, 'Box project', 'On the box');

  const added = await b.call('group.addDevice', {});
  const video = join(scratch, 'code.y4m');
  writeFileSync(video, codeVideo(added.url.split('#')[0]!));
  const scanner = await phone(video, [first, second]);
  // No machine is the page's: the app opens on its way in, and nothing else.
  await scanner.waitFor(`document.querySelector('${id('mobile-connect')} ${id('machine-scan')}') && document.querySelector('${id('machine-paste-open')}')`, 30_000);
  expect(await scanner.evaluate(`globalThis.__boiteTest.workspace.machines.every(machine => machine.store.endpointUrl === null)`)).toBe(true);
  // Chrome has not asked yet: the answer the scan will need is said first.
  await scanner.waitFor(`document.querySelector('${id('mobile-local-network-ask')}')`);
  await capture(scanner, 'app-unpaired.png');

  // The user allows it when Chrome asks (a headless Chrome cannot show the question).
  await localNetwork(scanner, 'granted');
  await scanner.waitFor(`!document.querySelector('${id('mobile-local-network-ask')}')`);
  await scanner.click(id('machine-scan'));
  // The machine it scanned becomes the one the app shows, and the group brings the other.
  await scanner.waitFor(`globalThis.__boiteTest.workspace.machines.length === 2 && globalThis.__boiteTest.workspace.machines.every(machine => machine.store.connection === 'ready')`, 45_000);
  expect(await scanner.evaluate<string | null>(`globalThis.__boiteTest.workspace.active.endpointUrl`)).toBe(second.url);
  // Neither machine was told the page's origin: the app's is one every core accepts.
  for (const client of [a, b]) expect((await client.call('settings.get', {})).browserOrigins ?? []).toEqual([]);
  await scanner.evaluate(`(() => { const w = globalThis.__boiteTest.workspace; for (const m of w.machines) w.customize(m.id, m.store === w.primary ? 'Box' : 'Server'); })()`);
  await mobileAction(scanner, 'mobile-conversations');
  for (const thread of [threadA, threadB]) await scanner.waitFor(`document.querySelector('${id(`mobile-thread-${thread}`)}')`, 20_000);
  await capture(scanner, 'app-machines-list.png');
  await scanner.click(id(`mobile-thread-${threadA}`));
  await scanner.waitFor(`document.querySelector('${id('composer-input')}')`);
  await scanner.type(id('composer-input'), 'Hello from the app');
  await scanner.click(id('composer-send'));
  await scanner.waitFor(`document.querySelector('${id('chat')}')?.textContent.split('Hello from the app').length > 2`, 20_000);
  // A reload opens on the machine it was added on, with nothing to scan again.
  await scanner.reload();
  await scanner.waitFor(`globalThis.__boiteTest?.workspace.machines.length === 2 && globalThis.__boiteTest.workspace.machines.every(machine => machine.store.connection === 'ready')`, 45_000);

  // Blocked in Chrome's site settings: every socket fails, and the screen says what to change rather than waiting for the computer.
  await localNetwork(scanner, 'denied');
  await scanner.reload();
  await scanner.waitFor(`document.querySelector('${id('mobile-local-network')}')`, 30_000);
  // Long enough for each machine's first attempts: Chrome refuses them, so none connects.
  await Bun.sleep(2_500);
  expect(await scanner.evaluate(`globalThis.__boiteTest.workspace.machines.some(machine => machine.store.connection === 'ready')`)).toBe(false);
  // The screen names the cause: no "socket error" over it.
  expect(await scanner.evaluate(`!document.querySelector('${id('error-toast')}')`)).toBe(true);
  await capture(scanner, 'app-local-network-blocked.png');
  // Troubleshoot lists every lock: the permission's live state, Nearby devices, and the machine's address to open.
  await scanner.click(id('connect-troubleshoot-toggle'));
  await scanner.waitFor(`document.querySelector('${id('check-local-network-state')}')?.textContent.trim() === 'Blocked' && document.querySelector('${id('check-nearby')}') && document.querySelector('${id('check-reach-open')}')?.href === ${JSON.stringify(`${second.url}/`)}`);
  await capture(scanner, 'app-troubleshoot.png');
  // Allowed again: both machines connect at once, with no tap and no wait for a retry.
  await localNetwork(scanner, 'granted');
  await scanner.waitFor(`globalThis.__boiteTest.workspace.machines.length === 2 && globalThis.__boiteTest.workspace.machines.every(machine => machine.store.connection === 'ready')`, 3_000);
  expect(await scanner.evaluate(`!document.querySelector('${id('mobile-connect')}')`)).toBe(true);

  // Another phone, its camera unable to read the code, pastes the link the first machine drew.
  const fromFirst = await a.call('group.addDevice', {});
  const paster = await phone();
  await paster.waitFor(`document.querySelector('${id('machine-paste-open')}')`, 30_000);
  await paster.click(id('machine-paste-open'));
  await paster.waitFor(`document.querySelector('${id('machine-link')}')`);
  // Plain http on another host is mixed content on this HTTPS page: turned down before any socket, not failed as one.
  await paster.type(id('machine-link'), 'http://192.168.1.20:3773/?grant=plain-http-test-grant');
  await paster.click(id('machine-add'));
  await paster.waitFor(`document.querySelector('${id('machine-paste-form')} [role="alert"]')?.textContent.includes('HTTPS address')`);
  expect((await a.call('group.get', {}))?.devices).toHaveLength(1);
  await paster.type(id('machine-link'), fromFirst.url);
  await capture(paster, 'app-link-entry.png');
  await paster.click(id('machine-add'));
  await paster.waitFor(`globalThis.__boiteTest.workspace.machines.length === 2 && globalThis.__boiteTest.workspace.machines.every(machine => machine.store.connection === 'ready')`, 45_000);
  expect((await a.call('group.get', {}))?.devices).toHaveLength(2);
}, 180_000);
