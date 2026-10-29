import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { mobileAction, newMobileThread as newThreadFromList, openMobilePanel, screensSettled } from './lib/mobile.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
async function navigateMobile(destination: string) {
  await mobileAction(page, destination);
}
async function newMobileThread() {
  await newThreadFromList(page);
}
async function capture(name: string) {
  const settled = await page.evaluate<{ timedOut: boolean; fonts: FontFaceSetLoadStatus; animations: Array<{ playState: AnimationPlayState; currentTime: number | null; endTime: number }> }>(`(async () => {
    // Skipped content (the chat behind the list) advances no animation until it shows again: nothing of it is on screen.
    const animations = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity
      && (!(animation.effect instanceof KeyframeEffect) || animation.effect.target?.checkVisibility?.({ contentVisibilityAuto: true }) !== false));
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
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent&machines=1`, experiments: ['resident-agents'] });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid=mobile-header]')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

test('phone settings expose browser profiles and allowed windows only to owners and keep remote administration hidden', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await navigateMobile('mobile-settings');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')`);
  const rows = `[...document.querySelectorAll('[data-testid=mobile-settings-home] .row')].map(row => row.dataset.testid)`;
  const expected = ['mobile-settings-phone', 'settings-tab-appearance', 'mobile-settings-privacy', 'settings-tab-experiments', 'mobile-settings-connection', 'settings-tab-usage', 'settings-tab-voice', 'mobile-settings-browser-profiles', 'mobile-settings-compaction', 'mobile-settings-windows', 'mobile-settings-archived', 'mobile-settings-secrets'];
  expect(await page.evaluate<string[]>(rows)).toEqual(expected);
  expect(await page.evaluate(`document.querySelector('[data-testid=settings-tab-resources]') === null && document.querySelector('[data-testid=settings-tab-keyboard]') === null`)).toBe(true);
  await page.evaluate(`(() => { const store=__boiteTest.workspace.active; store.client.becomes('session'); store.principal='session'; })()`);
  await page.waitFor(`__boiteTest.workspace.active.owner === false`);
  expect(await page.evaluate<string[]>(rows)).toEqual(expected.filter(row => row !== 'mobile-settings-browser-profiles' && row !== 'mobile-settings-compaction' && row !== 'mobile-settings-windows'));
  await page.evaluate(`(() => { const store=__boiteTest.workspace.active; store.client.becomes('owner'); store.principal='owner'; })()`);
  await page.waitFor(`__boiteTest.workspace.active.owner === true`);
  expect(await page.evaluate<string[]>(rows)).toEqual(expected);
  await page.click('[data-testid=mobile-settings-compaction]');
  await page.waitFor(`document.querySelector('[data-testid=compaction-target-common]')`);
  for (const type of ['common', 'agent', 'subagent', 'bot']) {
    await page.click(`[data-testid=compaction-target-${type}]`);
    await page.waitFor(`document.querySelector('[data-testid=compaction-target-${type}]')?.getAttribute('aria-pressed') === 'true'`);
  }
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.click('[data-testid=mobile-settings-back]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')`);
  await capture('phone-settings-home-dark.png');
  await page.click('[data-testid=mobile-settings-phone]');
  await page.waitFor(`document.querySelector('[data-testid=phone-settings]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=phone-public-url]') === null && document.querySelector('[data-testid=group-add-device]') === null`)).toBe(true);
  await capture('phone-settings-notifications.png');
  await page.evaluate('history.back()');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')`);
  await page.click('[data-testid=mobile-settings-connection]');
  await page.waitFor(`document.querySelector('[data-testid=group-card]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=browser-origins]') === null`)).toBe(true);
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
  await navigateMobile('mobile-conversations');
  await page.waitFor(`document.querySelector('[data-testid=mobile-list] .thread')`);
  const header = await page.evaluate<{ top: number; height: number }>(`(() => { const r = document.querySelector('[data-testid=mobile-header]').getBoundingClientRect(); return {top:r.top,height:r.height}; })()`);
  expect(header.top).toBeGreaterThanOrEqual(0);
  expect(header.height).toBeGreaterThanOrEqual(44);
  // The list stands between its header and the bottom bar, which keeps clear of the home indicator.
  const bar = await page.evaluate<{ top: number; bottom: number; list: number }>(`(() => { const r = document.querySelector('[data-testid=mobile-tabs]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, list: document.querySelector('[data-testid=mobile-list]').getBoundingClientRect().bottom }; })()`);
  expect(bar.bottom).toBe(844);
  expect(bar.list).toBeLessThanOrEqual(bar.top);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  // Each row names its provider, and a worktree thread its branch after the project.
  expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid=mobile-list] .thread')).every(row => row.querySelector('[data-testid=thread-provider]'))`)).toBe(true);
  expect(await page.evaluate<string>(`document.querySelector('[data-testid=mobile-thread-t-trace] .detail').textContent`)).toContain('boite/trace');
  await capture('mobile-conversations.png');
  await page.click('[data-testid=mobile-list] .thread');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]') && document.querySelector('[data-testid=chat]')`);
  await capture('mobile-chat.png');
  // A conversation is pushed over the list: the bar steps aside for its composer.
  expect(await page.evaluate(`document.querySelector('[data-testid=mobile-tabs]') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid=mobile-header]').getBoundingClientRect().bottom <= document.querySelector('[data-testid=timeline]').getBoundingClientRect().top`)).toBe(true);
  await navigateMobile('mobile-activity');
  await page.waitFor(`document.querySelector('[data-testid=mobile-header] strong')?.textContent === 'Activity' && !document.querySelector('[data-testid=mobile-list] h1')`);
  await capture('mobile-activity.png');
  await navigateMobile('mobile-settings');
  await page.waitFor(`document.querySelector('[data-testid=settings]')`);
  await navigateMobile('mobile-conversations');
  await newMobileThread();
  await page.waitFor(`document.querySelector('[data-testid=composer]') && !document.querySelector('[data-testid=settings]')`);
  expect(page.errors()).toEqual([]);
}, 30_000);

