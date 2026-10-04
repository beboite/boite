import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
let main: string;
let remote: string;
const id = (name: string) => `[data-testid="${name}"]`;
const desktopRow = (machine: string, thread = 't-trace') => `${id('thread-row')}[data-machine-id="${machine}"][data-thread-id="${thread}"]`;
const doneRow = (machine: string, thread = 't-trace') => `${id('done-thread')}[data-machine-id="${machine}"][data-thread-id="${thread}"]`;
const phoneRow = (machine: string, thread = 't-trace') => `.row[data-machine-id="${machine}"][data-thread-id="${thread}"]`;
const inGroup = (kind: 'done' | 'archived', machine: string, thread = 't-trace') => `${id(`recent-${kind}`)} ${doneRow(machine, thread)}`;
const phoneArchived = (machine: string) => `${id('mobile-list')} ${inGroup('archived', machine)}`;
const phoneToggle = (kind: 'done' | 'archived' | 'working') => `${id('mobile-list')} ${id(`recent-${kind}-toggle`)}`;
const captures = process.env.BOITE_RECENT_CAPTURES ?? join(import.meta.dir, '.artifacts');

async function capture(name: string): Promise<void> {
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
  await page.screenshot(join(captures, name));
}
async function phone(): Promise<void> {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.click(id('mobile-back'));
  await page.waitFor(`document.querySelector('${id('mobile-list')}')`);
}
async function phoneGroup(kind: 'done' | 'archived' | 'working'): Promise<void> {
  await page.evaluate(`document.querySelector('${phoneToggle(kind)}').scrollIntoView({block:'center'})`);
  await page.click(phoneToggle(kind));
}
async function workingPreference(): Promise<void> {
  await page.click(id('nav-settings'));
  await page.click(id('settings-tab-general'));
  await page.click(id('setting-group-working-threads'));
  await page.click(id('settings-back'));
}
beforeAll(async () => {
  mkdirSync(captures, { recursive: true });
  const port = await freePort(); server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent&machines=1`;
  page = await BrowserPage.launch({ url, windowSize: { width: 1280, height: 900 } });
}, 60_000);
beforeEach(async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`localStorage.removeItem('boite.recent.v1'); localStorage.removeItem('boite.project-view.v1'); localStorage.setItem('boite.locale', 'fr')`);
  await page.navigate(url);
  await page.waitFor(`globalThis.__boiteTest?.workspace.machines.length === 2 && document.querySelectorAll('${id('thread-row')}').length === 8`);
  [main, remote] = await page.evaluate<[string, string]>('globalThis.__boiteTest.workspace.machines.map(machine => machine.id)');
  await page.click(id('view-recent'));
});
afterAll(async () => { await page?.close(); await server?.close(); });

test('Done is collapsed, can be read and reopened, and keeps the other machine with the same thread id', async () => {
  await page.waitFor(`document.querySelector('${desktopRow(main)}')`);
  await page.evaluate(`document.querySelector(${JSON.stringify(desktopRow(main))}).closest('.thread').querySelector('${id('thread-done')}').click()`);
  await page.waitFor(`!document.querySelector(${JSON.stringify(desktopRow(main))})`);
  expect(await page.evaluate(`!!document.querySelector(${JSON.stringify(desktopRow(remote))})`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('recent-done-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
  expect(await page.evaluate(`document.querySelectorAll('${id('done-thread')}').length`)).toBe(0);
  await page.click(id('recent-done-toggle'));
  await page.waitFor(`document.querySelector(${JSON.stringify(inGroup('done', main))})`);
  await page.click(`${inGroup('done', main)} ${id('done-thread-open')}`);
  await page.waitFor(`document.querySelector('${id('done-thread-notice')}')`);
  expect(await page.evaluate(`!!document.querySelector('${id('composer-input')}')`)).toBe(false);
  expect(await page.evaluate(`document.querySelectorAll('${id('message')}').length > 0`)).toBe(true);
  await page.click(id('done-thread-reopen'));
  await page.waitFor(`document.querySelector(${JSON.stringify(desktopRow(main))}) && document.querySelector('${id('composer-input')}')`);
  expect(await page.evaluate('globalThis.__boiteTest.workspace.machines[0].store.openThread.archived')).toBe(false);

  await phone();
  await page.click(`${phoneRow(main)} ${id('mobile-thread-menu-t-trace')}`);
  await page.click(`${id('mobile-thread-menu-t-trace-menu')} [data-value=archive]`);
  await page.waitFor(`!document.querySelector(${JSON.stringify(phoneRow(main))})`);
  expect(await page.evaluate(`!!document.querySelector(${JSON.stringify(phoneRow(remote))})`)).toBe(true);
  // Archiving by hand keeps the thread for later: it lands in Archived, not Done.
  await phoneGroup('archived');
  await page.waitFor(`document.querySelector(${JSON.stringify(phoneArchived(main))})`);
  expect(await page.evaluate(`!!document.querySelector('${id('mobile-list')} ${id('recent-done')}')`)).toBe(false);
  await page.click(`${phoneArchived(main)} ${id('done-thread-open')}`);
  await page.waitFor(`document.querySelector('${id('done-thread-reopen')}')`);
  await page.click(id('done-thread-reopen'));
  await page.waitFor('globalThis.__boiteTest.workspace.active.openThread?.archived === false');
}, 30_000);

test('working grouping persists on the device, retains attention and works on the phone', async () => {
  await workingPreference();
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.recent.v1')).groupWorking`)).toBe(true);
  await page.reload();
  await page.waitFor('globalThis.__boiteTest?.workspace.machines.length === 2');
  await page.evaluate(`(() => {
    const [first, second] = globalThis.__boiteTest.workspace.machines;
    first.store.threads = first.store.threads.map(t => t.id === 't-trace' ? {...t, status:'running', unread:false} : t.id === 't-descriptors' ? {...t, status:'error'} : t);
    second.store.threads = second.store.threads.map(t => t.id === 't-trace' ? {...t, status:'queued', unread:false} : t.id === 't-descriptors' ? {...t, pinned:true, status:'running'} : t);
  })()`);
  await page.waitFor(`document.querySelector('${id('recent-working-toggle')}')`);
  expect(await page.evaluate(`document.querySelector('${id('recent-working-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
  expect(await page.evaluate(`!!document.querySelector(${JSON.stringify(desktopRow(main))})`)).toBe(false);
  expect(await page.evaluate(`!!document.querySelector(${JSON.stringify(desktopRow(main, 't-scheduler'))})`)).toBe(true);
  expect(await page.evaluate(`!!document.querySelector(${JSON.stringify(desktopRow(main, 't-descriptors'))})`)).toBe(true);
  expect(await page.evaluate(`!!document.querySelector(${JSON.stringify(desktopRow(remote, 't-descriptors'))})`)).toBe(true);
  await capture('recent-desktop.png');
  await page.click(id('recent-working-toggle'));
  await page.waitFor(`document.querySelector(${JSON.stringify(desktopRow(main))})`);
  await page.click(id('recent-working-toggle'));
  await phone();
  expect(await page.evaluate(`document.querySelector('${phoneToggle('working')}').getAttribute('aria-expanded')`)).toBe('false');
  expect(await page.evaluate(`!!document.querySelector(${JSON.stringify(phoneRow(main))})`)).toBe(false);
  await page.evaluate(`document.querySelector('${id('mobile-list')}').scrollTop = 64`);
  await capture('recent-phone.png');
  await phoneGroup('working');
  await page.waitFor(`document.querySelector(${JSON.stringify(phoneRow(main))})`);
  await page.click(phoneToggle('working'));
  await page.type(id('mobile-search'), 'Finish the trace');
  await page.waitFor(`document.querySelector(${JSON.stringify(phoneRow(main))})`);
  await page.click(id('mobile-menu'));
  await page.click(id('mobile-settings'));
  await page.waitFor(`document.querySelector('${id('mobile-settings-home')}')`);
  expect(await page.evaluate(`document.querySelector('${id('setting-group-working-threads')}').checked`)).toBe(true);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await capture('recent-settings-phone.png');
  await page.click(id('setting-group-working-threads'));
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.recent.v1')).groupWorking`)).toBe(false);
  await page.click(id('mobile-menu'));
  await page.click(id('mobile-conversations'));
  await page.type(id('mobile-search'), '');
  await page.waitFor(`!document.querySelector('${phoneToggle('working')}')`);
  await page.waitFor(`document.querySelector(${JSON.stringify(phoneRow(main))})`);
}, 30_000);

