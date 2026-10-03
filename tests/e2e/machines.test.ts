import { mobileAction } from './lib/mobile.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { basename, join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { startCore, type RunningCore } from './lib/core.ts';
import { connect } from '../../packages/core/src/client.ts';

let server: { close(): Promise<void> };
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
  server = await startUi(port);
  url = `http://127.0.0.1:${port}`;
  page = await BrowserPage.launch({ url: `${url}/?fake=1&open=recent&machines=1` });
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
  const remoteThread = '[data-testid="thread-row"][data-thread-id="t-trace"][data-machine-id="http://builder.test"]';
  await page.evaluate(`document.querySelector(${JSON.stringify(remoteThread)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await page.type(id('thread-rename'), 'Changed title, same user message');
  await page.evaluate(`document.querySelector('${id('thread-rename')}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await page.waitFor(`document.querySelector(${JSON.stringify(remoteThread)})?.title === 'Changed title, same user message'`);
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
  await mobileAction(page, 'mobile-conversations');
  await page.waitFor(`document.querySelectorAll('[data-testid="mobile-list"] .thread').length === 8`);
  await capture('recent-machines-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await capture('recent-machines-phone-light.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.click(id('nav-settings'));
  await page.click(id('settings-tab-machines'));
  await page.evaluate(`(() => { const input = document.querySelectorAll('[data-testid="machine-rename"]')[1]; input.value = 'Build server'; input.dispatchEvent(new Event('change', {bubbles: true})); })()`);
  await page.click('[data-testid="machine-card"]:nth-child(2) [data-testid="machine-customize"]');
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
    // A link to a core this page never met is asked about before anything connects.
    await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
    await capture('link-confirm.png');
    await page.click(id('confirm-ok'));
    await page.waitFor(`document.querySelector('[data-thread-id="${ta.id}"]')`);
    await page.click(`[data-thread-id="${ta.id}"]`);
    await page.waitFor(`document.querySelector('${id('thread-title')}')?.textContent === 'Primary project'`);
    await page.click(id('nav-settings'));
    await page.click(id('settings-tab-machines'));
    const grant = await b.call('pairing.grant', { role: 'owner' });
    await page.click(id('machine-add-open'));
    await page.type(id('machine-link'), grant.url);
    await page.click(id('machine-add'));
    await page.waitFor(
      `document.querySelectorAll('${id('machine-card')}').length === 2 && !document.querySelector('${id('machine-add')}').textContent.includes('Connecting')`
    );
    await b.call('settings.set', { warmProcessMinutes: 2, agentCpuCapPercent: 35 });
    await a.call('settings.set', { asyncQuestions: false, warmProcessMinutes: 7, agentCpuCapPercent: 85 });
    await page.click(id('machine-sync'));
    await page.waitFor(`globalThis.__boiteTest.workspace.machines.find(machine => machine.id === ${JSON.stringify(second.url)})?.store.settings?.asyncQuestions === false`);
    expect(await b.call('settings.get', {})).toMatchObject({ asyncQuestions: false, warmProcessMinutes: 2, agentCpuCapPercent: 35 });
    expect(await page.evaluate(`!!document.querySelector('${id('machines-page')}') && !document.querySelector('${id('machine-settings')}')`)).toBe(true);
    await page.click(`[data-machine-id="${second.url}"] ${id('machine-settings-open')}`);
    await page.waitFor(`document.querySelector('${id('machine-settings')}')?.dataset.machineId === ${JSON.stringify(second.url)}`);
    await page.type(`${id('machine-settings')} input[type=number]`, '45');
    await page.evaluate(`document.querySelector('${id('machine-settings')} input[type=number]').closest('form').requestSubmit()`);
    await page.waitFor(`globalThis.__boiteTest.workspace.machines.find(machine => machine.id === ${JSON.stringify(second.url)})?.store.settings?.agentCpuCapPercent === 45`);
    expect((await b.call('settings.get', {})).agentCpuCapPercent).toBe(45);
    expect((await a.call('settings.get', {})).agentCpuCapPercent).toBe(85);
    expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.openThread?.id === ${JSON.stringify(ta.id)}`)).toBe(true);
    await page.click(id('machine-settings-back'));
    await page.click(id('settings-back'));
    await page.waitFor(`document.querySelector('[data-thread-id="${tb.id}"]')`);
    await page.click(`[data-thread-id="${tb.id}"]`);
    await page.waitFor(`document.querySelector('${id('thread-title')}')?.textContent === 'Remote project'`);
    await page.click(id('terminal-toggle'));
    // PowerShell expands Windows short paths such as RUNNER~1 in its prompt.
    await page.waitFor(`document.querySelector('[data-testid=terminal-drawer] .xterm-rows')?.textContent.includes(${JSON.stringify(basename(second.dataDir))})`);
    await page.evaluate(`document.querySelector('${id('composer-input')}').focus()`);
    const terminalPoint = await page.evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('[data-testid=terminal-drawer] .xterm-screen').getBoundingClientRect();
      return { x: rect.left + 40, y: rect.top + 10 };
    })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...terminalPoint });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...terminalPoint });
    await page.waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`);
    // Reloading summaries for the same conversation must preserve terminal focus.
    await page.evaluate('globalThis.__boiteTest.workspace.active.reload()');
    expect(await page.evaluate(`document.activeElement?.classList.contains('xterm-helper-textarea')`)).toBe(true);
    // Ordinary keyboard events exercise xterm's key handler, unlike insertText.
    for (const char of 'echo remote-terminal-e2e') {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
    }
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.waitFor(`document.querySelector('[data-testid=terminal-drawer] .xterm-rows')?.textContent.split('remote-terminal-e2e').length >= 3`);
    await capture('terminal-remote-real-desktop.png');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await capture('terminal-remote-real-phone.png');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.send('Emulation.clearDeviceMetricsOverride', {});
    await page.click(id('terminal-close'));
    await page.waitFor(`!document.querySelector('${id('terminal-drawer')}')`);
    await a.call('settings.set', { asyncQuestions: true });
    await page.waitFor(`globalThis.__boiteTest.workspace.active.settings?.asyncQuestions === true`);
    expect((await b.call('settings.get', {})).asyncQuestions).toBe(true);
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
    await a.call('settings.set', { asyncQuestions: false });
    const restarted = await startCore({ dataDir: second.dataDir, port: second.port });
    cores[1] = restarted;
    await page.evaluate(`location.reload()`);
    await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 2`);
    await page.click(`[data-thread-id="${tb.id}"]`);
    await page.waitFor(`document.querySelector('${id('chat')}')?.textContent.includes('Only on the remote host')`);
    await page.waitFor(`globalThis.__boiteTest.workspace.active.settings?.asyncQuestions === false`);
    expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.settings.agentCpuCapPercent === 45 && globalThis.__boiteTest.workspace.active.settings.warmProcessMinutes === 2`)).toBe(true);
    await page.click(id('nav-settings'));
    await page.click(id('settings-tab-machines'));
    const admin = await connect(restarted.url, restarted.token);
    try {
      const session = (await admin.call('sessions.list', {}))[0]!;
      await admin.call('sessions.revoke', { sessionId: session.id });
      await page.waitFor(`document.querySelector('[data-testid="machine-card"][data-machine-id="${second.url}"] .status')?.textContent === 'Pair this app'`);
      expect(await page.evaluate(`!!document.querySelector('[data-testid="machine-card"][data-machine-id="${second.url}"] [data-testid=machine-repair]')`)).toBe(true);
      const replacement = await admin.call('pairing.grant', { role: 'owner' });
      await page.click(id('machine-add-open'));
      await page.type(id('machine-link'), replacement.url);
      await page.click(id('machine-add'));
      await page.waitFor(`document.querySelector('[data-testid="machine-card"][data-machine-id="${second.url}"] .status')?.textContent === 'Connected'`);
      expect(await page.evaluate(`document.querySelectorAll('${id('machine-card')}').length`)).toBe(2);
    } finally { admin.close(); }
    await page.click(id('machine-remove'));
    // Forgetting a machine asks first, in the app's own dialog.
    await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
    await page.click(id('confirm-ok'));
    // Back on the first machine: its thread, or the draft it opened on after the reload.
    await page.waitFor(
      `document.querySelectorAll('${id('machine-card')}').length === 1 || document.querySelector('${id('thread-title')}')?.textContent === 'Primary project' || document.querySelector('${id('draft-sentence')}')?.textContent.includes('Primary project')`
    );
  } finally {
    a.close();
    b.close();
  }
}, 60_000);

