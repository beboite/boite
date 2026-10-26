import { mobileAction, screensSettled } from './lib/mobile.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { setProjectOrder, showThreadView } from './lib/views.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const id = (name: string) => `[data-testid="${name}"]`;
async function capture(name: string) {
  await page.settleAnimations();
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent&machines=1`;
  page = await BrowserPage.launch({ url, windowSize: { width: 1300, height: 850 } });
  await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 8`);
}, 30_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

test('recent view filters one owning project and creates its draft', async () => {
  await showThreadView(page, 'recent');
  await capture('project-views-desktop.png');
  expect(await page.evaluate(`!!document.querySelector('${id('project-filter')}')`)).toBe(true);
  await page.click(id('project-filter'));
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  expect(await page.evaluate(`document.activeElement?.getAttribute('role')`)).toBe('menuitem');
  await page.evaluate(`Array.from(document.querySelectorAll('${id('project-filter-menu')} [data-value]')).find(e => e.dataset.value === JSON.stringify(['http://builder.test', 'p-notes'])).click()`);
  await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 1`);
  expect(await page.evaluate(`document.querySelector('${id('thread-row')}').dataset.machineId`)).toBe('http://builder.test');
  await page.click(id('new-thread'));
  await page.waitFor(`globalThis.__boiteTest.workspace.active.draft?.projectId === 'p-notes'`);
  expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.machineId`)).toBe('http://builder.test');
  await capture('project-filter-desktop.png');
  await page.evaluate(`globalThis.__boiteTest.workspace.select(globalThis.__boiteTest.workspace.machines[0].store, 't-trace')`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 2, windowsVirtualKeyCode: 78 });
  await page.waitFor(`globalThis.__boiteTest.workspace.active.machineId === 'http://builder.test' && globalThis.__boiteTest.workspace.active.draft?.projectId === 'p-notes'`);
  await page.evaluate(`globalThis.__boiteTest.workspace.active.archiveProject('p-notes', true)`);
  await page.waitFor(`document.querySelector('${id('project-filter')}')?.textContent.includes('All projects') && document.querySelectorAll('${id('thread-row')}').length === 7`);
  await page.evaluate(`globalThis.__boiteTest.workspace.active.archiveProject('p-notes', false)`);
  await page.click(id('project-filter'));
  await page.click(`${id('project-filter-menu')} [data-value=all]`);
  await page.waitFor(`document.querySelectorAll('${id('thread-row')}').length === 8`);
  await page.click(id('sidebar-search-open'));
  await page.waitFor(`document.querySelector('${id('palette-input')}')`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor(`!document.querySelector('${id('palette-input')}')`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await page.waitFor(`document.querySelector('${id('palette-input')}')`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor(`!document.querySelector('${id('palette-input')}')`);
}, 20_000);

test('copy path stays readable with a long working directory in conversation menus', async () => {
  await page.evaluate(`localStorage.setItem('boite.locale', 'fr')`);
  await page.navigate(url);
  await page.waitFor(`globalThis.__boiteTest?.workspace.active.openThread`);
  const cwd = await page.evaluate<string>(`(() => {
    const cwd = '/workspace/projects/a-long-project-name/worktrees/a-long-conversation-branch/packages/client';
    const s = globalThis.__boiteTest.workspace.active;
    s.openThread.cwd = cwd;
    s.threads = s.threads.map(t => ({...t, cwd}));
    return cwd;
  })()`);
  await page.send('Browser.grantPermissions', { origin: new URL(url).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  for (const opener of ['thread-row', 'thread-title']) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(() => {
      const { workspace } = globalThis.__boiteTest;
      const owner = workspace.active;
      const machine = workspace.machines.find(m => m.store === owner);
      const target = '${opener}' === 'thread-row'
        ? Array.from(document.querySelectorAll('${id('thread-row')}')).find(e => e.dataset.machineId === machine.id && e.dataset.threadId === owner.openThread.id)
        : document.querySelector('${id(opener)}');
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 180 }));
    })()`);
    const menu = id('context-menu');
    const copy = `${menu} [data-value=copy]`;
    await page.waitFor(`document.querySelector('${copy}')`);
    await capture(`copy-path-${opener}.png`);
    expect(await page.evaluate(`(() => { const e = document.querySelector('${copy}'); return e.scrollWidth <= e.clientWidth; })()`)).toBe(true);
    expect(await page.evaluate(`document.querySelector('${copy}').textContent.trim()`)).toBe('Copier le chemin');
    // Each opener writes its own copy: the previous one must not answer for it.
    await page.evaluate(`navigator.clipboard.writeText('')`);
    await page.click(copy);
    await page.waitFor(`!document.querySelector('${menu}')`);
    // The menu closes at once and the copy it fired lands afterwards: the
    // clipboard write is asynchronous and nothing awaits it.
    await page.waitFor(`navigator.clipboard.readText().then(text => text === ${JSON.stringify(cwd)})`);
  }
  // A phone leaves the path to the desktop: its title menu has no Copy path.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await page.click(id('thread-menu-trigger'));
  await page.waitFor(`document.querySelector('${id('thread-menu-trigger-menu')} [data-value=rename]')`);
  expect(await page.evaluate(`document.querySelector('${id('thread-menu-trigger-menu')} [data-value=copy]')`)).toBeNull();
  await page.click(id('thread-menu-trigger'));
  await page.waitFor(`!document.querySelector('${id('thread-menu-trigger-menu')}')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}, 20_000);