test('a merged PR arrives in Done and project filtering and restoration follow the owning machine', async () => {
  const {threadId, archived} = await page.evaluate<{threadId: string; archived: number}>(`(async () => {
    const s = globalThis.__boiteTest.workspace.machines[0].store;
    const t = await s.client.call('threads.create', {projectId:'p-boite', providerId:'echo', accountId:'a-echo', title:'Clean the Recent sidebar', worktree:{branch:'boite/recent-sidebar'}}), sha = 'a'.repeat(40);
    s.client.setMergedPrFixture(t.id, {repository:'github.com/example/repo', branch:t.branch, tip:sha, clean:true, candidates:[{repository:'github.com/example/repo', branch:t.branch, sha, number:407, url:'https://github.com/example/repo/pull/407', mergedAt:'2026-10-02T12:00:00Z', fork:false}]});
    return {threadId:t.id, archived:await s.client.sweepMergedPrArchives()};
  })()`);
  expect(archived).toBe(1);
  await page.waitFor(`!document.querySelector(${JSON.stringify(desktopRow(main, threadId))})`);
  await page.click(id('recent-done-toggle'));
  await page.waitFor(`document.querySelector(${JSON.stringify(inGroup('done', main, threadId))})`);
  expect(await page.evaluate(`document.querySelector(${JSON.stringify(inGroup('done', main, threadId))}).querySelector('${id('done-thread-merged')}').getAttribute('href')`)).toBe('https://github.com/example/repo/pull/407');
  await capture('recent-done-desktop.png');
  await page.click(id('project-filter'));
  await page.evaluate(`Array.from(document.querySelectorAll('${id('project-filter-menu')} [data-value]')).find(e => e.dataset.value === ${JSON.stringify(JSON.stringify(['http://builder.test', 'p-boite']))}).click()`);
  // The other machine has no done thread in this project, only its seeded archive.
  await page.waitFor(`!document.querySelector('${id('recent-done')}')`);
  await page.click(id('recent-archived-toggle'));
  await page.waitFor(`document.querySelectorAll('${id('done-thread')}').length === 1 && document.querySelector(${JSON.stringify(inGroup('archived', remote, 't-parser'))})`);
  expect(await page.evaluate(`!!document.querySelector(${JSON.stringify(desktopRow(remote))})`)).toBe(true);
  await page.click(id('project-filter'));
  await page.click(`${id('project-filter-menu')} [data-value=all]`);
  await page.waitFor(`document.querySelector(${JSON.stringify(doneRow(main, threadId))})`);
  await page.click(`${doneRow(main, threadId)} ${id('done-thread-restore')}`);
  await page.waitFor(`document.querySelector(${JSON.stringify(desktopRow(main, threadId))})`);
  expect(await page.evaluate('globalThis.__boiteTest.workspace.machines[0].store.client.sweepMergedPrArchives()')).toBe(0);
}, 20_000);

