import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
async function capture(name: string) {
  const settled = await page.evaluate<{ timedOut: boolean; fonts: FontFaceSetLoadStatus; animations: Array<{ playState: AnimationPlayState; currentTime: number | null; endTime: number }> }>(`(async () => {
    const animations = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity);
    const ready = Promise.all([document.fonts.ready, ...animations.map(animation => animation.finished.catch(() => {}))]);
    return Promise.race([
      ready.then(() => ({ timedOut: false, fonts: document.fonts.status, animations: [] })),
      new Promise(resolve => setTimeout(() => resolve({
        timedOut: true,
        fonts: document.fonts.status,
        animations: animations.filter(animation => animation.playState !== 'finished').map(animation => ({
          playState: animation.playState,
          currentTime: animation.currentTime,
          endTime: animation.effect?.getComputedTiming().endTime ?? 0
        }))
      }), 2_000))
    ]);
  })()`);
  if (settled.timedOut) console.warn(`[capture] ${name} settle timed out: ${JSON.stringify(settled)}`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent&machines=1` });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid=mobile-tabs]')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('phone settings separate device preferences from remote administration, including owner sessions', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await page.click('[data-testid=mobile-settings]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=settings-tab-resources]') === null && document.querySelector('[data-testid=settings-tab-keyboard]') === null`)).toBe(true);
  await capture('phone-settings-home-dark.png');
  await page.click('[data-testid=mobile-settings-phone]');
  await page.waitFor(`document.querySelector('[data-testid=phone-settings]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=phone-public-url]') === null && document.querySelector('[data-testid=pairing-card]') === null`)).toBe(true);
  await capture('phone-settings-notifications.png');
  await page.evaluate('history.back()');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')`);
  await page.click('[data-testid=settings-tab-machines]');
  await page.waitFor(`document.querySelector('[data-testid=machine-add-open]')`);
  expect(await page.evaluate(`document.querySelector('.origins') === null`)).toBe(true);
  await capture('phone-settings-machines.png');
  await page.click('[data-testid=mobile-settings-back]');
  await page.click('[data-testid=settings-tab-appearance]');
  await page.click('[data-testid=theme-light]');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await capture('phone-settings-appearance-light.png');
  await page.click('[data-testid=mobile-settings-back]');
  await capture('phone-settings-home-light.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`document.querySelector('[data-testid=settings-tab-resources]')`);
  await capture('phone-settings-desktop-unchanged.png');
  await page.click('[data-testid=settings-back]');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
}, 30_000);

test('phone navigates conversations, activity and settings without a sidebar', async () => {
  await page.click('[data-testid=mobile-conversations]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-list] .thread')`);
  const tabs = await page.evaluate<{ bottom: number; height: number }>(`(() => { const r = document.querySelector('[data-testid=mobile-tabs]').getBoundingClientRect(); return {bottom:r.bottom,height:r.height}; })()`);
  expect(tabs.bottom).toBeLessThanOrEqual(844);
  expect(tabs.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await capture('mobile-conversations.png');
  await page.click('[data-testid=mobile-list] .thread');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]') && document.querySelector('[data-testid=chat]')`);
  await capture('mobile-chat.png');
  expect(await page.evaluate(`document.querySelector('[data-testid=titlebar]').getBoundingClientRect().bottom <= document.querySelector('[data-testid=timeline]').getBoundingClientRect().top`)).toBe(true);
  await page.click('[data-testid=mobile-activity]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-list] h1')?.textContent === 'Activity'`);
  await capture('mobile-activity.png');
  await page.click('[data-testid=mobile-settings]');
  await page.waitFor(`document.querySelector('[data-testid=settings]')`);
  await page.click('[data-testid=mobile-conversations]');
  await page.click('[data-testid=mobile-new]');
  await page.waitFor(`document.querySelector('[data-testid=composer]') && !document.querySelector('[data-testid=settings]')`);
  expect(page.errors()).toEqual([]);
}, 30_000);

test('draft survives navigation and the light phone layout fits landscape', async () => {
  await page.evaluate(`(() => { const t = document.querySelector('[data-testid=composer-input]'); t.value = 'Keep this draft'; t.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await page.click('[data-testid=mobile-conversations]');
  await page.click('[data-testid=mobile-header] [data-testid=mobile-new]');
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-input]').value`)).toBe('Keep this draft');
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 390, deviceScaleFactor: 1, mobile: true });
  await capture('mobile-landscape.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  const bounds = await page.evaluate<any>(`(() => { const r = document.querySelector('[data-testid=composer-input]').getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()`);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(390);
}, 15_000);

