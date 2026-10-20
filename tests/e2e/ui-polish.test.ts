import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui.ts';

// Pixel defects of the 2026-10-20 polish pass, each read from the layout the
// browser drew: jsdom lays nothing out.
let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;

async function onStore(code: string) {
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(async ({ store }) => { ${code} })`);
}

async function size(width: number, height: number, mobile = false) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
}

async function capture(name: string) {
  await page.settleAnimations();
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1440, height: 900 } });
  await page.waitFor(`document.querySelector('${id('composer-effort')}')`, 40_000);
}, 90_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

test('a composer the side panel narrows keeps its send button on the row of the chips', async () => {
  await size(1024, 700);
  await onStore(`store.panel.closeAll(); store.panel.open('files');`);
  await page.waitFor(`document.querySelector('${id('composer')}').getBoundingClientRect().width < 480`);
  await capture('polish-composer-narrow.png');
  const narrow = await page.evaluate<{ send: number; effort: number; label: string }>(`(() => {
    const bottom = (selector) => document.querySelector(selector).getBoundingClientRect().bottom;
    return {
      send: bottom('${id('composer-send')}'),
      effort: bottom('${id('composer-effort')}'),
      label: getComputedStyle(document.querySelector('${id('composer-effort')} .ui-label')).display,
    };
  })()`);
  // Wrapped, the tools sat centred on two rows of chips, half a row above the last one.
  expect(Math.abs(narrow.send - narrow.effort)).toBeLessThanOrEqual(1);
  expect(narrow.label).toBe('none');

  await size(1440, 900);
  await onStore(`store.panel.closeAll(); store.panel.hide();`);
  await page.waitFor(`document.querySelector('${id('composer')}').getBoundingClientRect().width > 600`);
  const wide = await page.evaluate<{ picker: number; send: number; label: string }>(`(() => {
    const top = (selector) => document.querySelector(selector).getBoundingClientRect().top;
    return {
      picker: top('${id('composer-picker')}'),
      send: top('${id('composer-send')}'),
      label: getComputedStyle(document.querySelector('${id('composer-effort')} .ui-label')).display,
    };
  })()`);
  expect(Math.abs(wide.picker - wide.send)).toBeLessThanOrEqual(1);
  expect(wide.label).not.toBe('none');
});

test('a panel tab centres its icon on its label, and the strip fades the end that hides a tab', async () => {
  await size(1180, 800);
  await onStore(`store.panel.closeAll(); for (const kind of ['agents', 'messages', 'files', 'changes', 'tasks', 'trace']) store.panel.open(kind);`);
  await page.waitFor(`document.querySelectorAll('${id('panel-tab')}').length === 6`);
  await page.settleAnimations();
  const offsets = await page.evaluate<number[]>(`[...document.querySelectorAll('${id('panel-tab')}')].map((tab) => {
    const icon = tab.querySelector('.glyph svg').getBoundingClientRect();
    const name = tab.querySelector('.name').getBoundingClientRect();
    return (icon.top + icon.bottom) / 2 - (name.top + name.bottom) / 2;
  })`);
  // An inline span set the icon on the text's baseline, 2.5 px above the label's centre.
  for (const offset of offsets) expect(Math.abs(offset)).toBeLessThanOrEqual(1);

  const edges = async () => page.evaluate<{ start: boolean; end: boolean; mask: string; left: boolean; right: boolean }>(`(() => {
    const tabs = document.querySelector('${id('panel-tabs')}');
    const chevrons = [...document.querySelectorAll('${id('panel-titlebar')} .chev')];
    return {
      start: tabs.classList.contains('hidden-start'),
      end: tabs.classList.contains('hidden-end'),
      mask: getComputedStyle(tabs).maskImage,
      left: chevrons[0]?.disabled === false,
      right: chevrons[1]?.disabled === false,
    };
  })()`);
  await page.evaluate(`(() => { const tabs = document.querySelector('${id('panel-tabs')}'); tabs.style.scrollBehavior = 'auto'; tabs.scrollLeft = 0; })()`);
  await page.waitFor(`document.querySelector('${id('panel-tabs')}').classList.contains('hidden-end')`);
  const first = await edges();
  expect(first).toMatchObject({ start: false, end: true, left: false, right: true });
  expect(first.mask).toContain('gradient');
  await page.evaluate(`(() => { const tabs = document.querySelector('${id('panel-tabs')}'); tabs.scrollLeft = tabs.scrollWidth; })()`);
  await page.waitFor(`document.querySelector('${id('panel-tabs')}').classList.contains('hidden-start')`);
  expect(await edges()).toMatchObject({ start: true, end: false, left: true, right: false });
  await capture('polish-panel-tabs.png');
});

test('the launcher letters are whole keycaps', async () => {
  await onStore(`store.panel.closeAll(); store.panel.open('files'); store.panel.closeAll();`);
  await page.waitFor(`document.querySelector('${id('launch-files')}')`);
  const keys = await page.evaluate<{ height: number; inside: boolean }[]>(`[...document.querySelectorAll('[data-testid^="launch-"] .kbd')].map((key) => {
    const box = key.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(key);
    const ink = range.getBoundingClientRect();
    return { height: box.height, inside: ink.top >= box.top - 0.5 && ink.bottom <= box.bottom + 0.5 };
  })`);
  expect(keys.length).toBeGreaterThan(0);
  // As a trimmed label the cap was 11 px high and its letter stood out of it.
  for (const key of keys) {
    expect(key.height).toBeGreaterThanOrEqual(18);
    expect(key.inside).toBe(true);
  }
});

test('a turn footer that wraps leaves no dot at either end of a line', async () => {
  await onStore(`store.panel.closeAll(); store.panel.hide();`);
  for (const width of [330, 390, 470]) {
    await size(width, 760, true);
    await page.waitFor(`document.querySelector('${id('turn-summary')}')`);
    await page.settleAnimations();
    const dots = await page.evaluate<{ visible: boolean; withText: boolean; lead: boolean }[]>(`[...document.querySelectorAll('${id('turn-summary')} .dot')].map((dot) => {
      const summary = dot.closest('${id('turn-summary')}');
      const clip = summary.getBoundingClientRect().left + (parseFloat(getComputedStyle(summary).getPropertyValue('--lead')) || 0);
      const box = dot.getBoundingClientRect();
      const line = (el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
      const text = dot.nextElementSibling;
      const before = [...summary.querySelectorAll('svg, .ui-label, button')].filter((el) => el !== dot && !dot.contains(el) && el.getBoundingClientRect().right <= box.left && Math.abs(line(el) - line(dot)) <= 4);
      return { visible: box.left >= clip - 0.5, withText: !!text && Math.abs(line(text) - line(dot)) <= 4, lead: before.length === 0 };
    })`);
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      expect(dot.withText, `${width}px: a dot ended its line`).toBe(true);
      if (dot.visible) expect(dot.lead, `${width}px: a dot started its line`).toBe(false);
    }
  }
  await capture('polish-turn-footer-phone.png');
  await size(1440, 900);
});
