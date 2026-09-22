import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserPage, freePort } from './lib/cdp.ts';
const uiRequire = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(uiRequire.resolve('vite'));
let server: { listen(): Promise<unknown>; close(): Promise<void> };
let page: BrowserPage;
let url: string;
async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
beforeAll(async () => {
  const port = await freePort();
  server = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  await server.listen(); url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
  page = await BrowserPage.launch({ url });
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test.each([1440, 390])('provider switching keeps the picker frame still at %ipx', async (width) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 });
  await page.navigate(url);
  await page.click('[data-testid=composer-picker]');
  const frames: { x: number; y: number; width: number; height: number }[] = [];
  for (const provider of ['claude', 'echo', 'opencode', 'antigravity', 'favorites']) {
    await page.click(`[data-provider="${provider}"]`);
    await capture(`picker-stable-${width}-${provider}.png`);
    frames.push(await page.evaluate<{ x: number; y: number; width: number; height: number }>(`document.querySelector('[data-testid=composer-picker-menu]').getBoundingClientRect().toJSON()`));
  }
  const firstFrame = frames[0]!;
  for (const frame of frames.slice(1)) {
    expect(frame.x).toBe(firstFrame.x);
    expect(frame.y).toBe(firstFrame.y);
    expect(frame.width).toBe(firstFrame.width);
    expect(frame.height).toBe(firstFrame.height);
  }
  expect(frames[0]!.x).toBeGreaterThanOrEqual(0);
  expect(frames[0]!.x + frames[0]!.width).toBeLessThanOrEqual(width);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(url);
}, 30_000);

test.each(['glass', 'grain'])('pointer clicks open and select models with %s', async (material) => {
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
  await page.evaluate(material === 'glass' ? `document.documentElement.dataset.glass = 'acrylic'` : `document.documentElement.dataset.theme = 'grain'`);
  async function pointerClick(selector: string) {
    await page.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
    const point = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  await pointerClick('[data-testid=composer-picker]');
  await capture(`picker-pointer-${material}.png`);
  const bounds = await page.evaluate<any>(`(() => { const r=document.querySelector('[data-testid=composer-picker-menu]').getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:innerHeight}; })()`);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  await pointerClick('[data-provider=claude]');
  await pointerClick('[data-testid=picker-legacy]');
  await pointerClick('[data-testid=picker-legacy-menu] [data-model]');
  await page.waitFor(`!document.querySelector('[data-testid=composer-picker-menu]')`);
  await pointerClick('[data-testid=composer-picker]');
  await pointerClick('[data-provider=claude]');
  await pointerClick('[data-model=claude-fable-5-1]');
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')?.textContent.includes('Fable')`);
  await capture('picker-pointer-selection.png');
  await pointerClick('[data-testid=new-thread]');
  await pointerClick('[data-testid=composer-picker]');
  await pointerClick('[data-provider=claude]');
  await pointerClick('[data-model=claude-sonnet-5]');
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')?.textContent.includes('Sonnet')`);
  await pointerClick('[data-testid=composer-picker]');
  await capture(`picker-pointer-draft-${material}.png`);
  await pointerClick('[data-testid=composer-picker]');
  await page.waitFor(`!document.querySelector('[data-testid=composer-picker-menu]')`);
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
}, 30_000);

test('favorites survive reload, reasoning has discrete stops, and the context ring compacts', async () => {
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=claude]');
  await page.waitFor(`document.querySelector('[data-favorite-model="claude-fable-5-1"]')`);
  await capture('models-ranked.png');
  await page.click('[data-favorite-model="claude-fable-5-1"]');
  await page.click('[data-provider=favorites]');
  await page.waitFor(`document.querySelectorAll('[data-testid=favorite-model]').length === 1`);
  await capture('models-favorites.png');
  expect(await page.evaluate(`document.querySelector('[data-testid=composer]').getBoundingClientRect().height`)).toBeLessThan(140);
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
  await page.click('[data-testid=composer-picker]');
  await page.waitFor(`document.querySelectorAll('[data-testid=favorite-model]').length === 1`);
  await page.click('[data-testid=favorite-model]');
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')?.textContent.includes('Fable')`);
  await page.click('[data-testid=composer-effort]');
  await page.waitFor(`document.querySelector('[data-testid=effort-track]')`);
  await page.evaluate(`document.querySelector('[data-testid=effort-track]').dispatchEvent(new KeyboardEvent('keydown', { key:'End', bubbles:true }))`);
  await page.waitFor(`document.querySelector('[data-testid=effort-track]')?.getAttribute('aria-valuenow') === '5'`);
  await capture('reasoning-notches.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('reasoning-phone.png');
  const bounds = await page.evaluate<{ left: number; right: number }>(`(() => { const r = document.querySelector('[data-testid=composer-effort-menu]').getBoundingClientRect(); return { left:r.left, right:r.right }; })()`);
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(390);
  await page.evaluate(`document.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }))`);
  await page.click('[data-testid=composer-picker]');
  await page.waitFor(`document.querySelector('[data-testid=favorite-model]')`);
  await capture('favorites-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=context-trigger]')`);
  await page.click('[data-testid=context-trigger]');
  await page.waitFor(`document.querySelector('[data-testid=context-compact]') && !document.querySelector('[data-testid=context-compact]').disabled`);
  await capture('context-compact-before.png');
  await page.click('[data-testid=context-compact]');
  await page.waitFor(`document.querySelector('[data-testid=compaction-part][data-trigger=manual]')`);
  await page.waitFor(`document.querySelector('[data-testid=context-meter]')?.dataset.percent === '4'`);
  await capture('context-compact-after.png');
  await page.click('[data-testid=composer-picker]');
  await page.waitFor(`document.querySelector('[data-testid=favorite-model]')`);
  await page.click('[aria-label="Remove from favorites"]');
  await page.waitFor(`document.querySelector('[data-testid=favorites-empty]')`);
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.model-favorites.v1')).length`)).toBe(0);
}, 30_000);