test('one invitation groups two real cores: the page connects the second by itself, and a paired phone reaches both', async () => {
  const first = await startCore(),
    second = await startCore();
  cores.push(first, second);
  const a = await connect(first.url, first.token),
    b = await connect(second.url, second.token);
  try {
    // The page is served by the UI server of this test, not by a core: both cores allow its origin.
    await Promise.all([
      a.call('settings.set', { browserOrigins: [url] }),
      b.call('settings.set', { browserOrigins: [url] })
    ]);
    const create = async (client: typeof a, path: string, name: string) => {
      const project = await client.call('projects.add', { path, name });
      const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo')!;
      return client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: name });
    };
    const ta = await create(a, first.dataDir, 'Desk project');
    const tb = await create(b, second.dataDir, 'Server project');
    const machines = (count: number) => `globalThis.__boiteTest.workspace.machines.filter(machine => machine.store.connection === 'ready').length === ${count}`;
    // The card sits under the updates of each machine: a capture is of the card, not of the top of the page.
    const showGroup = () => page.evaluate(`document.querySelector('${id('group-card')}').scrollIntoView({ block: 'start' })`);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('localStorage.clear()');
    await page.navigate(`${url}/?core=${encodeURIComponent(first.url)}&token=${encodeURIComponent(first.token)}`);
    await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
    await page.click(id('confirm-ok'));
    await page.waitFor(`document.querySelector('[data-thread-id="${ta.id}"]')`);
    await page.click(id('nav-settings'));
    await page.click(id('settings-tab-machines'));

    // One machine starts the group and mints an invitation.
    await page.type(id('group-name'), 'Home');
    await page.click(id('group-create'));
    await page.waitFor(`document.querySelectorAll('${id('group-member')}').length === 1`);
    expect((await a.call('group.get', {}))?.name).toBe('Home');
    await page.click(id('group-invite'));
    await page.waitFor(`document.querySelector('${id('group-invite-code')}')?.value.startsWith('boite-group:')`);
    const invite = await page.evaluate<string>(`document.querySelector('${id('group-invite-code')}').value`);
    await showGroup();
    await capture('group-invite-desktop.png');

    // The other machine joins with it, as its own settings or `boite-core group join` would.
    const joined = await b.call('group.join', { invite });
    expect(joined.cores).toHaveLength(2);
    // No pairing link for the second machine: the page was handed a key by it through the group.
    await page.waitFor(machines(2));
    await page.waitFor(`document.querySelectorAll('${id('group-member')}').length === 2 && document.querySelectorAll('${id('machine-card')}').length === 2`);
    const sessions = await b.call('sessions.list', {});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ role: 'owner', group: true });
    await showGroup();
    await capture('group-real-cores-desktop.png');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.waitFor(`document.querySelector('${id('group-card')}')`);
    await showGroup();
    await capture('group-real-cores-phone.png');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // The key is remembered: a reload reconnects both without another ticket.
    await page.evaluate('location.reload()');
    await page.waitFor(machines(2));
    await page.waitFor(`document.querySelector('[data-thread-id="${tb.id}"]')`);
    expect(await b.call('sessions.list', {})).toHaveLength(1);

    // A phone pairs with the first machine only, as a device, on a browser that knows neither.
    await page.evaluate('localStorage.clear()');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const grant = await a.call('pairing.grant', { role: 'device' });
    await page.navigate(`${url}/?core=${encodeURIComponent(first.url)}&grant=${encodeURIComponent(grant.grant)}`);
    await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
    await page.click(id('confirm-ok'));
    await page.waitFor(machines(2));
    expect(await page.evaluate<string[]>(`globalThis.__boiteTest.workspace.machines.map(machine => machine.store.principal)`)).toEqual(['session', 'session']);
    const device = (await b.call('sessions.list', {})).find((session) => session.role === 'device');
    expect(device).toMatchObject({ group: true });
    expect((await a.call('group.get', {}))?.devices).toHaveLength(1);
    await mobileAction(page, 'mobile-conversations');
    await page.waitFor(`document.querySelectorAll('[data-testid="mobile-list"] .thread').length === 2`);
    await capture('group-phone-both-machines.png');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);

    // Removed from the group: the second machine leaves, drops the phone's key, and the page lets it go.
    await a.call('group.remove', { coreId: joined.self });
    await page.waitFor(`globalThis.__boiteTest.workspace.machines.length === 1`, 20_000);
    expect(await b.call('group.get', {})).toBeNull();
    expect((await b.call('sessions.list', {})).filter((session) => session.group)).toEqual([]);
    await page.send('Emulation.clearDeviceMetricsOverride', {});
  } finally {
    a.close();
    b.close();
  }
}, 90_000);
