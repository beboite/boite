import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { startCore, type RunningCore } from './lib/core.ts';
import { connect } from '../../packages/core/src/client.ts';

/* `boite thread new --machine`: two real cores of one group, the card that lets the other machine accept threads, and the thread it starts there. */

const ARTIFACTS = join(import.meta.dir, '.artifacts', 'thread-spawn-machine');
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };
const DOCKED = '[data-testid="activity-question"] [data-testid="setting-card"][data-state="pending"]';
const id = (name: string) => `[data-testid="${name}"]`;

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const cores: RunningCore[] = [];
async function capture(name: string) {
  await page.settleAnimations();
  await page.screenshot(join(ARTIFACTS, name));
}
beforeAll(async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}`;
  page = await BrowserPage.launch({ url: `${url}/?fake=1` });
}, 30_000);
afterAll(async () => {
  await page?.close();
  await server?.close();
  for (const core of cores) await core.stop();
}, 30_000);

test('a thread on one machine asks the other to accept threads, the card flips it there, and the thread starts there', async () => {
  const desk = await startCore(),
    pc = await startCore();
  cores.push(desk, pc);
  const a = await connect(desk.url, desk.token);
  const b = await connect(pc.url, pc.token);
  try {
    await Promise.all([a.call('settings.set', { browserOrigins: [url] }), b.call('settings.set', { browserOrigins: [url] })]);
    await a.call('group.create', { name: 'Home' });
    const joined = await b.call('group.join', { invite: (await a.call('group.invite', {})).invite });
    // Both cores of the test go by this computer's host name: the agent names the other by a core id prefix.
    const machine = joined.self.slice(0, 8);
    const project = await a.call('projects.add', { path: desk.dataDir, name: 'Family helper' });
    const notesPath = join(pc.dataDir, 'notes');
    mkdirSync(notesPath, { recursive: true });
    await b.call('projects.add', { path: notesPath, name: 'Notes' });
    const account = (await a.call('accounts.list', {})).find((entry) => entry.providerId === 'echo')!;
    const caller = await a.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, model: 'echo', title: 'Print the school letter' });
    await a.call('turns.start', { threadId: caller.id, prompt: 'Print the school letter on the PC printer', clientRequestId: 'e2e-user-turn' });
    for (let attempt = 0; attempt < 100 && (await a.call('threads.get', { threadId: caller.id })).status !== 'idle'; attempt++) await Bun.sleep(100);

    // Off by default on the machine that would hold it: the agent is told to propose the switch.
    const spawn = { threadId: caller.id, project: 'notes', prompt: 'Print the letter on the USB printer', title: 'Print the letter', machine };
    const refusal = await a.call('agent.spawn', { ...spawn, requestId: 'e2e-print-1' }).then(() => '', (error: Error) => error.message);
    expect(refusal).toContain(`boite settings request groupThreads true --machine ${machine} --why`);
    await a.call('settings.request', { threadId: caller.id, reason: 'The printer is on the PC', key: 'groupThreads', value: true, machine });

    await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
    await page.evaluate('localStorage.clear()');
    await page.navigate(`${url}/?core=${encodeURIComponent(desk.url)}&token=${encodeURIComponent(desk.token)}`);
    await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
    await page.click(id('confirm-ok'));
    await page.waitFor(`globalThis.__boiteTest.workspace.machines.filter(machine => machine.store.connection === 'ready').length === 2`, 30_000);
    await page.waitFor(`document.querySelector('[data-thread-id="${caller.id}"]')`);
    await page.click(`[data-thread-id="${caller.id}"]`);

    // The card names the other machine and its switch shows that machine's value.
    await page.waitFor(`document.querySelector('${DOCKED} ${id('setting-switch')}')?.getBoundingClientRect().width > 0`, 15_000);
    expect(await page.evaluate(`document.querySelector('${DOCKED} ${id('setting-switch')}').checked`)).toBe(false);
    const name = (await b.call('collaboration.identity', {})).name;
    expect(await page.text(`${DOCKED} ${id('setting-place')}`)).toContain(name);
    expect(await page.evaluate(`document.querySelector('${DOCKED} ${id('setting-machine-away')}')`)).toBeNull();
    await capture('card-desktop.png');
    await page.send('Emulation.setDeviceMetricsOverride', PHONE);
    await page.waitFor(`document.querySelector('${DOCKED}')?.getBoundingClientRect().width > 0`);
    expect(await page.evaluate(`(() => { const card = document.querySelector('${DOCKED}').getBoundingClientRect(); return card.left >= 0 && card.right <= innerWidth; })()`)).toBe(true);
    await capture('card-phone.png');
    await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);

    // The switch writes the PC's setting, not this machine's; the PC tells the group and the card settles.
    await page.waitFor(`document.querySelector('${DOCKED} ${id('setting-switch')}')?.getBoundingClientRect().width > 0`);
    await page.click(`${DOCKED} ${id('setting-switch')}`);
    await page.waitFor(`document.querySelector('${id('setting-card')}[data-outcome="applied"]')`, 15_000);
    expect((await b.call('settings.get', {})).groupThreads).toBe(true);
    expect((await a.call('settings.get', {})).groupThreads ?? false).toBe(false);

    // Now the thread starts on the PC, in its Notes project, and the caller's timeline links it there.
    const started = await a.call('agent.spawn', { ...spawn, requestId: 'e2e-print-2' });
    expect(started.address.coreId).toBe(joined.self);
    expect((await b.call('threads.get', { threadId: started.thread.id })).cwd).toBe(notesPath);
    const marker = `${id('spawn-marker')}[data-direction=to]`;
    await page.waitFor(`document.querySelector('${marker}')?.textContent.includes('Print the letter')`, 15_000);
    expect(await page.text(marker)).toContain(`Notes · ${name}`);
    await page.evaluate(`document.querySelector('${marker}').scrollIntoView({ block: 'center' })`);
    await capture('started-desktop.png');

    // Settings, Machines and updates: each machine's row carries its own switch.
    await page.click(id('nav-settings'));
    await page.click(id('settings-tab-machines'));
    const switches = id('machine-group-threads-switch');
    await page.waitFor(`document.querySelectorAll('${switches}').length === 2`, 15_000);
    expect(await page.evaluate(`[...document.querySelectorAll('${switches}')].map(input => input.checked).sort()`)).toEqual([false, true]);
    // Bots of the other machines are a switch of their own, off on both until the owner turns it on.
    expect(await page.evaluate(`[...document.querySelectorAll('${id('machine-group-bots-switch')}')].map(input => input.checked)`)).toEqual([false, false]);
    await page.evaluate(`document.querySelector('${id('machine-group-threads')}').closest('${id('machine-card')}').scrollIntoView({ block: 'center' })`);
    await capture('machines-desktop.png');
    await page.send('Emulation.setDeviceMetricsOverride', PHONE);
    await page.waitFor(`document.querySelector('${id('machine-group-threads')}')?.getBoundingClientRect().width > 0`);
    await page.evaluate(`document.querySelector('${id('machine-group-threads')}').closest('${id('machine-card')}').scrollIntoView({ block: 'center' })`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await capture('machines-phone.png');
    await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
    expect(page.errors()).toEqual([]);
  } finally {
    a.close();
    b.close();
  }
}, 120_000);