test('draft survives navigation and the light phone layout fits landscape', async () => {
  await page.evaluate(`(() => { const t = document.querySelector('[data-testid=composer-input]'); t.value = 'Keep this draft'; t.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await navigateMobile('mobile-conversations');
  // A new thread opens a draft of its own; the written one waits in the list and comes back from its row.
  const draftRow = `[...document.querySelectorAll('[data-testid=draft-row]')].find(row => row.title === 'Keep this draft')`;
  await page.waitFor(`!!${draftRow}`);
  await page.click('[data-testid=mobile-tabs] [data-testid=mobile-new]');
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-input]').value`)).toBe('');
  await navigateMobile('mobile-conversations');
  await page.waitFor(`!!${draftRow}`);
  await page.evaluate(`${draftRow}.click()`);
  await page.waitFor(`document.querySelector('[data-testid=composer-input]')?.value === 'Keep this draft'`);
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 390, deviceScaleFactor: 1, mobile: true });
  await capture('mobile-landscape.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  const bounds = await page.evaluate<any>(`(() => { const r = document.querySelector('[data-testid=composer-input]').getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()`);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(390);
}, 15_000);

test('the phone header and composer stay visible when keyboard focus scrolls the document', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid=composer-input]')`);
  try {
    await page.evaluate(`(() => {
      // Reproduce Safari's root scroll separately from the chat's own scroller.
      document.documentElement.style.overflow = 'auto'; document.body.style.overflow = 'visible';
      const spacer = document.createElement('div'); spacer.style.height = '1200px'; document.body.append(spacer);
      const input = document.querySelector('[data-testid=composer-input]');
      input.value = 'Keep this keyboard draft'; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
      Object.defineProperty(visualViewport, 'height', { configurable: true, value: 450 });
      Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 0 });
      visualViewport.dispatchEvent(new Event('resize')); window.scrollTo(0, 140);
    })()`);
    await page.waitFor(`scrollY >= 140 && document.documentElement.dataset.keyboard === 'open'`);
    const bounds = await page.evaluate<{ top: number; bottom: number }>(`({ top: document.querySelector('[data-testid=mobile-header]').getBoundingClientRect().top, bottom: document.querySelector('[data-testid=composer]').getBoundingClientRect().bottom })`);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(450);
    expect(bounds.bottom).toBeGreaterThan(350);
    expect(await page.evaluate(`!!document.querySelector('[data-testid=mobile-tabs]')`)).toBe(false);
    await capture('mobile-keyboard-root-scroll.png');
    await page.evaluate(`(() => {
      delete visualViewport.height; delete visualViewport.offsetTop;
      document.querySelector('[data-testid=composer-input]').blur();
      visualViewport.dispatchEvent(new Event('resize'));
    })()`);
    await page.waitFor(`document.documentElement.dataset.keyboard === 'closed'`);
    expect(await page.evaluate(`document.querySelector('[data-testid=mobile-header]').getBoundingClientRect().top`)).toBe(0);
    expect(await page.evaluate(`document.querySelector('[data-testid=composer-input]').value`)).toBe('Keep this keyboard draft');
  } finally {
    await page.navigate(`${origin}/?fake=1&open=recent`);
  }
}, 20_000);

