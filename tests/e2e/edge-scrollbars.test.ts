import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
const timeline = '[data-testid=timeline]';
const toggle = '[data-testid=setting-edge-scrollbars]';
const artifacts = join(import.meta.dir, '.artifacts');
const POINTER = '(hover: hover) and (pointer: fine)';

interface Box { left: number; right: number; top: number; bottom: number; client: number; offset: number; column: number; composer: number }

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations()
    .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))])`);
}

/** Two frames, so the overlay has drawn what the last pointer event asked for. */
async function frames() {
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function move(x: number, y: number, buttons = 0) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons, button: buttons ? 'left' : 'none' });
  await frames();
}

function box() {
  return page.evaluate<Box>(`(() => {
    const el = document.querySelector('${timeline}');
    const r = el.getBoundingClientRect();
    const column = el.querySelector(':scope > .column')?.getBoundingClientRect();
    const composer = document.querySelector('[data-testid=composer]')?.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, client: el.clientWidth, offset: el.offsetWidth,
      column: column ? column.left + column.width / 2 : NaN, composer: composer ? composer.left + composer.width / 2 : NaN };
  })()`);
}

/** The vertical thumb's opacity and centre, or null when none is drawn. */
function thumb() {
  return page.evaluate<{ opacity: number; x: number; y: number } | null>(`(() => {
    const thumb = [...document.querySelectorAll('.edge-scrollbar-thumb[data-axis=y]')].find(t => t.isConnected);
    if (!thumb) return null;
    const r = thumb.getBoundingClientRect();
    return { opacity: Number(thumb.style.opacity), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

async function setSwitch(on: boolean) {
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-appearance]');
  expect(await page.evaluate(`!!document.querySelector('${toggle}')`)).toBe(true);
  const checked = await page.evaluate<boolean>(`document.querySelector('${toggle}').getAttribute('aria-checked') === 'true' || document.querySelector('${toggle}').checked === true`);
  if (checked !== on) await page.click(toggle);
  await page.click('[data-testid=settings-back]');
  await page.waitFor(`document.querySelector('${timeline}')`);
  await page.waitFor(`document.documentElement.classList.contains('edge-scrollbars') === ${on}`);
  await settled();
}

/**
 * Headless Chromium on Linux reports no pointing device, and CDP cannot emulate
 * one. The driver answers the scrollbars' one gate query as a desktop with a
 * mouse would; every other query, CSS included, stays the browser's own.
 */
const MOUSE = `(() => {
  const query = '${POINTER}';
  const real = window.matchMedia.bind(window);
  if (real(query).matches) return;
  window.matchMedia = (text) => text !== query ? real(text) : Object.assign(new EventTarget(), {
    media: query, matches: true, onchange: null, addListener() {}, removeListener() {},
  });
})();`;

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: 'about:blank', windowSize: { width: 1280, height: 900 } });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: MOUSE });
  // On by default: the test starts from native bars and turns them on in Appearance.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('boite.features', '{"edge-scrollbars":false}'); } catch {}` });
  await page.navigate(`http://127.0.0.1:${port}/?fake=1&open=recent&long=1`);
  await page.waitFor(`document.querySelector('${timeline}') && document.querySelector('${timeline}').scrollHeight > document.querySelector('${timeline}').clientHeight`);
  await settled();
}, 60_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