test('the draft project picker has its logo and dashed selection at desktop and phone widths', async () => {
  await page.evaluate('globalThis.__boiteTest.workspace.machines[0].store.startDraft("p-boite")');
  await page.waitFor(`document.querySelector('${id('draft-project')} [data-kind=image] img')?.complete`);
  await page.waitFor(`document.querySelector('${id('recent-archived-toggle')}')`);
  expect(await page.evaluate(`getComputedStyle(document.querySelector('${id('draft-project')}').closest('.project-choice')).borderStyle`)).toBe('dashed');
  await capture('recent-project-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('${id('mobile-draft-project')} [data-kind=image] img')?.complete`);
  expect(await page.evaluate(`getComputedStyle(document.querySelector('${id('mobile-draft-project')}').closest('.project-choice')).borderStyle`)).toBe('dashed');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await capture('recent-project-phone.png');
  await page.click(id('mobile-draft-project'));
  await page.evaluate(`Array.from(document.querySelectorAll('${id('mobile-draft-project-menu')} [data-value]')).find(e => e.dataset.value === ${JSON.stringify(JSON.stringify(['http://builder.test', 'p-notes']))}).click()`);
  await page.waitFor(`globalThis.__boiteTest.workspace.active.machineId === 'http://builder.test' && document.querySelector('${id('mobile-draft-project')} [data-tech=python]')`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  expect(page.errors()).toEqual([]);
  console.log('RECENT_PROJECT_PICKER_OK desktop=1280x900 phone=390x844');
}, 20_000);
