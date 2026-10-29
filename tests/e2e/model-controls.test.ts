import { newMobileThread } from './lib/mobile.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
async function capture(name: string) {
  // A panel still sliding in when its conversation is left is no longer drawn, and its
  // `finished` never settles: settleAnimations skips what is not drawn.
  await page.settleAnimations();
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
async function resetPicker() {
  // Closing a phone sheet or widening it pops history asynchronously. Let that
  // traversal finish before navigating, or it can replace the requested load.
  if (await page.evaluate(`!!document.querySelector('[data-testid=composer-picker-menu]')`)) {
    await page.click('[data-testid=composer-picker]');
    await page.waitFor(`!document.querySelector('[data-testid=composer-picker-menu]')`);
  }
  if (await page.evaluate(`matchMedia('(max-width: 720px)').matches && !!document.querySelector('[data-testid=mobile-back]')`)) {
    await page.click('[data-testid=mobile-back]');
    await page.waitFor(`document.querySelector('[data-testid=mobile-tabs]')`);
  }
  await page.waitFor(`!history.state?.boiteOverlay`);
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(url);
}
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
  page = await BrowserPage.launch({ url });
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

test.each([1440, 390])('paired devices discover, refresh and select native models at %ipx', async width => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 });
  await page.navigate(`${url}&principal=session`);
  await page.waitFor(`globalThis.__boiteTest.workspace.active.booted`);
  expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.owner`)).toBe(false);
  expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.providerOf('claude').models.length`)).toBe(0);
  if (width < 720) await newMobileThread(page); else await page.click('[data-testid=new-thread]');
  await page.click('[data-testid=composer-picker]');
  for (const provider of ['claude', 'codex', 'opencode']) {
    await page.click(`[data-provider="${provider}"]`);
    await page.waitFor(`document.querySelector('[data-testid=composer-picker-menu] [data-model]') && !document.querySelector('[data-testid=picker-probing]')`);
    expect(await page.evaluate(`!!globalThis.__boiteTest.workspace.active.probedModels[${JSON.stringify(provider + '::')} + globalThis.__boiteTest.workspace.active.accountsOf(${JSON.stringify(provider)})[0].id]`)).toBe(true);
    await capture(`picker-paired-${provider}-${width}.png`);
  }
  await page.click('[data-provider=codex]');
  await page.click('[data-testid=picker-refresh]');
  await page.waitFor(`document.querySelector('[data-model="codex-demo"]') && !document.querySelector('[data-testid=picker-probing]')`);
  await page.type('[data-testid=picker-search]', 'unlisted-model');
  await page.waitFor(`document.querySelectorAll('[data-testid=picker-no-models]').length === 1`);
  await page.type('[data-testid=picker-search]', 'codex');
  await page.click('[data-model="codex-demo"]');
  await page.waitFor(`!document.querySelector('[data-testid=composer-picker-menu]')`);
  expect(await page.evaluate(`(() => {
    const choice = globalThis.__boiteTest.workspace.active.defaultChoice();
    return { providerId: choice?.providerId, model: choice?.model, effort: choice?.effort };
  })()`)).toEqual({ providerId: 'codex', model: 'codex-demo', effort: 'high' });
  expect(page.errors()).toEqual([]);
  await resetPicker();
}, 30_000);

