import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui';

let ui: Awaited<ReturnType<typeof startUi>>;
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
const onStore = (code: string) => page.evaluate(`import('/src/lib/store.svelte.ts').then(async ({ store }) => { ${code} })`);

beforeAll(async () => {
  const port = await freePort();
  ui = await startUi(port, { development: true });
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1310, height: 820 } });
  await page.waitFor(`document.querySelector('${id('composer-input')}')`);
  await onStore(`await store.open('t-trace'); store.panel.closeAll();`);
}, 90_000);

afterAll(async () => { await page?.close(); await ui?.close(); }, 15_000);

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

test('preview references attach to the existing composer and remain clickable after sending at both widths', async () => {
  await page.type(id('composer-input'), 'Keep this existing draft.');
  await onStore(`store.panel.open('browser');`);
  await page.waitFor(`document.querySelector('iframe[data-browser-id]')?.contentDocument?.body`);
  expect(await page.evaluate(`!!document.querySelector('${id('preview-annotate')}')`)).toBe(false);
  await page.evaluate(`import('/src/lib/experiments.ts').then(({ setExperiment }) => setExperiment('preview-comments', true))`);
  await page.waitFor(`document.querySelector('${id('preview-annotate')}')`);
  await page.evaluate(`(() => {
    const doc = document.querySelector('iframe[data-browser-id]').contentDocument;
    doc.body.innerHTML = '<main><h1>Preview shop</h1><p>A small page for reviewing a real element.</p><button id="preview-buy">Buy now</button></main>';
    const style = doc.createElement('style');
    style.textContent = 'body { margin:0; padding:24px; font:14px/1.5 system-ui; color:CanvasText; background:Canvas; display:block; height:auto; } button { padding:10px 20px; font:inherit; }';
    doc.head.append(style);
  })()`);
  await page.click(id('preview-annotate'));
  await page.waitFor(`(() => { const frame = document.querySelector('iframe[data-browser-id]'); const slot = document.querySelector('${id('browser-slot')}'); return Math.abs(frame.getBoundingClientRect().top - slot.getBoundingClientRect().top) < 1; })()`);
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const frame = document.querySelector('iframe[data-browser-id]');
    const outer = frame.getBoundingClientRect();
    const target = frame.contentDocument.querySelector('#preview-buy').getBoundingClientRect();
    return { x: outer.x + target.x + target.width / 2, y: outer.y + target.y + target.height / 2 };
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
  await page.waitFor(`document.querySelector('${id('composer')} ${id('preview-reference')}')`);
  expect(await page.evaluate(`!!document.querySelector('${id('preview-comment-form')}')`)).toBe(false);
  expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe('Keep this existing draft. @Buy now');
  expect(await page.text(`${id('composer')} ${id('preview-reference')}`)).toBe('@Buy now');
  expect(await page.evaluate(`getComputedStyle(document.querySelector('${id('composer')} ${id('preview-reference')}')).webkitTextStrokeWidth`)).toBe('0.35px');
  expect(await page.evaluate(`!!document.querySelector('${id('composer')} .input-wrap ${id('preview-reference')}')`)).toBe(true);
  await page.evaluate(`document.querySelector('${id('composer-input')}').focus(); document.execCommand('undo')`);
  await page.waitFor(`document.querySelector('${id('composer-input')}').value === 'Keep this existing draft.'`);
  expect(await page.evaluate(`!!document.querySelector('${id('composer')} ${id('preview-reference')}')`)).toBe(false);
  await page.evaluate(`document.execCommand('redo')`);
  await page.waitFor(`document.querySelector('${id('composer')} ${id('preview-reference')}')`);
  await capture('preview-reference-desktop.png');
  await page.click(`${id('composer')} ${id('preview-reference')}`);
  await page.waitFor(`document.querySelector('iframe[data-browser-id]').contentDocument.querySelector('[data-boite-preview-highlight]')`);
  await page.type(id('composer-input'), 'Make this button easier to find. @Buy now');
  const turnsBefore = await onStore(`return store.openThread.turns.length;`);
  await page.click(id('composer-send'));
  await page.waitFor(`document.querySelector('[data-role="user"] ${id('preview-reference')}')`);
  await page.waitFor(`!document.querySelector('${id('composer')} ${id('preview-reference')}')`);
  expect(await onStore(`return store.openThread.turns.length;`)).toBe(Number(turnsBefore) + 1);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-role="user"] ${id('text-part')}')).at(-1).textContent`)).toBe('Make this button easier to find. @Buy now');
  // Disabling new selections keeps the references already in history usable.
  await page.evaluate(`import('/src/lib/experiments.ts').then(({ setExperiment }) => setExperiment('preview-comments', false))`);
  await page.click(id('panel-close'));
  await page.waitFor(`!document.querySelector('${id('right-panel')}')`);
  await page.click(`[data-role="user"] ${id('preview-reference')}`);
  await page.waitFor(`document.querySelector('iframe[data-browser-id]')?.contentDocument.querySelector('[data-boite-preview-highlight]')`);
  await capture('preview-reference-sent-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('preview-reference-highlight-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.evaluate(`import('/src/lib/experiments.ts').then(({ setExperiment }) => setExperiment('preview-comments', true))`);
  await page.click(id('preview-annotate'));
  await page.evaluate(`document.querySelector('iframe[data-browser-id]').contentDocument.querySelector('#preview-buy').click()`);
  await page.waitFor(`!document.querySelector('${id('right-panel')}')`);
  await page.waitFor(`document.querySelector('${id('composer')} ${id('preview-reference')}')`);
  await page.type(id('composer-input'), '@Buy now Keep the label short.');
  await capture('preview-reference-phone.png');
  expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe('@Buy now Keep the label short.');
  await page.type(id('composer-input'), 'Keep the label short.');
  await page.waitFor(`!document.querySelector('${id('composer')} ${id('preview-reference')}')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1310, height: 820, deviceScaleFactor: 1, mobile: false });
}, 60_000);
