import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const button = '[data-testid="whip-button"]';
const toggle = '[data-testid="experiment-whip"]';

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations()
    .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))])`);
}

async function shake() {
  // Sample inside the page: another CDP round trip can miss the entire hit on a busy runner.
  return page.evaluate<boolean>(`(async () => {
    const root = document.getElementById('app');
    document.querySelector('${button}').click();
    const [animation] = root.getAnimations();
    if (!animation) return false;
    let moved = false;
    let frame;
    const sample = () => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(root).transform);
      moved ||= matrix.m41 !== 0 || matrix.m42 !== 0;
      frame = requestAnimationFrame(sample);
    };
    sample();
    await animation.finished;
    cancelAnimationFrame(frame);
    return moved;
  })()`);
}

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
  page = await BrowserPage.launch({ url });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.waitFor('document.querySelector("[data-testid=nav-settings]")');
}, 60_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('the Whip experiment shows a bottom-left button, shakes the whole app and turns off immediately', async () => {
  expect(await page.evaluate(`document.querySelector('${button}') === null`)).toBe(true);
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-experiments]');
  // Fail promptly if the experiment is absent, rather than waiting for a click timeout.
  expect(await page.evaluate(`!!document.querySelector('${toggle}')`)).toBe(true);
  await page.click(toggle);
  await page.waitFor(`document.querySelector('${button}')`);
  await page.click('[data-testid=settings-back]');
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'whip-desktop.png'));
  expect(await shake()).toBe(true);
  expect(await page.evaluate(`getComputedStyle(document.getElementById('app')).transform`)).toBe('none');
  await page.navigate(url);
  await page.waitFor(`document.querySelector('${button}')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('document.querySelector("[data-testid=mobile-tabs]")');
  await settled();
  expect(await page.evaluate(`(() => {
    const rect = document.querySelector('${button}').getBoundingClientRect();
    const tabs = document.querySelector('[data-testid=mobile-tabs]').getBoundingClientRect();
    const composer = document.querySelector('[data-testid=composer]').getBoundingClientRect();
    return rect.left < 24 && rect.bottom <= tabs.top && composer.bottom <= rect.top && rect.width >= 44 && rect.height >= 44;
  })()`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'whip-phone.png'));
  await page.click('[data-testid=mobile-settings]');
  await page.click('[data-testid=settings-tab-experiments]');
  await page.click('[data-testid=experiment-resident-agents]');
  await page.navigate(url);
  await page.waitFor('document.querySelector("[data-testid=mobile-agents]")');
  await settled();
  expect(await page.evaluate(`(() => {
    const whip = document.querySelector('${button}').getBoundingClientRect();
    const agents = document.querySelector('[data-testid=mobile-agents]');
    const tabs = document.querySelector('[data-testid=mobile-tabs]').getBoundingClientRect();
    const composer = document.querySelector('[data-testid=composer]').getBoundingClientRect();
    return whip.bottom <= agents.getBoundingClientRect().top && whip.bottom <= tabs.top && composer.bottom <= whip.top && agents.closest('nav') === null;
  })()`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'whip-agents-phone.png'));
  expect(await shake()).toBe(true);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.click(button);
  expect(await page.evaluate(`document.getElementById('app').getAnimations().length`)).toBe(0);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-experiments]');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  expect(await page.evaluate(`(() => {
    document.querySelector('${button}').click();
    const running = document.getElementById('app').getAnimations().length;
    document.querySelector('${toggle}').click();
    return running;
  })()`)).toBe(1);
  await page.waitFor(`document.querySelector('${button}') === null`);
  expect(await page.evaluate(`document.getElementById('app').getAnimations().length`)).toBe(0);
  expect(await page.evaluate('JSON.parse(localStorage.getItem("boite.experiments")).includes("whip")')).toBe(false);
  expect(page.errors()).toEqual([]);
}, 30_000);
