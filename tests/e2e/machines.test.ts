import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startCore, type RunningCore } from './lib/core.ts';
import { connect } from '../../packages/core/src/client.ts';

const requireUi = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(requireUi.resolve('vite'));
let server: { listen(): Promise<unknown>; close(): Promise<void> };
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
beforeAll(async () => {
  const port = await freePort();
  server = await createServer({
    root: join(import.meta.dir, '../../packages/ui'),
    server: { host: '127.0.0.1', port, strictPort: true },
    clearScreen: false
  });
  await server.listen();
  url = `http://127.0.0.1:${port}`;
  page = await BrowserPage.launch({ url: `${url}/?fake=1&machines=1` });
}, 30_000);
afterAll(async () => {
  await page?.close();
  await server?.close();
  for (const core of cores) await core.stop();
}, 15_000);

test('project and recent cards show both hosts, PRs and user-message ordering on desktop and phone', async () => {
  await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 8`);
  await page.waitFor(`document.querySelectorAll('${id('thread-pr')}').length === 2`);
  expect(await page.evaluate(`document.querySelector('[data-testid=machine-filter]') === null`)).toBe(true);
  await page.click(id('machine-status'));
  await page.waitFor(`document.querySelector('[data-testid=machine-status-menu]')`);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid=machine-status-menu] .status-dot[data-tone=success]').length`)).toBe(2);
  expect(await page.evaluate(`document.querySelector('[data-testid=machine-status-menu]').innerText.includes('Connected')`)).toBe(false);
  await capture('single-machine-menu.png');
  await page.click('[data-testid=machine-status-menu] [data-value="http://builder.test"]');
  await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 4`);
  await page.click(id('machine-status'));
  await page.click('[data-testid=machine-status-menu] [data-value=all]');
  await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 8`);
  await capture('projects-machines-desktop.png');
  await page.click(id('view-recent'));
  const rows = await page.evaluate<string[]>(
    `Array.from(document.querySelectorAll('${id('thread-row')}')).map(e => e.dataset.threadId)`
  );
  expect(rows.length).toBe(8);
  await page.evaluate(
    `(async () => { const { workspace } = await import('/src/lib/workspace.svelte.ts'); const remote = workspace.machines[1].store; await remote.rename('t-trace', 'Changed title, same user message'); })()`
  );
  expect(
    await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll('${id('thread-row')}')).map(e => e.dataset.threadId)`
    )
  ).toEqual(rows);
  await capture('recent-machines-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  });
  await page.evaluate(
    `(async () => { const { workspace } = await import('/src/lib/workspace.svelte.ts'); workspace.active.sidebarOpen = true; })()`
  );
  await capture('recent-machines-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await capture('recent-machines-phone-light.png');
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.click(id('nav-settings'));
  await page.click(id('settings-tab-machines'));
  await page.evaluate(`(() => { const input = document.querySelectorAll('[data-testid="machine-rename"]')[1]; input.value = 'Build server'; input.dispatchEvent(new Event('change', {bubbles: true})); })()`);
  await page.click('[data-testid="machine-card"]:nth-child(2) [data-testid="machine-icon-rack"]');
  await capture('machine-customization.png');
  await page.evaluate('location.reload()');
  await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 8`);
  expect(await page.evaluate(`!!document.querySelector('[data-testid="sidebar"] .machine[aria-label="Build server"]')`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid="nav-machines"]') === null`)).toBe(true);
  await page.click(id('nav-settings'));
  await page.click(id('settings-tab-machines'));
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="machine-rename"]')[1].value`)).toBe('Build server');
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="machine-icon-rack"]')[1].getAttribute('aria-pressed')`)).toBe('true');
}, 30_000);