test('edge scrollbars take no room, fade in near the edge, drag, and turn off cleanly', async () => {
  // The scrollbars' gate, answered by the driver when headless has no mouse.
  expect(await page.evaluate<boolean>(`matchMedia('${POINTER}').matches`)).toBe(true);
  const before = await box();
  await page.screenshot(join(artifacts, 'edge-scrollbars-off.png'));

  await setSwitch(true);
  const on = await box();
  expect(on.client).toBe(on.offset);
  // The native bar's width went back to the content; the bubbles did not move sideways because of anything else.
  expect(on.left).toBe(before.left);
  expect(on.right).toBe(before.right);
  // The gutters' width goes back to the content, and the column stays on the
  // composer's centre.
  expect(on.client - before.client).toBeGreaterThan(4);
  expect(Math.abs(on.column - on.composer)).toBeLessThan(0.5);

  const middleY = Math.round((on.top + on.bottom) / 2);
  await move(Math.round((on.left + on.right) / 2), middleY);
  const hidden = await thumb();
  expect(hidden === null || hidden.opacity === 0).toBe(true);
  await page.screenshot(join(artifacts, 'edge-scrollbars-middle.png'));

  await move(Math.round(on.right - 90), middleY);
  const far = await thumb();
  await move(Math.round(on.right - 40), middleY);
  const nearer = await thumb();
  await move(Math.round(on.right - 6), middleY);
  const edge = await thumb();
  expect(far?.opacity ?? 0).toBeGreaterThan(0);
  expect(nearer!.opacity).toBeGreaterThan(far!.opacity);
  expect(edge!.opacity).toBe(1);
  await page.screenshot(join(artifacts, 'edge-scrollbars-edge.png'));

  // Text under the overlay stays reachable: only the thumb takes the pointer.
  expect(await page.evaluate<boolean>(`(() => {
    const t = document.querySelector('${timeline}');
    const hit = document.elementFromPoint(${Math.round((on.left + on.right) / 2)}, ${middleY});
    return t.contains(hit);
  })()`)).toBe(true);

  const scrollBefore = await page.evaluate<number>(`document.querySelector('${timeline}').scrollTop`);
  await move(Math.round(edge!.x), Math.round(edge!.y));
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(edge!.x), y: Math.round(edge!.y), button: 'left', buttons: 1, clickCount: 1 });
  await move(Math.round(edge!.x), Math.round(edge!.y) - 120, 1);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(edge!.x), y: Math.round(edge!.y) - 120, button: 'left', buttons: 0, clickCount: 1 });
  await frames();
  const scrollAfter = await page.evaluate<number>(`document.querySelector('${timeline}').scrollTop`);
  expect(scrollAfter).toBeLessThan(scrollBefore - 100);
  // The thumb followed the content up.
  const moved = await thumb();
  expect(moved!.y).toBeLessThan(edge!.y - 60);

  // A menu over the timeline's edge covers the timeline's thumb, as it covers
  // the timeline; a list inside that menu still gets its own thumb on top.
  await page.evaluate(`(() => {
    const menu = document.createElement('div');
    menu.id = 'edge-test-menu';
    menu.setAttribute('popover', 'manual');
    Object.assign(menu.style, { position: 'fixed', margin: '0', inset: 'auto', overflow: 'auto', padding: '0',
      left: '${on.right - 100}px', top: '${on.top + 40}px', width: '100px', height: '${on.bottom - on.top - 40}px' });
    const list = document.createElement('div');
    list.style.height = '4000px';
    menu.append(list);
    document.body.append(menu);
    menu.showPopover();
  })()`);
  await move(Math.round(on.right - 6), Math.round(on.top + 20));
  const covered = await thumb();
  expect(covered?.opacity).toBe(1);
  expect(await page.evaluate<string | null>(`document.elementFromPoint(${covered!.x}, ${Math.max(on.top + 60, covered!.y)})?.closest('#edge-test-menu')?.id ?? null`)).toBe('edge-test-menu');
  await page.screenshot(join(artifacts, 'edge-scrollbars-menu.png'));
  await move(Math.round(on.right - 4), Math.round(on.top + 200));
  const inMenu = await page.evaluate<string | null>(`(() => {
    const hit = document.elementFromPoint(${Math.round(on.right - 5)}, ${Math.round(on.top + 50)});
    return hit?.className ?? null;
  })()`);
  expect(inMenu).toBe('edge-scrollbar-thumb');
  await move(Math.round(on.right - 6), Math.round(on.top + 20));
  await page.evaluate(`document.getElementById('edge-test-menu').remove()`);

  // Leaving the window hides every thumb.
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -10, y: -10 });
  await frames();
  expect(await page.evaluate<number>(`document.querySelectorAll('.edge-scrollbar-layer .edge-scrollbar-thumb').length`)).toBe(0);

  await setSwitch(false);
  const off = await box();
  expect(off.client).toBeLessThan(off.offset);
  expect(await page.evaluate<boolean>(`document.querySelector('.edge-scrollbar-layer') === null`)).toBe(true);
  expect(page.errors()).toEqual([]);
}, 60_000);
