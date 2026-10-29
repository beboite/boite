import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
const capture = async (name: string) => {
  await page.settleAnimations();
  await page.screenshot(join(import.meta.dir, '.artifacts', `diagrams-${name}.png`));
};

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&diagrams=1`, windowSize: { width: 1300, height: 1500 } });
  await page.waitFor(`window.__boiteTest?.workspace.active.connection === 'ready'`);
  await page.evaluate(`window.__boiteTest.workspace.active.open('t-diagrams')`);
  // Two diagrams and the one that does not parse, the formula in the line and the one on its own.
  await page.waitFor(`document.querySelectorAll('${id('diagram')}').length === 2 && document.querySelector('${id('diagram-error')}')
    && document.querySelectorAll('.md-math.md-drawn').length >= 2`, 30_000);
}, 120_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 60_000);

test('an answer draws its diagrams and formulas, keeps prices as text and shows a broken diagram as code', async () => {
  const answer = await page.evaluate<{ prices: boolean; error: string; code: string; unsafe: number; math: number }>(`(() => {
    const list = document.body;
    const broken = document.querySelector('${id('diagram-error')}').closest('.md-mermaid');
    return {
      prices: list.textContent.includes('between 5 $ and 10 $ a month') && list.textContent.includes('$HOME stay as written'),
      error: broken.querySelector('${id('diagram-error')}').textContent,
      code: broken.querySelector('pre code').textContent,
      unsafe: list.querySelectorAll('.md-diagram-figure script, .md-diagram-figure foreignObject, .md-diagram-figure a, .md-math script').length,
      math: list.querySelectorAll('.md-math math').length
    };
  })()`);
  expect(answer.prices).toBe(true);
  expect(answer.error).toBe("This diagram could not be drawn: Parse error on line 3: Expecting 'NODE_STRING', got 'EOF'");
  expect(answer.code).toBe('flowchart LR\n  A --> ');
  expect(answer.unsafe).toBe(0);
  expect(answer.math).toBeGreaterThanOrEqual(2);
}, 60_000);

test('a theme change recolors a drawn diagram in place, at desktop and phone widths', async () => {
  for (const [width, height, mobile] of [[1300, 1500, false], [390, 2300, true]] as const) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    // A touch screen has no hover: the diagram's bar sits above it.
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(`window.__boiteTest.setTheme('${theme}')`);
      await page.evaluate(`document.querySelector('${id('diagram')}').scrollIntoView({ block: 'start' })`);
      await capture(`${width}-${theme}`);
      await page.evaluate(`document.querySelector('div.md-math.md-drawn, .md-math[data-display].md-drawn').scrollIntoView({ block: 'center' })`);
      await capture(`${width}-${theme}-formula`);
    }
  }
  const drawn = await page.evaluate<{ same: boolean; changed: boolean; fits: boolean }>(`(async () => {
    const figure = document.querySelector('${id('diagram')}');
    const svg = figure.querySelector('svg');
    const before = getComputedStyle(svg.querySelector('rect, path')).stroke + getComputedStyle(figure).getPropertyValue('--pele-bg');
    window.__boiteTest.setTheme('light');
    await new Promise(requestAnimationFrame);
    const after = getComputedStyle(svg.querySelector('rect, path')).stroke + getComputedStyle(figure).getPropertyValue('--pele-bg');
    // At 390 px the diagram stays inside its column: it shrinks, or scrolls inside its own box.
    const column = figure.closest('.md-mermaid').getBoundingClientRect();
    const box = figure.getBoundingClientRect();
    return { same: figure.querySelector('svg') === svg, changed: before !== after, fits: box.right <= column.right + 0.5 && document.documentElement.scrollWidth <= innerWidth };
  })()`);
  expect(drawn).toEqual({ same: true, changed: true, fits: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 1500, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
}, 90_000);

test('a view block shows its page in the sandbox, as tall as the page, at desktop and phone widths', async () => {
  const block = `document.querySelector('.md-view')`;
  await page.waitFor(`document.querySelector('.md-view.md-drawn ${id('view-block-frame')}[data-ready]')`, 30_000);
  const shown = () => page.evaluate<{ sandbox: string | null; code: boolean; frame: boolean; height: number; scheme: string; error: boolean }>(`(() => {
    const b = ${block};
    const frame = b.querySelector('${id('view-block-frame')}');
    return { sandbox: frame.getAttribute('sandbox'), code: b.querySelector('pre').checkVisibility(), frame: frame.checkVisibility(),
      height: frame.getBoundingClientRect().height, scheme: frame.style.colorScheme, error: b.querySelector('${id('diagram-error')}') !== null };
  })()`);
  const first = await shown();
  expect(first).toMatchObject({ sandbox: 'allow-scripts', code: false, frame: true, error: false });
  // The card's own height, not the default a page without one gets.
  expect(first.height).toBeGreaterThan(60);
  expect(first.height).toBeLessThan(300);
  for (const [width, height, mobile] of [[1300, 1500, false], [390, 2300, true]] as const) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(`window.__boiteTest.setTheme('${theme}')`);
      await page.waitFor(`${block}.querySelector('${id('view-block-frame')}').style.colorScheme === '${theme}'`);
      await page.evaluate(`${block}.scrollIntoView({ block: 'center' })`);
      await capture(`view-${width}-${theme}`);
    }
    expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 1500, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // Its HTML and back; a page hidden behind its code keeps the height it showed at.
  await page.evaluate(`${block}.querySelector('${id('diagram-toggle')}').click()`);
  expect(await shown()).toMatchObject({ code: true, frame: false });
  await page.evaluate(`${block}.querySelector('${id('diagram-toggle')}').click()`);
  await page.waitFor(`${block}.querySelector('${id('view-block-frame')}').checkVisibility()`);
  expect((await shown()).height).toBeGreaterThan(60);
}, 90_000);

test('a diagram switches to its code and back, and opens in the image viewer', async () => {
  const block = `document.querySelector('${id('diagram')}').closest('.md-mermaid')`;
  await page.evaluate(`${block}.querySelector('${id('diagram-toggle')}').click()`);
  expect(await page.evaluate(`(() => { const b = ${block}; return [b.dataset.view, b.querySelector('pre').checkVisibility(), b.querySelector('${id('diagram')}').checkVisibility()]; })()`)).toEqual(['code', true, false]);
  await page.evaluate(`${block}.querySelector('${id('diagram-toggle')}').click()`);
  expect(await page.evaluate(`${block}.dataset.view`)).toBe('diagram');
  expect(await page.evaluate(`${block}.querySelector('${id('diagram-copy')}') !== null`)).toBe(true);

  await page.evaluate(`${block}.querySelector('${id('diagram-enlarge')}').click()`);
  await page.waitFor(`document.querySelector('${id('image-viewer')}')`);
  expect(await page.evaluate(`document.querySelector('${id('image-viewer')} img')?.src.startsWith('blob:')`)).toBe(true);
  // The file carries every color and font the stylesheet gives the diagram, so it looks the same on its own.
  const missing = await page.evaluate<string[]>(`(async () => {
    const file = await (await fetch(document.querySelector('${id('image-viewer')} img').src)).text();
    const style = new DOMParser().parseFromString(file, 'image/svg+xml').documentElement.getAttribute('style') ?? '';
    const sheet = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules]; } catch { return []; } })
      .find(rule => rule.selectorText === '.md-mermaid');
    return [...sheet.style].filter(name => name.startsWith('--pele-') && !style.includes(name + ':'));
  })()`);
  expect(missing).toEqual([]);
  await capture('viewer');
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await page.waitFor(`!document.querySelector('${id('image-viewer')}')`);
}, 60_000);