test('model sheets stay on screen and browser Back closes the sheet without losing the draft', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await newMobileThread();
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
  // An open phone sheet becomes an anchored desktop menu when the window grows.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await page.waitFor('innerWidth === 1440');
  const desktop = await page.evaluate<number>(`document.querySelector('[data-testid=composer-picker-menu]').getBoundingClientRect().width`);
  expect(desktop).toBeLessThanOrEqual(440);
  expect(await page.evaluate(`document.querySelector('.mobile-sheet-backdrop') === null`)).toBe(true);
  await capture('model-menu-resized-desktop.png');
  // Narrowing again restores the sheet, its backdrop and browser Back handling.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  // Becoming a sheet again, it rises from the bottom edge: the tap goes where it stops.
  await page.waitFor(`document.querySelector('[data-testid=composer-picker-menu]')?.dataset.mobileSheet === 'true' && ${screensSettled}`);
  const search = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-testid=picker-search]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...search, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...search, button: 'left', clickCount: 1 });
  expect(await page.evaluate(`document.activeElement === document.querySelector('[data-testid=picker-search]')`)).toBe(true);
  expect(await page.evaluate(`document.querySelectorAll('.mobile-sheet-backdrop').length`)).toBe(1);
  await capture('model-menu-resized-phone.png');
  await page.evaluate('history.back()');
  await page.waitFor(`!document.querySelector('[data-testid=composer-picker-menu]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-input]').value`)).toBe('Keep this draft');
  await navigateMobile('mobile-settings');
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
  await navigateMobile('mobile-conversations');
  await page.click('[data-testid=mobile-list] .thread:not([data-testid=mobile-thread-t-long])');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]')`);
  await navigateMobile('mobile-conversations');
  await page.click('[data-testid=mobile-thread-t-long]');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]')`);
  await capture('mobile-long-restored.png');
  // Measurements can change the virtual spacer height without moving the text.
  // The visible message and its viewport offset define the reading position.
  const restoredAnchor = await page.evaluate<{ id: string; offset: number }>(visibleAnchor);
  expect(restoredAnchor.id).toBe(anchor.id);
  expect(Math.abs(restoredAnchor.offset - anchor.offset)).toBeLessThan(10);
}, 15_000);

test('leaving a long conversation right after a scroll returns to that scroll', async () => {
  // Hold the new rows' measurements until navigation starts, as a loaded
  // runner does. Their estimates must not replace the message being read.
  const origin = await page.evaluate<string>('location.origin');
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const Native = ResizeObserver;
    globalThis.__pendingMeasurements = [];
    globalThis.ResizeObserver = class extends Native {
      constructor(callback) { super((entries, observer) => {
        if (globalThis.__holdMeasurements) __pendingMeasurements.push(() => callback(entries, observer));
        else callback(entries, observer);
      }); }
    };
  })()` }) as { identifier: string };
  try { await page.navigate(`${origin}/?fake=1&open=recent&long=1`); }
  finally { await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
  await page.waitFor(`document.querySelector('[data-testid=thread-title]')?.textContent.includes('Four hundred')`);
  await page.settleAnimations();
  await page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
  await page.evaluate(`(() => { globalThis.__holdMeasurements = true; const t=document.querySelector('[data-testid=timeline]'); t.scrollTop = t.scrollHeight - t.clientHeight - 1200; t.dispatchEvent(new Event('scroll')); })()`);
  await page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
  const visibleAnchor = `(() => { const t=document.querySelector('[data-testid=timeline]'); const top=t.getBoundingClientRect().top; const m=[...t.querySelectorAll('[data-mid]')].find(m=>m.getBoundingClientRect().bottom>top); return {id:m.dataset.mid,offset:m.getBoundingClientRect().top-top}; })()`;
  const anchor = await page.evaluate<{ id: string; offset: number }>(visibleAnchor);
  await navigateMobile('mobile-conversations');
  await page.evaluate(`(() => { globalThis.__holdMeasurements = false; globalThis.__pendingMeasurements.splice(0).forEach(deliver => deliver()); })()`);
  await page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
  await page.click('[data-testid=mobile-list] .thread:not([data-testid=mobile-thread-t-long])');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]')`);
  const savedAnchor = await page.evaluate<{ id: string; offset: number }>(`globalThis.__boiteTest.workspace.active.readingPositions.get('t-long').anchor`);
  expect(savedAnchor.id).toBe(anchor.id);
  expect(Math.abs(savedAnchor.offset - anchor.offset)).toBeLessThan(1);
  await navigateMobile('mobile-conversations');
  await page.click('[data-testid=mobile-thread-t-long]');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]')`);
  // Returning mounts the list before ResizeObserver restores its reading anchor.
  // Keep the immediate departure above, but wait for restoration before measuring it.
  await page.waitFor(`document.querySelector('[data-mid="${anchor.id}"]') && (() => {
    const restored = ${visibleAnchor};
    return restored.id === ${JSON.stringify(anchor.id)} && Math.abs(restored.offset - ${anchor.offset}) < 10;
  })()`, 5_000);
  const restoredAnchor = await page.evaluate<{ id: string; offset: number }>(visibleAnchor);
  expect(restoredAnchor.id).toBe(anchor.id);
  expect(Math.abs(restoredAnchor.offset - anchor.offset)).toBeLessThan(10);
}, 15_000);