test('legacy models open beside the picker and preserve the page position', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
  const before = await page.evaluate<number>(`document.querySelector('[data-testid=composer]').getBoundingClientRect().top`);
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=claude]');
  await page.click('[data-testid=picker-legacy]');
  await page.waitFor(`document.querySelector('[data-testid=picker-legacy-menu] [data-model]')`);
  await capture('picker-legacy-submenu.png');
  await page.evaluate(`Array.from(document.querySelectorAll('[data-testid=picker-legacy-menu] [data-row]')).at(-1).focus()`);
  await page.send('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  expect(await page.evaluate(`document.activeElement === document.querySelector('[data-testid=picker-legacy-menu] [data-row]')`)).toBe(true);
  await page.send('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
  expect(await page.evaluate(`document.activeElement === Array.from(document.querySelectorAll('[data-testid=picker-legacy-menu] [data-row]')).at(-1)`)).toBe(true);
  const layout = await page.evaluate<any>(`(() => { const p=document.querySelector('[data-testid=composer-picker-menu]').getBoundingClientRect(); const l=document.querySelector('[data-testid=picker-legacy-menu]').getBoundingClientRect(); return {right:p.right,left:l.left}; })()`);
  expect(layout.left).toBeGreaterThan(layout.right);
  expect(await page.evaluate(`document.querySelector('[data-testid=composer]').getBoundingClientRect().top`)).toBe(before);
  await page.click('[data-testid=picker-legacy-menu] [data-model]');
  await page.waitFor(`!document.querySelector('[data-testid=composer-picker-menu]')`);
  expect(await page.evaluate(`!!document.querySelector('[data-testid=picker-legacy-menu]')`)).toBe(false);
}, 30_000);

test('the accent persists and colours the effort track continuously to the thumb', async () => {
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=nav-settings]')`);
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-appearance]');
  await page.click('[data-testid=accent-300]');
  await capture('appearance-accent.png');
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
  expect(await page.evaluate(`document.documentElement.style.getPropertyValue('--accent-hue')`)).toBe('300');
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=claude]');
  await page.click('[data-model=claude-opus-5]');
  await page.waitFor(`document.querySelector('[data-testid=effort-speed]')`);
  await page.click('[data-testid=composer-effort]');
  await page.click('[data-value=low]');
  const low = await page.evaluate(`getComputedStyle(document.querySelector('.progress')).backgroundColor`);
  await page.click('[data-value=max]');
  await capture('reasoning-accent-max.png');
  expect(await page.evaluate(`getComputedStyle(document.querySelector('.progress')).backgroundColor`)).not.toBe(low);
  const bounds = await page.evaluate<any>(`(() => { const p=document.querySelector('.progress').getBoundingClientRect(); const t=document.querySelector('.thumb').getBoundingClientRect(); return {edge:p.right,center:t.left+t.width/2}; })()`);
  expect(Math.abs(bounds.edge - bounds.center)).toBeLessThan(1);
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-effort-menu] .heading').textContent.trim()`)).toBe('Max');
  expect(await page.evaluate(`!!document.querySelector('[data-testid=composer-effort-menu] svg')`)).toBe(false);
  expect(await page.evaluate(`!!document.querySelector('[data-testid=composer] .hint')`)).toBe(false);
  const speed = await page.evaluate<any>(`(() => { const r=document.querySelector('[data-testid=effort-speed]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await page.send('Input.dispatchMouseEvent', { type:'mouseMoved', ...speed });
  await page.waitFor(`getComputedStyle(document.querySelector('[data-testid=effort-speed] svg')).transform !== 'none'`);
  await capture('speed-hover.png');
  await page.send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-appearance]');
  await capture('appearance-accent-phone.png');
  await page.click('[data-testid=accent-260]');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
}, 30_000);


test('model picker flips upward without moving the composer and scrolls long lists', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=opencode]');
  await page.waitFor(`document.querySelectorAll('[data-model]').length > 12`);
  await capture('picker-scroll-desktop.png');
  const layout = await page.evaluate<any>(`(() => { const menu=document.querySelector('[data-testid=composer-picker-menu]'); const rows=menu.querySelector('.model-list'); const trigger=document.querySelector('[data-testid=composer-picker]').getBoundingClientRect(); const rect=menu.getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom,triggerBottom:trigger.bottom,height:innerHeight,scroll:rows.scrollHeight,client:rows.clientHeight,row:rows.querySelector('[data-model]').getBoundingClientRect().height}; })()`);
  expect(layout.bottom).toBeLessThan(layout.triggerBottom);
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-picker-menu]').dataset.direction`)).toBe('up');
  expect(layout.bottom).toBeLessThanOrEqual(layout.height);
  expect(layout.scroll).toBeGreaterThan(layout.client);
  expect(layout.row).toBeGreaterThanOrEqual(28);
  const wheel = await page.evaluate<any>(`(() => { const r=document.querySelector('[data-testid=composer-picker-menu] .model-list').getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type:'mouseWheel', ...wheel, deltaX:0, deltaY:180 });
  await page.waitFor(`document.querySelector('[data-testid=composer-picker-menu] .model-list').scrollTop > 0`);
  await page.click('[data-testid=picker-refresh]');
  expect(await page.evaluate(`document.querySelectorAll('[data-model]').length`)).toBeGreaterThan(12);
  await page.waitFor(`!document.querySelector('[data-testid=picker-refresh]').disabled`);
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-picker-menu] .model-list').scrollTop`)).toBeGreaterThan(0);
  await page.send('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:true });
  await capture('picker-scroll-phone.png');
  const phone = await page.evaluate<any>(`(() => { const r=document.querySelector('[data-testid=composer-picker-menu]').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom}; })()`);
  expect(phone.left).toBeGreaterThanOrEqual(0); expect(phone.right).toBeLessThanOrEqual(390);expect(phone.bottom).toBeLessThanOrEqual(844);
}, 30_000);