test.each([1440, 390])('search finds legacy and OpenCode models without changing provider defaults at %ipx', async width => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: width < 720 });
  await page.navigate(url);
  if (width < 720) await newMobileThread(page); else await page.click('[data-testid=new-thread]');
  const defaults = await page.evaluate(`JSON.stringify(globalThis.__boiteTest.workspace.active.modelDefaults)`);
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=claude]');
  await page.waitFor(`document.querySelector('[data-testid=picker-search]') && document.querySelector('[data-testid=picker-legacy]')`);
  expect(await page.evaluate(`matchMedia('(pointer: coarse)').matches`)).toBe(width < 720);
  if (width < 720) expect(await page.evaluate(`document.activeElement !== document.querySelector('[data-testid=picker-search]')`)).toBe(true);
  await page.type('[data-testid=picker-search]', 'opus 4.8');
  await page.waitFor(`document.querySelector('[data-testid=composer-picker-menu] [data-model="claude-opus-4-8"]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=picker-legacy]') === null`)).toBe(true);
  await capture(`picker-search-legacy-${width}.png`);
  await page.click('[data-provider=opencode]');
  await page.waitFor(`document.querySelector('[data-model="openrouter/anthropic/claude-sonnet-4-5"]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=picker-search]').value`)).toBe('');
  await page.type('[data-testid=picker-search]', 'openrouter sonnet');
  await page.waitFor(`document.querySelectorAll('[data-testid=composer-picker-menu] [data-model]').length === 1`);
  await capture(`picker-search-opencode-${width}.png`);
  await page.click('[data-model="openrouter/anthropic/claude-sonnet-4-5"]');
  await page.waitFor(`!document.querySelector('[data-testid=composer-picker-menu]')`);
  expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.defaultChoice().model`)).toBe('openrouter/anthropic/claude-sonnet-4-5');
  expect(await page.evaluate(`JSON.stringify(globalThis.__boiteTest.workspace.active.modelDefaults)`)).toBe(defaults);
  await resetPicker();
}, 30_000);

test.each([1440, 390])('catalogs without legacy metadata keep new models in the main list at %ipx', async width => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 });
  await page.navigate(url);
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=claude]');
  await page.waitFor(`!document.querySelector('[data-testid=picker-probing]')`);
  await page.evaluate(`(() => {
    const s = globalThis.__boiteTest.workspace.active;
    const accountId = s.accountsOf('claude')[0].id;
    const models = s.modelsOf('claude', accountId).filter(model => !model.legacy);
    s.probedModels = {...s.probedModels, ['claude::' + accountId]: models};
  })()`);
  await page.waitFor(`!document.querySelector('[data-testid=picker-legacy]') && document.querySelector('[data-model="claude-fable-5-1"]')`);
  await page.evaluate(`(() => {
    const s = globalThis.__boiteTest.workspace.active;
    const accountId = s.accountsOf('claude')[0].id;
    const models = s.modelsOf('claude', accountId);
    const next = {...models.find(model => model.id === 'claude-fable-5-1'), id: 'claude-fable-6', name: 'Fable 6'};
    s.probedModels = {...s.probedModels, ['claude::' + accountId]: [...models, next]};
  })()`);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker-menu] [data-model="claude-fable-6"]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=picker-legacy]') === null`)).toBe(true);
  await capture(`picker-no-legacy-${width}.png`);
  await resetPicker();
}, 30_000);

test.each([1440, 390])('provider switching keeps the picker frame still at %ipx', async (width) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 });
  await page.navigate(url);
  await page.click('[data-testid=composer-picker]');
  const frames: { x: number; y: number; width: number; height: number }[] = [];
  // Only providers with a signed-in account have a tile; the fake's Antigravity is signed out.
  for (const provider of ['claude', 'echo', 'opencode', 'codex', 'favorites']) {
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
  await resetPicker();
}, 30_000);