test('projects follow user activity, then keep a dragged custom order after reload', async () => {
  await showThreadView(page, 'projects');
  // The menu ends every header at the same place, whatever counters sit before it.
  const menuEdges = await page.evaluate<number[]>(`Array.from(document.querySelectorAll('${id('project-menu')}')).map(e => Math.round(e.getBoundingClientRect().right))`);
  expect(menuEdges.length).toBeGreaterThan(1);
  expect(new Set(menuEdges).size).toBe(1);
  await page.evaluate(`(() => { const s = globalThis.__boiteTest.workspace.machines[1].store; s.threads = s.threads.map(t => t.projectId === 'p-notes' ? {...t, lastUserMessageAt: Date.now() + 1000} : t); })()`);
  const keys = () => page.evaluate<string[]>(`Array.from(document.querySelectorAll('${id('project')}')).map(e => JSON.stringify([e.dataset.machineId, e.dataset.projectId]))`);
  await page.waitFor(`document.querySelector('${id('project')}')?.dataset.projectId === 'p-notes'`);
  expect((await keys())[0]).toBe(JSON.stringify(['http://builder.test', 'p-notes']));
  const activityOrder = await keys();
  await page.evaluate(`(() => { const s = globalThis.__boiteTest.workspace.machines[0].store; s.threads = s.threads.map(t => ({...t, updatedAt: Date.now() + 10000})); })()`);
  expect(await keys()).toEqual(activityOrder);
  await setProjectOrder(page, 'manual');
  const before = await keys();
  await page.click(id('project-menu'));
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('context-menu')} [data-value]')).map(e => e.dataset.value)`)).toEqual(['new', 'copy', 'archived', 'manage']);
  await page.click(`${id('context-menu')} [data-value=manage]`);
  await page.waitFor(`document.querySelector('${id('context-menu')} [data-value=move-up]')`);
  expect(await page.evaluate(`document.querySelector('${id('context-menu')} [data-value=move-up]').disabled`)).toBe(true);
  await page.click(`${id('context-menu')} [data-value=move-down]`);
  await page.waitFor(`!document.querySelector('${id('context-menu')}')`);
  expect(await keys()).toEqual([before[1]!, before[0]!, ...before.slice(2)]);
  await page.click(id('project-menu'));
  await page.click(`${id('context-menu')} [data-value=manage]`);
  await page.click(`${id('context-menu')} [data-value=move-down]`);
  await page.waitFor(`!document.querySelector('${id('context-menu')}')`);
  expect(await keys()).toEqual(before);
  // A real mouse drag: the header is taken past the threshold, then dropped on the upper half of the first project.
  const points = await page.evaluate<{ from: { x: number; y: number }; to: { x: number; y: number } }>(`(() => { const rows = document.querySelectorAll('${id('project')}'); const a = rows[3].querySelector('${id('project-row')}').getBoundingClientRect(); const b = rows[0].getBoundingClientRect(); return { from: { x: a.left + a.width / 2, y: a.top + a.height / 2 }, to: { x: b.left + b.width / 2, y: b.top + Math.min(8, b.height / 4) } }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...points.from, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.from.x, y: points.from.y - 12, button: 'left', buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points.to, button: 'left', buttons: 1 });
  await page.waitFor(`document.documentElement.classList.contains('project-dragging')`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...points.to, button: 'left', buttons: 0, clickCount: 1 });
  await page.waitFor(`JSON.stringify(Array.from(document.querySelectorAll('${id('project')}')).map(e => JSON.stringify([e.dataset.machineId, e.dataset.projectId]))) === ${JSON.stringify(JSON.stringify([before[3]!, ...before.slice(0, 3)]))}`);
  expect(await keys()).toEqual([before[3]!, ...before.slice(0, 3)]);
  await setProjectOrder(page, 'recent');
  expect(await keys()).toEqual(activityOrder);
  await setProjectOrder(page, 'manual');
  expect(await keys()).toEqual([before[3]!, ...before.slice(0, 3)]);
  await capture('project-order-desktop.png');
  await page.navigate(url);
  await page.waitFor(`document.querySelectorAll('${id('project')}').length === 4`);
  expect(await keys()).toEqual([before[3]!, ...before.slice(0, 3)]);
}, 20_000);

test('phone reorders a project from its group on a short screen and manages no project from its header', async () => {
  const keys = () => page.evaluate<string[]>(`Array.from(document.querySelectorAll('${id('project')}, ${id('mobile-project-group')}')).map(e => JSON.stringify([e.dataset.machineId, e.dataset.projectId]))`);
  const before = await keys();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 240, deviceScaleFactor: 1, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await mobileAction(page, 'mobile-conversations');
  await page.waitFor(`document.querySelectorAll('${id('mobile-project-group')}').length === 4`);
  // Projects are managed on the desktop: the phone's header holds the picker, + and the menu.
  expect(await page.evaluate(`document.querySelector('${id('mobile-project-actions')}') === null`)).toBe(true);
  await page.click(`${id('mobile-project-group')} ${id('mobile-project-order')}`);
  // The sheet rises from the bottom edge: measured where it stops.
  await page.waitFor(`document.querySelector('${id('mobile-project-order-menu')} [data-value=down]') && ${screensSettled}`);
  expect(await page.evaluate(`(() => { const r = document.querySelector('${id('mobile-project-order-menu')}').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`)).toBe(true);
  await capture('project-management-short-phone.png');
  await page.click(`${id('mobile-project-order-menu')} [data-value=down]`);
  await page.waitFor(`!document.querySelector('${id('mobile-project-order-menu')}')`);
  expect(await keys()).toEqual([before[1]!, before[0]!, ...before.slice(2)]);
}, 20_000);

test('phone exposes project filtering and custom-order controls without overflow', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await mobileAction(page, 'mobile-conversations');
  await page.waitFor(`document.querySelector('${id('mobile-list')}')`);
  await showThreadView(page, 'recent', 'mobile-');
  await page.click(id('mobile-project-filter'));
  await page.evaluate(`Array.from(document.querySelectorAll('${id('mobile-project-filter-menu')} [data-value]')).find(e => e.dataset.value === JSON.stringify(['http://builder.test', 'p-notes'])).click()`);
  await page.waitFor(`document.querySelectorAll('${id('mobile-list')} .thread').length === 1`);
  await capture('project-filter-phone.png');
  await showThreadView(page, 'projects', 'mobile-');
  await page.waitFor(`document.querySelectorAll('${id('mobile-project-group')}').length === 4`);
  await page.click(id('mobile-project-order'));
  await page.click(`${id('mobile-project-order-menu')} [data-value=down]`);
  await capture('project-order-phone.png');
  await page.evaluate(`localStorage.setItem('boite.locale', 'fr')`);
  await page.navigate(url);
  await mobileAction(page, 'mobile-conversations');
  await page.waitFor(`document.querySelector('${id('mobile-grouping-options')}')?.getAttribute('aria-label').startsWith('Options')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await capture('project-order-phone-fr.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.navigate(url);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`document.querySelector('${id('grouping-options')}')`);
  await page.evaluate(`globalThis.__boiteTest.workspace.active.setSidebarWidth(208)`);
  await page.waitFor(`document.querySelector('${id('sidebar')}')?.getBoundingClientRect().width === 208`);
  await capture('project-order-narrow-fr.png');
  expect(await page.evaluate(`(() => { const tools = document.querySelector('${id('grouping-options')}')?.closest('.tools'); return !!tools && tools.scrollWidth <= tools.clientWidth; })()`)).toBe(true);
  expect(page.errors()).toEqual([]);
}, 20_000);