test('a markdown table wraps its text and scrolls inside itself only for what cannot break', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent`);
  const prose = '| Idea | What it changes |\n|---|---|\n| Chart block | The agent writes a few lines of data straight into its answer and Boite draws the chart the way it draws a diagram, so nobody pans sideways to read it |';
  const table = '| File | Status | Lines | Owner | Notes |\n|---|---|---|---|---|\n| packages/ui/src/components/ThreadHeader.svelte | modified | 229 | ui | header row on phones |';
  await page.type('[data-testid=composer-input]', `${prose}\n\n${table}`);
  await page.evaluate(`document.querySelector('[data-testid=composer-input]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await page.waitFor(`document.querySelectorAll('[data-testid=timeline] table')[1]?.textContent.includes('header row on phones')`, 20_000);
  await page.evaluate(`document.querySelectorAll('[data-testid=timeline] table')[1].scrollIntoView({ block: 'center', inline: 'end' })`);
  const sizes = await page.evaluate<{ timeline: [number, number, number]; prose: [number, number]; table: [number, number]; split: string[] }>(`(() => {
    const t = document.querySelector('[data-testid=timeline]'), [prose, table] = t.querySelectorAll('table');
    // A word drawn on more than one line box was split to narrow its column.
    const split = [...prose.querySelectorAll('th, td')].flatMap(cell => {
      const text = cell.firstChild, range = document.createRange();
      return [...text.data.matchAll(/\\S+/g)].filter(word => {
        range.setStart(text, word.index);
        range.setEnd(text, word.index + word[0].length);
        return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size > 1;
      }).map(word => word[0]);
    });
    return { timeline: [t.scrollWidth, t.clientWidth, t.scrollLeft], prose: [prose.scrollWidth, prose.clientWidth], table: [table.scrollWidth, table.clientWidth], split };
  })()`);
  await capture('mobile-table.png');
  expect(sizes.timeline[0]).toBeLessThanOrEqual(sizes.timeline[1]);
  expect(sizes.timeline[2]).toBe(0);
  // A sentence wraps inside its cell, at spaces: the whole row is read without panning.
  expect(sizes.prose[0]).toBeLessThanOrEqual(sizes.prose[1]);
  expect(sizes.split).toEqual([]);
  // The table itself holds what did not fit.
  expect(sizes.table[0]).toBeGreaterThan(sizes.table[1]);
}, 30_000);

test('the panel sheet, Agents and Settings keep clear of a notch and the status bar', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent`);
  await page.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
  try {
    const top = (selector: string) => page.evaluate<number>(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top`);
    await openMobilePanel(page);
    await page.waitFor(`document.querySelector('[data-testid=panel-close]')`);
    expect(await top('[data-testid=right-panel] header')).toBeGreaterThanOrEqual(47);
    await capture('mobile-safe-panel.png');
    await page.click('[data-testid=panel-close]');
    await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);
    await navigateMobile('mobile-agents');
    // The agents list opens on its tools row, the row nearest the notch: the menu holds Threads and Agents.
    await page.waitFor(`document.querySelector('.agents-rail .rail-head')`);
    expect(await top('.agents-rail .rail-head')).toBeGreaterThanOrEqual(47);
    await capture('mobile-safe-agents.png');
    await navigateMobile('mobile-settings');
    await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home] h2')`);
    expect(await top('[data-testid=mobile-settings-home] h2')).toBeGreaterThanOrEqual(47);
    await capture('mobile-safe-settings.png');
  } finally {
    await page.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  }
}, 30_000);

