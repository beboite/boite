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
  await server.listen(); url = `http://127.0.0.1:${port}/?fake=1`;
  page = await BrowserPage.launch({ url });
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
});
afterAll(async () => { await page?.close(); await server?.close(); });

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
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-picker-menu]').getBoundingClientRect().height`)).toBeLessThan(180);
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
  await page.send('Emulation.clearDeviceMetricsOverride', {});
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=context-compact]') && !document.querySelector('[data-testid=context-compact]').disabled`);
  await capture('context-compact-before.png');
  await page.click('[data-testid=context-compact]');
  await page.waitFor(`document.querySelector('[data-testid=compaction-part][data-trigger=manual]')`);
  await page.waitFor(`document.querySelector('[data-testid=context-meter]')?.title.includes('7,8k') || document.querySelector('[data-testid=context-meter]')?.title.includes('7.8k') || document.querySelector('[data-testid=context-meter]')?.title.includes('8k')`);
  await capture('context-compact-after.png');
  await page.click('[data-testid=composer-picker]');
  await page.waitFor(`document.querySelector('[data-testid=favorite-model]')`);
  await page.click('[aria-label="Remove from favorites"]');
  await page.waitFor(`document.querySelector('[data-testid=favorites-empty]')`);
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.model-favorites.v1')).length`)).toBe(0);
}, 30_000);


test('model picker opens below its trigger and scrolls long lists', async () => {
  await page.send('Emulation.clearDeviceMetricsOverride', {});
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=opencode]');
  await page.waitFor(`document.querySelectorAll('[data-model]').length > 12`);
  await capture('picker-scroll-desktop.png');
  const layout = await page.evaluate<any>(`(() => { const menu=document.querySelector('[data-testid=composer-picker-menu]'); const rows=menu.querySelector('.models'); const trigger=document.querySelector('[data-testid=composer-picker]').getBoundingClientRect(); const rect=menu.getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom,triggerBottom:trigger.bottom,height:innerHeight,scroll:rows.scrollHeight,client:rows.clientHeight,row:rows.querySelector('[data-model]').getBoundingClientRect().height}; })()`);
  expect(layout.top).toBeGreaterThanOrEqual(layout.triggerBottom);
  expect(layout.bottom).toBeLessThanOrEqual(layout.height);
  expect(layout.scroll).toBeGreaterThan(layout.client);
  expect(layout.row).toBeGreaterThanOrEqual(28);
  const wheel = await page.evaluate<any>(`(() => { const r=document.querySelector('[data-testid=composer-picker-menu] .models').getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type:'mouseWheel', ...wheel, deltaX:0, deltaY:180 });
  await page.waitFor(`document.querySelector('[data-testid=composer-picker-menu] .models').scrollTop > 0`);
  await page.click('[data-testid=picker-refresh]');
  expect(await page.evaluate(`document.querySelectorAll('[data-model]').length`)).toBeGreaterThan(12);
  await page.waitFor(`!document.querySelector('[data-testid=picker-refresh]').disabled`);
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-picker-menu] .models').scrollTop`)).toBeGreaterThan(0);
  await page.send('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:true });
  await capture('picker-scroll-phone.png');
  const phone = await page.evaluate<any>(`(() => { const r=document.querySelector('[data-testid=composer-picker-menu]').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom}; })()`);
  expect(phone.left).toBeGreaterThanOrEqual(0); expect(phone.right).toBeLessThanOrEqual(390);expect(phone.bottom).toBeLessThanOrEqual(844);
}, 30_000);


test('speed controls follow the selected model and Codex never offers Ultrathink', async () => {
  await page.send('Emulation.clearDeviceMetricsOverride', {});
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

test('the draft keeps a compact composer above a detached favorites menu', async () => {
  await page.send('Emulation.clearDeviceMetricsOverride', {});
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=new-thread]')`);
  await page.click('[data-testid=new-thread]');
  const before = await page.evaluate<number>(`document.querySelector('[data-testid=composer]').getBoundingClientRect().height`);
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=claude]');
  await page.waitFor(`document.querySelector('[data-favorite-model="claude-fable-5-1"]')`);
  for (const model of ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5']) {
    await page.click(`[data-favorite-model="${model}"]`);
  }
  await page.click('[data-provider=favorites]');
  await capture('picker-draft-favorites.png');
  const layout = await page.evaluate<any>(`(() => { const c=document.querySelector('[data-testid=composer]').getBoundingClientRect(); const m=document.querySelector('[data-testid=composer-picker-menu]').getBoundingClientRect(); return {composerHeight:c.height,composerBottom:c.bottom,menuTop:m.top,menuHeight:m.height}; })()`);
  expect(layout.composerHeight).toBe(before);
  expect(layout.menuTop).toBeGreaterThan(layout.composerBottom);
  expect(layout.menuHeight).toBeLessThan(260);
}, 30_000);
