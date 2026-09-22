import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const id = (name: string) => `[data-testid="${name}"]`;
async function pointerClick(selector: string) {
  const point = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.left + Math.min(12, r.width / 2), y:r.top + r.height / 2}; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port, { sourceModules: true });
  url = `http://127.0.0.1:${port}/?fake=1&open=recent&long=1&machines=1`;
  page = await BrowserPage.launch({ url, windowSize: { width: 1310, height: 820 } });
  await page.waitFor(`document.querySelector('${id('timeline')}')`);
}, 120_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('header and project layout', async () => {
  await capture(process.env.BOITE_CAPTURE_BEFORE ? 'header-before.png' : 'header-expanded.png');
  if (process.env.BOITE_CAPTURE_BEFORE) return;
  expect(await page.evaluate(`document.querySelectorAll('${id('titlebar')}').length`)).toBe(1);
  expect(await page.evaluate(`document.querySelector('${id('titlebar')}').contains(document.querySelector('${id('thread-title')}'))`)).toBe(true);
  await pointerClick(id('sidebar-toggle'));
  await page.waitFor(`document.querySelector('${id('sidebar-toggle')}').getAttribute('aria-expanded') === 'false'`);
  await capture('header-collapsed.png');
  await page.navigate(url);
  await page.waitFor(`document.querySelector('${id('timeline')}')`);
  expect(await page.evaluate(`document.querySelector('${id('sidebar-toggle')}').getAttribute('aria-expanded')`)).toBe('false');
  await page.click(id('sidebar-toggle'));
  await page.evaluate(`(async () => {
    const { workspace } = await import('/src/lib/workspace.svelte.ts');
    workspace.active.localCore = true;
    workspace.machines = [...workspace.machines].reverse();
  })()`);
  await pointerClick(id('machine-status'));
  await page.waitFor(`document.querySelector('${id('machine-status-menu')}')`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('machine-status-menu')} [data-row]')).slice(0,2).map(el => el.textContent.trim())`)).toEqual(['All machines', 'This PC']);
  expect(await page.evaluate(`document.querySelector('${id('machine-status-menu')} [role=separator]') !== null`)).toBe(true);
  await capture('machine-menu.png');
  await page.click(`${id('machine-status-menu')} [data-value=all]`);
  // Choose a message outside the mounted virtual window.
  expect(await page.evaluate(`document.querySelectorAll('${id('message-outline')} button').length`)).toBeLessThanOrEqual(14);
  expect(await page.evaluate(`document.querySelector('${id('message-marker')}').getBoundingClientRect().height`)).toBe(6);
  await pointerClick(id('outline-group'));
  await page.waitFor(`document.querySelector('${id('outline-group-menu')}')`);
  await capture('message-groups.png');
  const target = await page.evaluate<string>(`document.querySelectorAll('[data-group-message]')[12].dataset.groupMessage`);
  await page.click(`[data-group-message="${target}"]`);
  await page.waitFor(`!document.querySelector('${id('outline-group-menu')}')`);
  try {
    await page.waitFor(`(() => { const node = document.querySelector('[data-mid="${target}"]'); const box = document.querySelector('${id('timeline')}'); return node && Math.abs(node.getBoundingClientRect().top - box.getBoundingClientRect().top - 20) < 4; })()`);
  } catch (error) {
    console.log(await page.evaluate(`({top:document.querySelector('${id('timeline')}').scrollTop, rows:Array.from(document.querySelectorAll('[data-mid]')).map(n => [n.dataset.mid,n.getBoundingClientRect().top])})`));
    await capture('navigation-failure.png');
    throw error;
  }
  await capture('message-navigation.png');
  // Both distant groups now exist. Escape must return to the second opener.
  await page.waitFor(`document.querySelectorAll('${id('outline-group')}').length === 2`);
  await page.evaluate(`document.querySelectorAll('${id('outline-group')}')[1].click()`);
  await page.waitFor(`document.querySelector('${id('outline-group-menu')}')?.contains(document.activeElement)`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor(`!document.querySelector('${id('outline-group-menu')}')`);
  expect(await page.evaluate(`document.activeElement === document.querySelectorAll('${id('outline-group')}')[1]`)).toBe(true);
  await page.evaluate(`document.querySelector('[data-message-id="${target}"]').focus({preventScroll:true})`);
  await page.waitFor(`document.querySelector('${id('message-preview')}')`);
  expect(await page.evaluate(`document.querySelectorAll('[role=tooltip]').length`)).toBe(1);
  expect(await page.evaluate(`document.querySelector('${id('message-outline')}').getBoundingClientRect().width`)).toBe(28);
  expect(await page.evaluate(`(() => { const rail = document.querySelector('${id('message-outline')}').getBoundingClientRect(); const timeline = document.querySelector('${id('timeline')}').getBoundingClientRect(); return Math.abs(rail.top + rail.height / 2 - timeline.top - timeline.height / 2); })()`)).toBeLessThan(1);
  await capture('message-preview.png');
  // The rail opens around the pointer, and the bar under it stays under it.
  const bar = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelectorAll('${id('message-marker')}')[4].getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...bar });
  await page.waitFor(`document.querySelectorAll('${id('message-marker')}')[4].classList.contains('hot')`);
  await capture('message-lens.png');
  expect(await page.evaluate(`(() => { const bars = document.querySelectorAll('${id('message-marker')}'); return bars[5].getBoundingClientRect().top - bars[4].getBoundingClientRect().top; })()`)).toBeGreaterThan(12);
  expect(await page.evaluate(`document.elementFromPoint(${bar.x}, ${bar.y})?.closest('${id('message-marker')}') === document.querySelectorAll('${id('message-marker')}')[4]`)).toBe(true);
  // Hovering a chevron slides the rail's window over the conversation; the timeline stays where it is.
  const numbered = `Array.from(document.querySelectorAll('${id('message-marker')}')).map(node => Number(/message ([0-9]+)/.exec(node.getAttribute('aria-label'))[1]))`;
  const shown = await page.evaluate<number>(`(${numbered})[1]`);
  const scrolled = await page.evaluate<number>(`document.querySelector('${id('timeline')}').scrollTop`);
  const chevron = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${id('outline-earlier')}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...chevron });
  await page.waitFor(`(${numbered})[1] < ${shown}`);
  await capture('message-outline-earlier.png');
  expect(await page.evaluate(`document.querySelector('${id('timeline')}').scrollTop`)).toBe(scrolled);
  // The other chevron appears once entries are hidden below, and brings the window back down.
  const back = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${id('outline-later')}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...back });
  await page.waitFor(`(${numbered})[1] >= ${shown}`);
  // Leaving the rail puts its window back on the active prompt.
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 100 });
  await page.waitFor(`(${numbered})[1] === ${shown}`);
  await page.evaluate(`document.querySelector('[data-message-id="${target}"]').focus({preventScroll:true})`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  expect(await page.evaluate(`document.activeElement?.dataset.messageId !== '${target}'`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-message-id="${target}"]').getAttribute('aria-current')`)).toBe('location');
  // Loading the previous page keeps every earlier prompt reachable.
  const count = await page.evaluate<number>(`Number(document.querySelector('${id('message-outline')}').dataset.messageCount)`);
  await page.evaluate(`document.querySelector('${id('message-outline')}').scrollTop = 0`);
  await page.click(id('outline-earlier'));
  await page.waitFor(`Number(document.querySelector('${id('message-outline')}').dataset.messageCount) > ${count}`);
  expect(await page.evaluate(`document.querySelectorAll('${id('message-outline')} button').length`)).toBeLessThanOrEqual(14);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('header-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.click(id('sidebar-toggle'));
  await page.waitFor(`document.querySelector('${id('sidebar')}').classList.contains('open')`);
  await capture('projects-phone.png');
  await page.click(id('sidebar-toggle'));
  await page.waitFor(`!document.querySelector('${id('sidebar')}').classList.contains('open')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1310, height: 820, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`(async () => {
    const { workspace } = await import('/src/lib/workspace.svelte.ts');
    const store = workspace.active;
    const account = store.accountsOf('codex')[0];
    await store.createThread({projectId:store.projects[0].id,providerId:'codex',accountId:account.id,model:'default',permissionMode:'default',title:'Review the next change'});
  })()`);
  await page.waitFor(`document.querySelector('${id('composer-picker')}').textContent.includes('GPT 5.6 Sol')`);
  expect(await page.evaluate(`document.querySelector('${id('composer-picker')}').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(30);
  await capture('composer-preset.png');
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await capture('header-light.png');
}, 30_000);