test('the connect sheet keeps its last button above the home indicator', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&uninstalled=1`);
  await page.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
  try {
    await page.waitFor(`document.querySelector('[data-testid=composer-connect], [data-testid=mobile-new]')`);
    if (!(await page.evaluate<boolean>(`!!document.querySelector('[data-testid=composer-connect]')`))) await newMobileThread();
    await page.click('[data-testid=composer-connect]');
    await page.click('[data-testid=connect-service][data-provider=claude]');
    await page.click('[data-testid=connect-install]');
    await page.waitFor(`document.querySelector('[data-testid=connect-step]')?.dataset.step === 'installing'`);
    const bottom = await page.evaluate<number>(`[...document.querySelectorAll('[data-testid=connect-step] > *')].at(-1).getBoundingClientRect().bottom`);
    await capture('mobile-connect-safe.png');
    expect(bottom).toBeLessThanOrEqual(await page.evaluate<number>('innerHeight') - 34);
  } finally {
    await page.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  }
}, 30_000);

test('Appearance in French at 360 px keeps every label beside its choices readable', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  try {
    await navigateMobile('mobile-settings');
    await page.click('[data-testid=settings-tab-appearance]');
    await page.click('[data-testid=locale-fr]');
    await page.waitFor(`document.querySelector('[data-testid=appearance-page] h1')?.textContent.includes('Apparence')`);
    const rows = await page.evaluate<Array<{ text: string; clipped: boolean; overlap: boolean; narrow: boolean }>>(`[...document.querySelectorAll('[data-testid=appearance-page] .switch-row')].filter(row => row.querySelector('.segmented')).map(row => {
      const text = row.querySelector('.text'), t = text.getBoundingClientRect(), s = row.querySelector('.segmented').getBoundingClientRect();
      return { text: text.textContent.trim(), clipped: text.scrollWidth > text.clientWidth + 1, overlap: t.right > s.left + 1 && t.left < s.right - 1 && t.bottom > s.top + 1 && t.top < s.bottom - 1, narrow: t.width < 120 };
    })`);
    // The workspace and terminal rows are the desktop's: language, theme and the code face remain.
    await page.evaluate(`document.querySelector('[data-testid^=font-mono-]').scrollIntoView({ block: 'center' })`);
    await capture('mobile-appearance-fr-360.png');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.filter(row => row.clipped || row.overlap || row.narrow)).toEqual([]);
    expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  } finally {
    await page.click('[data-testid=locale-en]');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  }
}, 30_000);

test('a phone pins and archives a thread without a right-click, from the header and from the list', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent`);
  await page.waitFor(`document.querySelector('[data-testid=thread-menu-trigger]')?.offsetParent`);
  const id = await page.evaluate<string>('__boiteTest.workspace.active.openThread.id');
  const trigger = await page.evaluate<{ width: number; height: number }>(`(() => { const r = document.querySelector('[data-testid=thread-menu-trigger]').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
  expect(trigger.height).toBeGreaterThanOrEqual(44);
  // The header is Back and this one menu: no panel, terminal or navigation button beside the title.
  expect(trigger.width).toBeGreaterThanOrEqual(100);
  expect(await page.evaluate(`['terminal-toggle', 'panel-toggle'].map(id => document.querySelector('[data-testid=' + id + ']')?.offsetParent ?? null)`)).toEqual([null, null]);
  expect(await page.evaluate(`document.querySelector('[data-testid=mobile-tabs]')`)).toBeNull();
  await page.click('[data-testid=thread-menu-trigger]');
  await page.waitFor(`document.querySelector('[data-testid=thread-menu-trigger-menu]')`);
  // Subagents shows only on a thread that has some; the desktop's other rows stay there.
  expect(await page.evaluate(`[...document.querySelectorAll('[data-testid=thread-menu-trigger-menu] [data-value]')].map(row => row.dataset.value)`)).toEqual(['panel', 'pin', 'rename', 'find', 'archive', 'delete']);
  await capture('mobile-thread-menu.png');
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=panel]');
  await page.waitFor(`document.querySelector('[data-testid=right-panel]')`);
  await page.click('[data-testid=panel-close]');
  await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);
  await page.click('[data-testid=thread-menu-trigger]');
  await page.waitFor(`document.querySelector('[data-testid=thread-menu-trigger-menu]')`);
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=pin]');
  await page.waitFor(`__boiteTest.workspace.active.openThread.pinned === true`);
  await navigateMobile('mobile-conversations');
  await page.click(`[data-testid=mobile-thread-menu-${id}]`);
  await page.waitFor(`document.querySelector('[data-testid=mobile-thread-menu-${id}-menu] [data-value=pin]')?.textContent.includes('Unpin')`);
  await capture('mobile-thread-row-menu.png');
  await page.click(`[data-testid=mobile-thread-menu-${id}-menu] [data-value=archive]`);
  await page.waitFor(`!document.querySelector('[data-testid=mobile-thread-${id}]')`);
  expect(page.errors()).toEqual([]);
}, 20_000);

test('a paired phone deletes a thread from its list and the toast offers undo', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent&principal=session`);
  await page.waitFor(`document.querySelector('[data-testid=thread-menu-trigger]')?.offsetParent`);
  expect(await page.evaluate('__boiteTest.workspace.active.owner')).toBe(false);
  const id = await page.evaluate<string>('__boiteTest.workspace.active.openThread.id');
  await navigateMobile('mobile-conversations');
  await page.click(`[data-testid=mobile-thread-menu-${id}]`);
  await page.waitFor(`document.querySelector('[data-testid=mobile-thread-menu-${id}-menu] [data-value=delete]')`);
  await capture('mobile-paired-thread-delete-menu.png');
  await page.click(`[data-testid=mobile-thread-menu-${id}-menu] [data-value=delete]`);
  await page.waitFor(`!document.querySelector('[data-testid=mobile-thread-${id}]') && !__boiteTest.workspace.active.threads.some(t => t.id === ${JSON.stringify(id)})`);
  await capture('mobile-paired-thread-deleted.png');
  expect(await page.evaluate('__boiteTest.workspace.active.error')).toBeNull();
  expect(page.errors()).toEqual([]);
}, 20_000);

test('a phone header shows the label of a draft and a truncated French title at 360 px', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent`);
  await page.waitFor(`document.querySelector('[data-testid=thread-menu-trigger]')?.offsetParent`);
  // A draft has no title menu: its own label is the header's title.
  await newMobileThread();
  await page.waitFor(`document.querySelector('[data-testid=thread-title]')?.classList.contains('draft')`);
  const draft = await page.evaluate<{ text: string; width: number }>(`(() => { const t = document.querySelector('[data-testid=thread-title]'); return { text: t.textContent.trim(), width: t.getBoundingClientRect().width }; })()`);
  expect(draft.text).toBe('New thread');
  expect(draft.width).toBeGreaterThan(40);
  await capture('mobile-draft-header.png');
  await page.evaluate(`localStorage.setItem('boite.locale', 'fr')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  try {
    await page.navigate(`${origin}/?fake=1&open=recent`);
    await page.waitFor(`document.querySelector('[data-testid=thread-menu-trigger]')?.offsetParent && document.documentElement.lang === 'fr'`);
    const title = await page.evaluate<{ visible: number; full: number }>(`(() => { const t = document.querySelector('[data-testid=thread-menu-trigger] .title-text'); return { visible: t.getBoundingClientRect().width, full: t.scrollWidth }; })()`);
    await capture('mobile-title-fr-360.png');
    expect(title.visible).toBeGreaterThanOrEqual(80);
    expect(await page.evaluate(`document.querySelector('[data-testid=thread-menu-trigger]').getBoundingClientRect().right <= innerWidth`)).toBe(true);
  } finally {
    await page.evaluate(`localStorage.setItem('boite.locale', 'en')`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  }
  expect(page.errors()).toEqual([]);
}, 30_000);