test.each(['glass', 'grain'])('pointer clicks open and select models with %s', async (material) => {
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
  await page.evaluate(material === 'glass' ? `document.documentElement.dataset.glass = 'acrylic'` : `document.documentElement.dataset.theme = 'grain'`);
  async function pointerClick(selector: string) {
    await page.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    await page.settleAnimations();
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
  await pointerClick('[data-model=claude-sonnet-5-5]');
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
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.model-favorites.v2')).items.length`)).toBe(0);
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

test('the accent persists, the effort track glows brighter as it rises, and a speed sends streaks', async () => {
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=nav-settings]')`);
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-appearance]');
  await page.click('[data-testid=colors-customize]');
  await page.click('[data-testid=accent-300]');
  await capture('appearance-accent.png');
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
  expect(await page.evaluate(`document.documentElement.style.getPropertyValue('--accent-hue')`)).toBe('300');
  await page.click('[data-testid=composer-picker]');
  await page.click('[data-provider=claude]');
  await page.click('[data-model=claude-opus-5-5]');
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')?.textContent.includes('Opus')`);
  await page.click('[data-testid=composer-effort]');
  await page.waitFor(`document.querySelector('[data-testid=effort-speed]')`);
  await page.click('[data-value=low]');
  const glow = () => page.evaluate<{ fill: string; halo: number }>(`(() => { const style = getComputedStyle(document.querySelector('.progress')); return { fill: style.backgroundImage, halo: parseFloat(style.boxShadow.match(/(\\d+(?:\\.\\d+)?)px/g)?.at(-2) ?? '0') }; })()`);
  await page.settleAnimations();
  const low = await glow();
  await page.click('[data-value=max]');
  await page.settleAnimations();
  await capture('reasoning-accent-max.png');
  // The filled part lights up with the level: another fill and a wider halo at the top of the scale.
  const max = await glow();
  expect(max.fill).not.toBe(low.fill);
  expect(max.halo).toBeGreaterThan(low.halo + 8);
  const bounds = await page.evaluate<any>(`(() => { const p=document.querySelector('.progress').getBoundingClientRect(); const t=document.querySelector('.thumb').getBoundingClientRect(); return {edge:p.right,center:t.left+t.width/2}; })()`);
  expect(Math.abs(bounds.edge - bounds.center)).toBeLessThan(1);
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-effort-menu] .heading .level').textContent.trim()`)).toBe('Max');
  // The fast switch is the menu's one icon, at the top left of the slider.
  expect(await page.evaluate(`[...document.querySelectorAll('[data-testid=composer-effort-menu] svg')].every(svg => svg.closest('[data-testid=effort-speed]'))`)).toBe(true);
  expect(await page.evaluate(`(() => { const s=document.querySelector('[data-testid=effort-speed]').getBoundingClientRect(); const t=document.querySelector('[data-testid=effort-track]').getBoundingClientRect(); return s.bottom <= t.top && Math.abs(s.left - t.left) < 8; })()`)).toBe(true);
  expect(await page.evaluate(`!!document.querySelector('[data-testid=composer] .hint')`)).toBe(false);
  const speed = await page.evaluate<any>(`(() => { const r=document.querySelector('[data-testid=effort-speed]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await page.send('Input.dispatchMouseEvent', { type:'mouseMoved', ...speed });
  await page.waitFor(`getComputedStyle(document.querySelector('[data-testid=effort-speed] svg')).transform !== 'none'`);
  await capture('speed-hover.png');
  // Switching the speed on sends streaks across the popover, then they clear. A runner's own reduced-motion setting must not decide it.
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.click('[data-testid=effort-speed]');
  await page.waitFor(`document.querySelector('[data-testid=effort-streaks]')?.dataset.power === '1'`);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid=effort-streaks] .streak').length`)).toBe(12);
  await page.waitFor(`!document.querySelector('[data-testid=effort-streaks]')`);
  await page.click('[data-testid=effort-speed]');
  // Reduced motion switches the speed without them.
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.click('[data-testid=effort-speed]');
  await page.waitFor(`document.querySelector('[data-testid=effort-speed]').getAttribute('aria-pressed') === 'true'`);
  expect(await page.evaluate(`!!document.querySelector('[data-testid=effort-streaks]')`)).toBe(false);
  await page.click('[data-testid=effort-speed]');
  await page.send('Emulation.setEmulatedMedia', { features: [] });
  await page.send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-appearance]');
  await capture('appearance-accent-phone.png');
  await page.click('[data-testid=colors-customize]');
  await page.click('[data-testid=accent-260]');
  const overlay = await page.evaluate<string>('history.state?.boiteOverlay');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // The wide layout unmounts the phone panel, which pops its history entry. A navigation sent before
  // that back() lands is replaced by the old document, and the next test waits on a dead loader.
  await page.waitFor(`history.state?.boiteOverlay !== ${JSON.stringify(overlay)}`);
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
  await resetPicker();
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
  await page.waitFor(`document.querySelector('[data-model=claude-opus-5-5]')`);
  await page.click('[data-model=claude-opus-5-5]');
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
  for (const model of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
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