test('two real cores pair, route turns independently, reconnect and survive a reload', async () => {
  const first = await startCore(),
    second = await startCore();
  cores.push(first, second);
  const a = await connect(first.url, first.token),
    b = await connect(second.url, second.token);
  try {
    await Promise.all([
      a.call('settings.set', { browserOrigins: [url] }),
      b.call('settings.set', { browserOrigins: [url] })
    ]);
    const create = async (client: typeof a, path: string, name: string) => {
      const project = await client.call('projects.add', { path, name });
      const account = (await client.call('accounts.list', {})).find((a) => a.providerId === 'echo')!;
      return client.call('threads.create', {
        projectId: project.id,
        providerId: 'echo',
        accountId: account.id,
        title: name
      });
    };
    const ta = await create(a, first.dataDir, 'Primary project');
    const tb = await create(b, second.dataDir, 'Remote project');
    await page.navigate(`${url}/?core=${encodeURIComponent(first.url)}&token=${encodeURIComponent(first.token)}`);
    await page.waitFor(`document.querySelector('[data-thread-id="${ta.id}"]')`);
    await page.click(id('nav-settings'));
    await page.click(id('settings-tab-machines'));
    const grant = await b.call('pairing.grant', { role: 'owner' });
    await page.type(id('machine-name'), 'Build host');
    await page.type(id('machine-link'), grant.url);
    await page.click(id('machine-add'));
    await page.waitFor(
      `document.querySelectorAll('${id('machine-card')}').length === 2 && !document.querySelector('${id('machine-add')}').textContent.includes('Connecting')`
    );
    await page.click(id('settings-back'));
    await page.waitFor(`document.querySelector('[data-thread-id="${tb.id}"]')`);
    await page.click(`[data-thread-id="${tb.id}"]`);
    await page.waitFor(`document.querySelector('${id('thread-title')}')?.textContent === 'Remote project'`);
    await page.type(id('composer-input'), 'Only on the remote host');
    await page.click(id('composer-send'));
    await page.waitFor(
      `document.querySelector('[data-thread-id="${tb.id}"]').dataset.status === 'idle' && document.querySelector('${id('chat')}').textContent.includes('Only on the remote host')`
    );
    expect((await a.call('threads.get', { threadId: ta.id })).messages).toHaveLength(0);
    expect((await b.call('threads.get', { threadId: tb.id })).messages.some((m) => m.role === 'user')).toBe(true);
    await capture('machines-real-cores.png');
    await second.stop({ keepDataDir: true });
    await page.click(`[data-thread-id="${ta.id}"]`);
    await page.waitFor(`document.querySelector('${id('thread-title')}')?.textContent === 'Primary project'`);
    const restarted = await startCore({ dataDir: second.dataDir, port: second.port });
    cores[1] = restarted;
    await page.evaluate(`location.reload()`);
    await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 2`);
    await page.click(`[data-thread-id="${tb.id}"]`);
    await page.waitFor(`document.querySelector('${id('chat')}')?.textContent.includes('Only on the remote host')`);
    await page.click(id('nav-settings'));
    await page.click(id('settings-tab-machines'));
    const admin = await connect(restarted.url, restarted.token);
    try {
      const session = (await admin.call('sessions.list', {}))[0]!;
      await admin.call('sessions.revoke', { sessionId: session.id });
      await page.waitFor(`document.querySelector('[data-testid="machine-card"][data-machine-id="${second.url}"] .status')?.textContent === 'Disconnected'`);
      const replacement = await admin.call('pairing.grant', { role: 'owner' });
      await page.type(id('machine-link'), replacement.url);
      await page.click(id('machine-add'));
      await page.waitFor(`document.querySelector('[data-testid="machine-card"][data-machine-id="${second.url}"] .status')?.textContent === 'Connected'`);
      expect(await page.evaluate(`document.querySelectorAll('${id('machine-card')}').length`)).toBe(2);
    } finally { admin.close(); }
    await page.click(id('machine-remove'));
    await page.waitFor(
      `document.querySelectorAll('${id('machine-card')}').length === 1 || document.querySelector('${id('thread-title')}')?.textContent === 'Primary project'`
    );
  } finally {
    a.close();
    b.close();
  }
}, 60_000);