test('speed controls follow the selected model and Codex never offers Ultrathink', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=codex]');
  await page.waitFor(`document.querySelector('[data-model=codex-demo]')`);
  await page.click('[data-model=codex-demo]');
  await page.waitFor(`document.querySelector('[data-testid=composer-effort]')`);
  await page.click('[data-testid=composer-effort]');
  await page.waitFor(`document.querySelector('[data-testid=effort-speed]')`);
  expect(await page.evaluate(`!!document.querySelector('[data-value=ultrathink]')`)).toBe(false);
  await page.click('[data-testid=effort-speed]');
  await page.waitFor(`document.querySelector('[data-testid=effort-speed-label]')?.textContent === 'Fast'`);
  await page.click('[data-testid=effort-speed]');
  await page.waitFor(`document.querySelector('[data-testid=effort-speed-label]')?.textContent === 'Ultrafast'`);
  await capture('reasoning-codex-ultrafast.png');
  await page.click('[data-testid=effort-speed]');
  await page.waitFor(`!document.querySelector('[data-testid=effort-speed-label]')`);
  await page.evaluate(`document.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }))`);
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=claude]');
  await page.waitFor(`document.querySelector('[data-model=claude-opus-5]')`);
  await page.click('[data-model=claude-opus-5]');
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')?.textContent.includes('Opus')`);
  await page.click('[data-testid=composer-effort]');
  await page.waitFor(`document.querySelector('[data-value=ultrathink]')`);
  await page.click('[data-testid=effort-speed]');
  await page.waitFor(`document.querySelector('[data-testid=effort-speed-label]')?.textContent === 'Fast'`);
  await capture('reasoning-claude-fast.png');
  await page.evaluate(`document.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }))`);
  await page.click('[data-testid=composer-picker]'); await page.click('[data-provider=echo]'); await page.click('[data-model=echo-1]');
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')?.textContent.includes('Echo')`);
  await page.click('[data-testid=composer-effort]');
  await page.waitFor(`document.querySelector('[data-testid=composer-effort-menu]')`);
  expect(await page.evaluate(`!!document.querySelector('[data-testid=effort-speed]')`)).toBe(false);
}, 30_000);

test('the draft keeps a compact composer separate from the fixed favorites menu', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=new-thread]')`);
  await page.click('[data-testid=new-thread]');
  const before = await page.evaluate<any>(`(() => { const r=document.querySelector('[data-testid=composer]').getBoundingClientRect(); return {height:r.height,top:r.top}; })()`);
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=claude]');
  await page.waitFor(`document.querySelector('[data-favorite-model="claude-fable-5-1"]')`);
  for (const model of ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5']) {
    await page.click(`[data-favorite-model="${model}"]`);
  }
  await page.click('[data-provider=favorites]');
  await capture('picker-draft-favorites.png');
  const layout = await page.evaluate<any>(`(() => { const c=document.querySelector('[data-testid=composer]').getBoundingClientRect(); const m=document.querySelector('[data-testid=composer-picker-menu]').getBoundingClientRect(); return {composerHeight:c.height,composerTop:c.top,composerBottom:c.bottom,menuTop:m.top,menuHeight:m.height}; })()`);
  expect(layout.composerHeight).toBe(before.height);
  expect(layout.composerTop).toBe(before.top);
  expect(layout.menuTop + layout.menuHeight).toBeLessThan(layout.composerTop);
  expect(layout.menuHeight).toBe(360);
}, 30_000);
