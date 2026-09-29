import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const id = (name: string) => `[data-testid="${name}"]`;
async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
async function appearance() {
  await page.waitFor(`document.querySelector('${id('nav-settings')}') || document.querySelector('${id('settings-tab-appearance')}')`);
  if (await page.evaluate(`!!document.querySelector('${id('nav-settings')}')`)) await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id('settings-tab-appearance')}')`);
  await page.click(id('settings-tab-appearance'));
  await page.waitFor(`document.querySelector('${id('appearance-page')}')`);
}
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
  page = await BrowserPage.launch({ url });
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('main colours can be edited, survive reload and keep separate light and dark palettes', async () => {
  await appearance();
  await page.click(id('theme-dark'));
  await capture('theme-colors-desktop.png');
  expect(await page.evaluate(`!!document.querySelector('${id('palette-tokyo-night')}')`)).toBe(true);
  await page.click(id('palette-tokyo-night'));
  await page.click(id('colors-customize'));
  await page.click(id('color-accent'));
  await page.type(id('color-hex'), 'invalid');
  expect(await page.evaluate(`document.querySelector('${id('color-hex')}').getAttribute('aria-invalid')`)).toBe('true');
  expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()`)).toBe('#7aa2f7');
  await page.click(id('color-background'));
  await page.type(id('color-hex'), '#14243a');
  await page.waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim() === '#14243a'`);
  await capture('theme-colors-custom-desktop.png');
  await page.navigate(url);
  await page.waitFor(`document.querySelector('${id('composer')}')`, 5_000);
  expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim()`)).toBe('#14243a');
  await appearance();
  await page.click(id('theme-light'));
  expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim()`)).not.toBe('#14243a');
  await page.click(id('palette-catppuccin'));
  await capture('theme-colors-light-desktop.png');
  await page.click(id('theme-dark'));
  expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim()`)).toBe('#14243a');
  await page.click(id('colors-customize'));
  await page.click(id('color-foreground'));
  await page.type(id('color-hex'), '#14243a');
  await page.waitFor(`document.querySelector('${id('colors-contrast-fix')}')`);
  await page.click(id('colors-contrast-fix'));
  await page.waitFor(`!document.querySelector('${id('colors-contrast-fix')}')`);
  await page.click(id('colors-undo'));
  await page.waitFor(`document.querySelector('${id('colors-contrast-fix')}')`);
  await page.click(id('colors-reset'));
  expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim()`)).toBe('#101013');
}, 30_000);

test('OLED selects dark appearance, restores pure black on reload and preserves the light palette', async () => {
  await page.navigate(url);
  await appearance();
  await page.click(id('theme-light'));
  await page.click(id('palette-catppuccin'));
  const lightGround = await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim()`);
  expect(lightGround).toBe('#eff1f5');
  await page.click(id('palette-oled'));
  expect(await page.evaluate(`localStorage.getItem('boite.theme')`)).toBe('dark');
  expect(await page.evaluate(`document.querySelector('${id('theme-dark')}').getAttribute('aria-pressed')`)).toBe('true');
  expect(await page.evaluate(`document.querySelector('${id('palette-oled')}').getAttribute('aria-pressed')`)).toBe('true');
  for (const token of ['background', 'frame', 'code-background']) {
    expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-${token}').trim()`)).toBe('#000000');
  }
  await page.evaluate(`document.querySelector('${id('theme-colors')}').scrollIntoView({block:'start'})`);
  await capture('theme-colors-oled-desktop.png');
  await page.navigate(url);
  await page.waitFor(`document.querySelector('${id('composer')}')`);
  expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim()`)).toBe('#000000');
  await capture('theme-colors-oled-conversation.png');
  await appearance();
  await page.click(id('palette-amethyst'));
  await page.evaluate(`document.querySelector('${id('theme-colors')}').scrollIntoView({block:'start'})`);
  await capture('theme-colors-amethyst-desktop.png');
  await page.navigate(url);
  await page.waitFor(`document.querySelector('${id('composer')}')`);
  await capture('theme-colors-amethyst-conversation.png');
  await appearance();
  await page.click(id('theme-light'));
  expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim()`)).toBe(lightGround);
}, 30_000);

test('phone colour controls support touch, keyboard and French without overflow', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.navigate(url);
  await appearance();
  await page.click(id('locale-fr'));
  await page.waitFor(`document.documentElement.lang === 'fr'`);
  await page.click(id('theme-light'));
  await page.click(id('palette-gruvbox'));
  await page.evaluate(`document.querySelector('${id('theme-colors')}').scrollIntoView({block:'start'})`);
  await capture('theme-colors-phone.png');
  await page.click(id('colors-customize'));
  await page.click(id('color-accent'));
  await page.evaluate(`document.querySelector('${id('color-picker')}').scrollIntoView({block:'center'})`);
  const before = await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()`);
  await page.evaluate(`document.querySelector('${id('color-plane')}').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }))`);
  expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()`)).not.toBe(before);
  const plane = await page.evaluate<{x:number;y:number}>(`(() => { const r = document.querySelector('${id('color-plane')}').getBoundingClientRect(); return { x:r.left+r.width*.6, y:r.top+r.height*.3 }; })()`);
  const beforeTouch = await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()`);
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...plane, id: 0 }] });
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()`)).not.toBe(beforeTouch);
  await capture('theme-colors-picker-phone.png');
  const bounds = await page.evaluate<{left:number;right:number;width:number}>(`(() => { const r = document.querySelector('${id('theme-colors')}').getBoundingClientRect(); return { left:r.left, right:r.right, width:document.documentElement.scrollWidth }; })()`);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(390);
  expect(bounds.width).toBeLessThanOrEqual(390);
  await page.click(id('colors-reset'));
  await page.waitFor(`document.querySelector('${id('colors-reset')}').disabled`);
}, 30_000);