test('model sheets stay on screen and browser Back closes the sheet without losing the draft', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.click('[data-testid=mobile-new]');
  await page.waitFor(`document.querySelector('[data-testid=composer-input]')`);
  await page.evaluate(`(() => { const t = document.querySelector('[data-testid=composer-input]'); t.value = 'Keep this draft'; t.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await page.click('[data-testid=composer-picker]');
  await page.waitFor(`document.querySelector('[data-testid=composer-picker-menu]')`);
  await capture('mobile-model-sheet.png');
  const bounds = await page.evaluate<any>(`(() => { const r=document.querySelector('[data-testid=composer-picker-menu]').getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; })()`);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(390);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(844);
  await page.evaluate('history.back()');
  await page.waitFor(`!document.querySelector('[data-testid=composer-picker-menu]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-input]').value`)).toBe('Keep this draft');
  await page.click('[data-testid=mobile-settings]');
  await page.click('[data-testid=mobile-settings-phone]');
  await page.waitFor(`document.querySelector('[data-testid=phone-settings]')`);
  await capture('mobile-installation.png');
}, 15_000);

test('returning to a long conversation preserves the reading position', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent&long=1`);
  await page.waitFor(`document.querySelector('[data-testid=thread-title]')?.textContent.includes('Four hundred')`);
  await page.evaluate(`(() => { const t=document.querySelector('[data-testid=timeline]'); t.scrollTop = t.scrollHeight - t.clientHeight - 1200; t.dispatchEvent(new Event('scroll')); })()`);
  await capture('mobile-long-reading.png');
  const visibleAnchor = `(() => { const t=document.querySelector('[data-testid=timeline]'); const top=t.getBoundingClientRect().top; const m=[...t.querySelectorAll('[data-mid]')].find(m=>m.getBoundingClientRect().bottom>top); return {id:m.dataset.mid,offset:m.getBoundingClientRect().top-top}; })()`;
  const anchor = await page.evaluate<{ id: string; offset: number }>(visibleAnchor);
  await page.click('[data-testid=mobile-conversations]');
  await page.click('[data-testid=mobile-list] .thread:not([data-testid=mobile-thread-t-long])');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]')`);
  await page.click('[data-testid=mobile-conversations]');
  await page.click('[data-testid=mobile-thread-t-long]');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]')`);
  await capture('mobile-long-restored.png');
  // Measurements can change the virtual spacer height without moving the text.
  // The visible message and its viewport offset define the reading position.
  const restoredAnchor = await page.evaluate<{ id: string; offset: number }>(visibleAnchor);
  expect(restoredAnchor.id).toBe(anchor.id);
  expect(Math.abs(restoredAnchor.offset - anchor.offset)).toBeLessThan(10);
}, 15_000);

test('a phone pins and archives a thread without a right-click, from the header and from the list', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent`);
  await page.waitFor(`document.querySelector('[data-testid=thread-menu-trigger]')?.offsetParent`);
  const id = await page.evaluate<string>('__boiteTest.workspace.active.openThread.id');
  const trigger = await page.evaluate<{ width: number; height: number }>(`(() => { const r = document.querySelector('[data-testid=thread-menu-trigger]').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
  expect(trigger.height).toBeGreaterThanOrEqual(44);
  // The owner's header holds five buttons; the title still gets the most room (5 characters before).
  expect(trigger.width).toBeGreaterThan(140);
  await page.click('[data-testid=thread-menu-trigger]');
  await page.waitFor(`document.querySelector('[data-testid=thread-menu-trigger-menu]')`);
  await capture('mobile-thread-menu.png');
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=pin]');
  await page.waitFor(`__boiteTest.workspace.active.openThread.pinned === true`);
  await page.click('[data-testid=mobile-conversations]');
  await page.click(`[data-testid=mobile-thread-menu-${id}]`);
  await page.waitFor(`document.querySelector('[data-testid=mobile-thread-menu-${id}-menu] [data-value=pin]')?.textContent.includes('Unpin')`);
  await capture('mobile-thread-row-menu.png');
  await page.click(`[data-testid=mobile-thread-menu-${id}-menu] [data-value=archive]`);
  await page.waitFor(`!document.querySelector('[data-testid=mobile-thread-${id}]')`);
  expect(page.errors()).toEqual([]);
}, 20_000);

test('Back returns from a conversation to the list and closes the context popup, the panel and the project picker first', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent`);
  await page.waitFor(`document.querySelector('[data-testid=thread-title]')`);
  const back = async (gone: string) => {
    await page.evaluate('history.back()');
    await page.waitFor(`!document.querySelector(${JSON.stringify(gone)})`);
    expect(await page.evaluate<string>('location.origin')).toBe(origin);
  };
  await page.click('[data-testid=mobile-conversations]');
  await page.click('[data-testid=mobile-list] .thread');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]') && document.querySelector('[data-testid=chat]')`);
  await page.click('[data-testid=context-trigger]');
  await page.waitFor(`document.querySelector('[data-testid=context-popup]')`);
  await back('[data-testid=context-popup]');
  await page.click('[data-testid=panel-toggle]');
  await page.waitFor(`document.querySelector('[data-testid=right-panel]')`);
  await back('[data-testid=right-panel]');
  // The project sheet pops its own entry while the picker pushes one.
  await page.click('[data-testid=mobile-project]');
  await page.click('[data-value="add-project"]');
  await page.waitFor(`document.querySelector('[data-testid=project-picker]')`);
  await Bun.sleep(400);
  await back('[data-testid=project-picker]');
  expect(await page.evaluate(`!!document.querySelector('[data-testid=chat]') && !document.querySelector('[data-testid=mobile-list]')`)).toBe(true);
  await page.evaluate('history.back()');
  await page.waitFor(`document.querySelector('[data-testid=mobile-list]')`);
  expect(await page.evaluate<string>('location.origin')).toBe(origin);
  // Closing the panel by its button pops its own entry: the next Back still reaches the list.
  await page.click('[data-testid=mobile-list] .thread');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]')`);
  await page.click('[data-testid=panel-toggle]');
  await page.click('[data-testid=panel-close]');
  await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);
  await Bun.sleep(300);
  await page.evaluate('history.back()');
  await page.waitFor(`document.querySelector('[data-testid=mobile-list]')`);
  expect(page.errors()).toEqual([]);
}, 30_000);