test('Back returns from a conversation to the list and closes the context popup, the panel and the project picker first', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent`);
  await page.waitFor(`document.querySelector('[data-testid=thread-title]')`);
  const back = async (gone: string) => {
    await page.evaluate('history.back()');
    await page.waitFor(`!document.querySelector(${JSON.stringify(gone)})`);
    expect(await page.evaluate<string>('location.origin')).toBe(origin);
  };
  await navigateMobile('mobile-conversations');
  await page.click('[data-testid=mobile-list] .thread');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]') && document.querySelector('[data-testid=chat]')`);
  await page.click('[data-testid=context-trigger]');
  await page.waitFor(`document.querySelector('[data-testid=context-popup]')`);
  await back('[data-testid=context-popup]');
  await openMobilePanel(page);
  await back('[data-testid=right-panel]');
  await page.evaluate('history.back()');
  await page.waitFor(`document.querySelector('[data-testid=mobile-list]')`);
  expect(await page.evaluate<string>('location.origin')).toBe(origin);
  // The project sheet pops its own entry while the picker pushes one.
  await page.click('[data-testid=mobile-project]');
  await page.click('[data-value="add-project"]');
  await page.waitFor(`document.querySelector('[data-testid=project-picker]')`);
  await Bun.sleep(400);
  await back('[data-testid=project-picker]');
  expect(await page.evaluate(`!!document.querySelector('[data-testid=mobile-list]')`)).toBe(true);
  // Closing the panel by its button pops its own entry: the next Back still reaches the list.
  await page.click('[data-testid=mobile-list] .thread');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]')`);
  await openMobilePanel(page);
  await page.click('[data-testid=panel-close]');
  await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);
  await Bun.sleep(300);
  await page.evaluate('history.back()');
  await page.waitFor(`document.querySelector('[data-testid=mobile-list]')`);
  expect(page.errors()).toEqual([]);
}, 30_000);

// A control takes a finger when a tap 19 px off its centre, on either axis, still lands on it.
// A control inside a label is skipped: the whole label row is its target.
// The settings scrollport clips controls at its edge, just as the viewport does.
const smallTargets = `(() => {
  const small = [];
  for (const el of document.querySelectorAll('button, summary, [role=button]')) {
    if (el.closest('label')) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const detail = el.closest('[data-testid=mobile-settings-detail]')?.getBoundingClientRect();
    if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    const at = (px, py) => { const hit = document.elementFromPoint(px, py); return !!hit && (hit === el || el.contains(hit)); };
    if (!at(x, y)) continue;
    const reach = [[x - 19, y], [x + 19, y], [x, y - 19], [x, y + 19]].filter(([px, py]) => px >= 0 && py >= 0 && px < innerWidth && py < innerHeight && (!detail || (py >= detail.top && py < detail.bottom)));
    if (reach.every(([px, py]) => at(px, py))) continue;
    small.push((el.dataset.testid || el.getAttribute('aria-label') || el.className || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  return small;
})()`;

test('every phone control on the chat, the panel, the list and Appearance takes a finger', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  try {
    await page.navigate(`${origin}/?fake=1&open=recent&long=1`);
    await page.waitFor(`document.querySelector('[data-testid=message-actions]')`);
    // A phone has no room for the message rail.
    expect(await page.evaluate(`document.querySelector('[data-testid=message-marker]') === null`)).toBe(true);
    expect(await page.evaluate(`matchMedia('(pointer: coarse)').matches`)).toBe(true);
    await capture('mobile-message-actions-touch.png');
    expect(await page.evaluate<string[]>(smallTargets)).toEqual([]);
    await openMobilePanel(page);
    await page.waitFor(`document.querySelector('[data-testid=panel-launcher]')`);
    // The capture settles the panel's entrance before measuring hit targets behind it.
    await capture('mobile-panel-launcher.png');
    expect(await page.evaluate<string[]>(smallTargets)).toEqual([]);
    await page.click('[data-testid=launch-changes]');
    // The strip shows its scroll chevrons for a frame while the new tab lays out.
    await page.waitFor(`document.querySelector('[data-testid=panel-tab-close]') && !document.querySelector('[data-testid=right-panel] .chev')`);
    await capture('mobile-panel-tab-touch.png');
    expect(await page.evaluate<string[]>(smallTargets)).toEqual([]);
    await page.click('[data-testid=panel-close]');
    await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);
    await navigateMobile('mobile-conversations');
    await page.waitFor(`document.querySelector('[data-testid=mobile-list] .thread')`);
    expect(await page.evaluate<string[]>(smallTargets)).toEqual([]);
    await navigateMobile('mobile-settings');
    await page.click('[data-testid=settings-tab-appearance]');
    await page.waitFor(`document.querySelector('[data-testid=colors-customize]')`);
    expect(await page.evaluate<string[]>(smallTargets)).toEqual([]);
    await page.click('[data-testid=colors-customize]');
    await page.waitFor(`document.querySelector('[data-accent-swatch]')`);
    await page.evaluate(`document.querySelector('[data-accent-swatch]').scrollIntoView({block:'center'})`);
    await capture('mobile-theme-controls-touch.png');
    expect(await page.evaluate<string[]>(smallTargets)).toEqual([]);
  } finally {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
}, 30_000);

