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
 * both machines of that group. A second phone types a code another machine
 * drew, with the address of the machine it sends it to.
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

/** A phone at the app's address, the app's address known to its page before anything loads. */
async function phone(video?: string): Promise<BrowserPage> {
  const page = await BrowserPage.launch({
    url: 'about:blank',
    windowSize: { width: 390, height: 844 },
    args: ['--ignore-certificate-errors', '--host-resolver-rules=MAP app.test 127.0.0.1',
      ...(video === undefined ? [] : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`])],
  });
  pages.push(page);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
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

test('the app on an address no machine serves scans one machine\'s code and reaches the whole group; another types a code with the machine\'s address', async () => {
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
  const scanner = await phone(video);
  // No machine is the page's: the app opens on its way in, and nothing else.
  await scanner.waitFor(`document.querySelector('${id('mobile-connect')} ${id('machine-scan')}') && document.querySelector('${id('machine-code-open')}')`, 30_000);
  expect(await scanner.evaluate(`globalThis.__boiteTest.workspace.machines.every(machine => machine.store.endpointUrl === null)`)).toBe(true);
  await capture(scanner, 'app-unpaired.png');

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

  // Another phone types a code the first machine drew, and the address of the second, which passes it on.
  const { code } = await a.call('group.addDevice', {});
  const typist = await phone();
  await typist.waitFor(`document.querySelector('${id('machine-code-open')}')`, 30_000);
  await typist.click(id('machine-code-open'));
  await typist.waitFor(`document.querySelector('${id('machine-code-host')}')`);
  // Plain http on another host is mixed content on this HTTPS page: turned down before any socket, not failed as one.
  await typist.type(id('machine-code-host'), 'http://192.168.1.20:3773');
  await typist.type(id('machine-code'), code);
  await typist.click(id('machine-code-submit'));
  await typist.waitFor(`document.querySelector('${id('machine-code-form')} [role="alert"]')?.textContent.includes('HTTPS address')`);
  expect((await a.call('group.get', {}))?.devices).toHaveLength(1);
  await typist.type(id('machine-code-host'), second.url);
  await capture(typist, 'app-code-entry.png');
  await typist.click(id('machine-code-submit'));
  await typist.waitFor(`globalThis.__boiteTest.workspace.machines.length === 2 && globalThis.__boiteTest.workspace.machines.every(machine => machine.store.connection === 'ready')`, 45_000);
  expect((await a.call('group.get', {}))?.devices).toHaveLength(2);
}, 180_000);
