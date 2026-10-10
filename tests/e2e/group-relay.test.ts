import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupRelayUrl } from '../../packages/contracts/src/index.ts';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { startCore, type RunningCore } from './lib/core.ts';
import { mobileAction } from './lib/mobile.ts';
import { connect } from '../../packages/core/src/client.ts';

let server: { close(): Promise<void> };
let secure: ReturnType<typeof Bun.serve> | undefined;
let certificates: string | undefined;
let page: BrowserPage;
let url: string;
const cores: RunningCore[] = [];
const id = (name: string) => `[data-testid="${name}"]`;
async function capture(name: string) {
  await page.evaluate(
    `Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`
  );
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
/**
 * The page is served over HTTPS, as a phone's is: a secure page may send a key
 * to an HTTPS address, never to a plain-HTTP one, so a machine that gives only
 * a plain-HTTP address is out of its reach. A TLS proxy with a certificate made
 * for the run sits in front of the UI server; the cores stay on loopback, which
 * a secure page may still open sockets on.
 */
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  certificates = mkdtempSync(join(tmpdir(), 'boite-e2e-tls-'));
  const made = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-keyout', join(certificates, 'key.pem'), '-out', join(certificates, 'cert.pem')], { stdout: 'ignore', stderr: 'pipe' });
  if (made.exitCode !== 0) throw new Error(`openssl could not make a certificate: ${made.stderr.toString()}`);
  const ui = `http://127.0.0.1:${port}`;
  secure = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: readFileSync(join(certificates, 'key.pem'), 'utf8'), cert: readFileSync(join(certificates, 'cert.pem'), 'utf8') },
    fetch: async (request) => {
      const target = new URL(request.url);
      const answer = await fetch(`${ui}${target.pathname}${target.search}`, { method: request.method });
      // Bun's fetch hands the body back decompressed: what it said of its encoding and length no longer holds.
      const headers = new Headers(answer.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Response(answer.body, { status: answer.status, headers });
    },
  });
  url = `https://127.0.0.1:${secure.port}`;
  page = await BrowserPage.launch({ url: `${url}/?fake=1`, args: ['--ignore-certificate-errors'] });
}, 90_000);
afterAll(async () => {
  await page?.close();
  await secure?.stop(true);
  if (certificates !== undefined) rmSync(certificates, { recursive: true, force: true });
  await server?.close();
  for (const core of cores) await core.stop();
}, 15_000);

test('a phone that cannot reach a machine of its group reaches it through the machine it paired with, chats there, and says so', async () => {
  const home = await startCore(),
    desk = await startCore();
  cores.push(home, desk);
  const a = await connect(home.url, home.token);
  const b = await connect(desk.url, desk.token);
  try {
    // The page is served by the UI server of this test: both cores allow its origin.
    await Promise.all([a.call('settings.set', { browserOrigins: [url] }), b.call('settings.set', { browserOrigins: [url] })]);
    await a.call('group.create', { name: 'Home' });
    const { invite } = await a.call('group.invite', {});
    const joined = await b.call('group.join', { invite });
    const project = await b.call('projects.add', { path: desk.dataDir, name: 'Desk project' });
    const account = (await b.call('accounts.list', {})).find((entry) => entry.providerId === 'echo')!;
    const thread = await b.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'On the desk' });

    // The desk gives a plain-HTTP address only, as a desktop on a tailnet without certificates does:
    // the secure page sends it no key. The machine the phone pairs with still reaches it.
    expect(joined.cores.find((core) => core.coreId === joined.self)?.addresses.every((address) => address.startsWith('http://'))).toBe(true);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.evaluate('localStorage.clear()');
    const grant = await a.call('pairing.grant', { role: 'device' });
    await page.navigate(`${url}/?core=${encodeURIComponent(home.url)}&grant=${encodeURIComponent(grant.grant)}`);
    await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
    await page.click(id('confirm-ok'));

    const relay = groupRelayUrl(home.url, joined.self);
    const relayed = `globalThis.__boiteTest.workspace.machines.some(machine => machine.id === ${JSON.stringify(relay)} && machine.store.connection === 'ready')`;
    await page.waitFor(relayed, 30_000);
    // The desk handed the phone a device key, as it would on a direct connection.
    expect((await b.call('sessions.list', {})).filter((session) => session.role === 'device')).toHaveLength(1);

    // Its conversation is on the phone's list, and a prompt goes there and back through the machine it paired with.
    await mobileAction(page, 'mobile-conversations');
    const row = id(`mobile-thread-${thread.id}`);
    await page.waitFor(`document.querySelector('${row}')`);
    await capture('group-relay-phone-list.png');
    await page.click(row);
    await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread?.id === ${JSON.stringify(thread.id)}`);
    await page.waitFor(`document.querySelector('${id('composer-input')}')`);
    await page.type(id('composer-input'), 'Carried by the home machine');
    await page.click(id('composer-send'));
    await page.waitFor(`document.querySelector('${id('chat')}')?.textContent.includes('Carried by the home machine')`);
    // The prompt landed on the desk, and the echo agent's answer came back through the relay.
    const landed = async () => JSON.stringify((await b.call('threads.get', { threadId: thread.id })).messages);
    for (let attempt = 0; attempt < 100 && !(await landed()).includes('Carried by the home machine'); attempt++) await Bun.sleep(100);
    expect(await landed()).toContain('Carried by the home machine');
    await page.waitFor(`document.querySelectorAll('${id('chat')} [data-role="assistant"], ${id('chat')} .assistant').length > 0 || document.querySelector('${id('chat')}')?.textContent.split('Carried by the home machine').length > 2`, 20_000);
    await capture('group-relay-phone-chat.png');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);

    // Settings names the machine that carries it.
    await mobileAction(page, 'mobile-settings');
    await page.waitFor(`document.querySelector('${id('settings-tab-machines')}')`);
    await page.click(id('settings-tab-machines'));
    const member = `${id('machine-card')}[data-machine-id="${relay}"]`;
    await page.waitFor(`document.querySelector('${member} ${id('machine-card-status')}')?.textContent === 'Connected through ' + globalThis.__boiteTest.workspace.machines[0].label`);
    await page.evaluate(`document.querySelector('${member}').scrollIntoView({ block: 'center' })`);
    await capture('group-relay-phone-settings.png');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.waitFor(`document.querySelector('${member}')`);
    await page.evaluate(`document.querySelector('${member}').scrollIntoView({ block: 'center' })`);
    await capture('group-relay-desktop-settings.png');

    // Never dialled directly from the secure page: the only machines it holds are the one it paired with and the route through it.
    expect(await page.evaluate<string[]>(`globalThis.__boiteTest.workspace.machines.map(machine => machine.id).sort()`)).toEqual([home.url, relay].sort());
    // A reload reconnects through the same route with the key it kept: no new ticket, no second device key.
    await page.evaluate('location.reload()');
    await page.waitFor(relayed, 30_000);
    expect((await b.call('sessions.list', {})).filter((session) => session.role === 'device')).toHaveLength(1);
    await page.send('Emulation.clearDeviceMetricsOverride', {});
  } finally {
    a.close();
    b.close();
  }
}, 90_000);
