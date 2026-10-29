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

test('Windows caption buttons keep their full hit areas beside the resize handles', async () => {
  const result = await page.evaluate<{ blocked: string[]; reachable: number; captions: number }>(`(async () => {
    const { mockIPC, mockWindows, clearMocks } = await import('/node_modules/@tauri-apps/api/mocks.js');
    const { mount, unmount } = await import('/node_modules/svelte/src/index-client.js');
    const { default: TitleBar } = await import('/src/components/TitleBar.svelte');
    const { Store } = await import('/src/lib/store.svelte.ts');
    const userAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    const platform = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    mockWindows('main');
    mockIPC(() => false, { shouldMockEvents: true });
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:20000;background:var(--color-background)';
    document.body.append(host);
    const component = mount(TitleBar, { target: host, props: { store: new Store() } });
    try {
      for (let attempt = 0; attempt < 100 && host.querySelectorAll('[data-resize-direction]').length !== 8; attempt++)
        await new Promise(resolve => setTimeout(resolve, 20));
      const blocked = [];
      for (const button of host.querySelectorAll('[data-testid=titlebar-controls] button')) {
        const r = button.getBoundingClientRect();
        for (const x of [r.left + 1, (r.left + r.right) / 2, r.right - 1]) {
          for (const y of [r.top + 1, (r.top + r.bottom) / 2, r.bottom - 1]) {
            if (document.elementFromPoint(x, y)?.closest('button') !== button)
              blocked.push(button.getAttribute('aria-label') + ' at ' + x + ',' + y);
          }
        }
      }
      let reachable = 0;
      for (const handle of host.querySelectorAll('[data-resize-direction]')) {
        const r = handle.getBoundingClientRect();
        if (document.elementFromPoint((r.left+r.right)/2, (r.top+r.bottom)/2) === handle) reachable++;
      }
      return { blocked, reachable, captions: host.querySelectorAll('[data-testid=titlebar-controls] button').length };
    } finally {
      await unmount(component);
      host.remove();
      clearMocks();
      for (const [key, descriptor] of [['userAgent', userAgent], ['platform', platform]]) {
        if (descriptor) Object.defineProperty(navigator, key, descriptor);
        else delete navigator[key];
      }
    }
  })()`);
  expect(result.blocked).toEqual([]);
  expect(result.captions).toBe(3);
  expect(result.reachable).toBe(8);
}, 30_000);

// Each test names its budget: a cold dev server on a loaded Windows runner
// transformed the launcher past bun's 5 s default (E2E 3/3, 2026-10-21).

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
}, 30_000);

test('a panel tab centres its icon on its label, and the strip fades the end that hides a tab', async () => {
  await size(1180, 800);
  await onStore(`store.panel.closeAll(); for (const kind of ['agents', 'messages', 'files', 'changes', 'tasks']) store.panel.open(kind);`);
  await page.waitFor(`document.querySelectorAll('${id('panel-tab')}').length === 5`);
  await page.settleAnimations();
  // One more on a strip that already overflows, the way the "+" menu adds them.
  await onStore(`store.panel.open('trace');`);
  await page.waitFor(`document.querySelectorAll('${id('panel-tab')}').length === 6`);
  const offsets = await page.evaluate<number[]>(`[...document.querySelectorAll('${id('panel-tab')}')].map((tab) => {
    const icon = tab.querySelector('.glyph svg').getBoundingClientRect();
    const name = tab.querySelector('.name').getBoundingClientRect();
    return (icon.top + icon.bottom) / 2 - (name.top + name.bottom) / 2;
  })`);
  // An inline span set the icon on the text's baseline, 2.5 px above the label's centre.
  for (const offset of offsets) expect(Math.abs(offset)).toBeLessThanOrEqual(1);
  // The tab just opened is the active one, and once the strip's smooth scroll
  // ends no fade lies over it: it stood 6 px short of the end, under the fade.
  await page.waitFor(`(() => {
    const tabs = document.querySelector('${id('panel-tabs')}');
    const strip = tabs.getBoundingClientRect();
    const active = document.querySelector('${id('panel-tab')}[aria-selected="true"]').getBoundingClientRect();
    return active.right <= strip.right + 0.5 && (!tabs.classList.contains('hidden-end') || strip.right - active.right >= 24);
  })()`, 3_000);

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

  // Closed by its X, the panel hands the keys to the toggle that opens it again, not to the page.
  await page.click(id('panel-close'));
  await page.waitFor(`document.activeElement?.dataset?.testid === 'panel-toggle'`);
}, 30_000);

test('the launcher letters are whole keycaps', async () => {
  // An empty panel that is open is the launcher; closing every tab shuts the
  // panel, which only showed the launcher while its exit animation ran.
  await onStore(`store.panel.closeAll(); store.panel.toggle();`);
  await page.waitFor(`document.querySelector('${id('launch-files')}')`);
  await page.settleAnimations();
  const keys = await page.evaluate<{ height: number; offset: number }[]>(`[...document.querySelectorAll('[data-testid^="launch-"] .kbd')].map((key) => {
    const box = key.getBoundingClientRect(), style = getComputedStyle(key);
    const face = (box.top + parseFloat(style.borderTopWidth) + box.bottom - parseFloat(style.borderBottomWidth)) / 2;
    // The label's own box less its padding is the trimmed cap height of its letters.
    const label = key.querySelector('.ui-label'), lb = label.getBoundingClientRect(), ls = getComputedStyle(label);
    const caps = (lb.top + parseFloat(ls.paddingTop) + lb.bottom - parseFloat(ls.paddingBottom)) / 2;
    return { height: box.height, offset: caps - face };
  })`);
  expect(keys.length).toBeGreaterThan(0);
  // As a trimmed label the cap was 11 px high; as an inline block its letter sat 3 px above the middle.
  for (const key of keys) {
    expect(key.height).toBeGreaterThanOrEqual(18);
    expect(Math.abs(key.offset)).toBeLessThanOrEqual(1);
  }
}, 30_000);

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
}, 30_000);