test('a finger slides a row left to uncover Pin and Archive; a vertical drag stays the scroll', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const drag = async (from: [number, number], to: [number, number]) => {
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
    for (let step = 1; step <= 8; step++) {
      const x = from[0] + (to[0] - from[0]) * step / 8, y = from[1] + (to[1] - from[1]) * step / 8;
      await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  try {
    await page.navigate(`${origin}/?fake=1&open=recent`);
    await page.waitFor(`document.querySelector('[data-testid=composer-input]')`);
    await navigateMobile('mobile-conversations');
    const row = `document.querySelector('[data-testid=mobile-list] .row:has(.swipe.pin)')`;
    await page.waitFor(`!!${row}`);
    const id = await page.evaluate<string>(`${row}.dataset.threadId`);
    const body = `document.querySelector('[data-thread-id="${id}"] .row-body')`;
    const box = () => page.evaluate<{ left: number; right: number; y: number }>(`(() => { const r = ${body}.getBoundingClientRect(); return { left: r.left, right: r.right, y: r.top + r.height / 2 }; })()`);
    let at = await box();
    await drag([at.left + 120, at.y], [at.left + 116, at.y - 70]);
    await Bun.sleep(300);
    expect(await page.evaluate(`${body}.dataset.swiped !== 'true'`)).toBe(true);
    at = await box();
    await drag([at.right - 60, at.y], [at.right - 280, at.y + 4]);
    await page.waitFor(`${body}.dataset.swiped === 'true'`);
    // The slide does not open the conversation under the finger.
    expect(await page.evaluate(`!!document.querySelector('[data-testid=mobile-list]')`)).toBe(true);
    await Bun.sleep(300);
    await capture('mobile-row-swiped.png');
    const pinned = await page.evaluate<boolean>(`!!__boiteTest.workspace.active.threads.find(t => t.id === '${id}').pinned`);
    // The uncovered button takes the finger; this browser turns no emulated tap into a click, so the test clicks it.
    expect(await page.evaluate(`(() => { const r = document.querySelector('[data-testid=mobile-swipe-pin-${id}]').getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[data-testid]')?.dataset.testid; })()`)).toBe(`mobile-swipe-pin-${id}`);
    await page.click(`[data-testid=mobile-swipe-pin-${id}]`);
    await page.waitFor(`!!__boiteTest.workspace.active.threads.find(t => t.id === '${id}').pinned === ${!pinned}`);
    await page.waitFor(`document.querySelector('[data-thread-id="${id}"] .row-body')?.dataset.swiped !== 'true'`);
    expect(page.errors()).toEqual([]);
  } finally {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
}, 30_000);

test('screens slide over the one they open from, the panel and sheets from their edge, and nothing moves twice after the browser\'s own swipe', async () => {
  // A runner's own reduced-motion setting must not decide it: Windows runners turn animations off.
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const origin = await page.evaluate<string>('location.origin');
  await page.navigate(`${origin}/?fake=1&open=recent`);
  await page.waitFor(`document.querySelector('[data-testid=composer-input]')`);
  // The keyframes of a slide or a sheet started since the last read (lib/screen-slide.svelte.ts, app.css).
  await page.evaluate(`(() => { window.__moves = []; document.addEventListener('animationstart', event => { if (/^(screen|sheet)-/.test(event.animationName)) window.__moves.push(event.animationName); }, true); return null; })()`);
  const moves = async () => (await page.evaluate<string[]>('window.__moves.splice(0)')).sort();
  const still = `!document.querySelector('[data-testid=mobile-header][data-slide]') && document.querySelectorAll('.settings-screen').length < 2`;
  const frames = () => page.evaluate<null>('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))');
  // Safari 18 and Chrome 118 say on a Back whether they animated it; this stands for Safari's swipe from the edge.
  const swipeBack = async (shown: string) => {
    await page.evaluate(`(() => { window.__drawn = Object.getOwnPropertyDescriptor(PopStateEvent.prototype, 'hasUAVisualTransition'); Object.defineProperty(PopStateEvent.prototype, 'hasUAVisualTransition', { configurable: true, get: () => true }); history.back(); return null; })()`);
    await page.waitFor(shown);
    await frames();
    await page.evaluate(`(() => { if (window.__drawn) Object.defineProperty(PopStateEvent.prototype, 'hasUAVisualTransition', window.__drawn); else delete PopStateEvent.prototype.hasUAVisualTransition; return null; })()`);
  };

  await navigateMobile('mobile-conversations');
  await page.waitFor(`document.querySelector('[data-testid=mobile-list] .thread') && ${still}`);
  await moves();
  // The conversation comes over the list, which shifts under it with the bar and takes no tap meanwhile.
  const during = await page.evaluate<{ slide?: string; inert?: boolean; tabs?: boolean }>(`(async () => {
    document.querySelector('[data-testid=mobile-list] .thread').click();
    await new Promise(resolve => setTimeout(resolve));
    return { slide: document.querySelector('[data-testid=mobile-header]').dataset.slide, inert: document.querySelector('[data-testid=mobile-list]')?.inert, tabs: document.querySelector('[data-testid=mobile-tabs]')?.inert };
  })()`);
  expect(during).toEqual({ slide: 'push', inert: true, tabs: true });
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]') && document.querySelector('[data-testid=chat]') && ${still}`);
  expect(await moves()).toEqual(['screen-in', 'screen-under-out', 'screen-under-out']);

  // The title's menu rises as a sheet and goes back down; the panel it opens comes in from the right edge and leaves by it.
  await page.click('[data-testid=thread-menu-trigger]');
  await page.waitFor(`document.querySelector('[data-testid=thread-menu-trigger-menu]')?.dataset.mobileSheet === 'true' && ${screensSettled}`);
  expect(await moves()).toEqual(['sheet-up']);
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=panel]');
  await page.waitFor(`document.querySelector('[data-testid=right-panel]')`);
  await page.waitFor(screensSettled);
  expect(await moves()).toEqual(['screen-in', 'sheet-down']);
  await page.evaluate('history.back()');
  await page.waitFor(`!document.querySelector('[data-testid=right-panel]')`);
  expect(await moves()).toEqual(['screen-out']);
  // After the browser's own swipe it leaves at once.
  await openMobilePanel(page);
  await page.waitFor(screensSettled);
  await moves();
  await swipeBack(`!document.querySelector('[data-testid=right-panel]')`);
  expect(await moves()).toEqual([]);

  // The app's Back: the conversation leaves by the right edge over the list coming back.
  await page.click('[data-testid=mobile-back]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-list] .thread') && ${still}`);
  expect(await moves()).toEqual(['screen-out', 'screen-under-in', 'screen-under-in']);
  // The browser's swipe already slid the list in: the conversation is simply gone.
  await page.click('[data-testid=mobile-list] .thread');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-list]') && ${still}`);
  await moves();
  await swipeBack(`document.querySelector('[data-testid=mobile-list] .thread')`);
  expect(await moves()).toEqual([]);
  expect(await page.evaluate(`document.querySelector('[data-testid=mobile-header]').dataset.slide ?? null`)).toBe(null);

  // A Settings page comes over the home and goes back off it; between the two tabs of Usage it is only replaced.
  await navigateMobile('mobile-settings');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]') && ${still} && ${screensSettled}`);
  await moves();
  await page.click('[data-testid=settings-tab-usage]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-detail]') && !document.querySelector('[data-testid=mobile-settings-home]') && ${still}`);
  expect(await moves()).toEqual(['screen-in', 'screen-under-out']);
  await page.click('[data-testid=mobile-usage-tab-limits]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-usage-tab-limits]')?.getAttribute('aria-selected') === 'true'`);
  await frames();
  expect(await moves()).toEqual([]);
  // The page sliding off takes no tap, and neither does the home beneath it, which a tap through the page would reach.
  const leavingPage = await page.evaluate<boolean[]>(`(async () => {
    document.querySelector('[data-testid=mobile-settings-back]').click();
    await new Promise(resolve => setTimeout(resolve));
    return [...document.querySelectorAll('.settings-screen')].map(screen => screen.inert);
  })()`);
  expect(leavingPage).toEqual([true, true]);
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]') && !document.querySelector('[data-testid=mobile-settings-detail]') && ${still}`);
  expect(await page.evaluate(`document.querySelector('.settings-screen').inert`)).toBe(false);
  expect(await moves()).toEqual(['screen-out', 'screen-under-in']);
  await page.click('[data-testid=settings-tab-appearance]');
  await page.waitFor(`!document.querySelector('[data-testid=mobile-settings-home]') && ${still}`);
  await moves();
  await swipeBack(`document.querySelector('[data-testid=mobile-settings-home]') && document.querySelectorAll('.settings-screen').length === 1`);
  expect(await moves()).toEqual([]);

  // Under reduced motion nothing slides.
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    await page.click('[data-testid=settings-tab-appearance]');
    await page.waitFor(`document.querySelector('[data-testid=mobile-settings-detail]') && document.querySelectorAll('.settings-screen').length === 1`);
    await page.click('[data-testid=mobile-settings-back]');
    await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]') && document.querySelectorAll('.settings-screen').length === 1`);
    await frames();
    expect(await moves()).toEqual([]);
  } finally {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  }

  // Nor wider than a phone.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  try {
    await page.click('[data-testid=settings-back]');
    await page.waitFor(`document.querySelectorAll('[data-testid=thread-row]').length > 1`);
    await page.evaluate(`(() => { document.querySelectorAll('[data-testid=thread-row]')[1].click(); return null; })()`);
    await page.waitFor(screensSettled);
    await frames();
    expect(await moves()).toEqual([]);
  } finally {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.send('Emulation.setEmulatedMedia', { features: [] });
  }
  expect(page.errors()).toEqual([]);
}, 60_000);
