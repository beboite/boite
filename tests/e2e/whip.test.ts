import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
let button = '[data-testid="whip-button"]';
const toggle = '[data-testid="experiment-whip"]';

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations()
    .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))])`);
}

/** In-page: throws the rope, checks the throw moved nothing, then flicks until a crack starts the shake. */
const crack = () => `(async () => {
    const root = document.getElementById('app');
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    document.querySelector('${button}').click();
    for (let i = 0; i < 30; i++) await frame();
    if (root.getAnimations().length) return undefined;
    // A phone is too narrow for a sideways flick to reach crack speed.
    const tall = window.innerHeight > window.innerWidth;
    for (let i = 0; i < 600 && !root.getAnimations().length; i++) {
      const swing = Math.sin(i / 1.5) * 200;
      window.dispatchEvent(new PointerEvent('pointermove', {
        clientX: window.innerWidth / 2 + (tall ? 0 : swing), clientY: window.innerHeight / 2 + (tall ? swing : 0)
      }));
      await frame();
    }
    return root.getAnimations()[0];
  })()`;

async function shake() {
  // Sample inside the page: another CDP round trip can miss the entire hit on a busy runner.
  return page.evaluate<boolean>(`(async () => {
    const root = document.getElementById('app');
    const animation = await ${crack()};
    if (!animation) return false;
    let moved = false;
    let request;
    const sample = () => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(root).transform);
      moved ||= matrix.m41 !== 0 || matrix.m42 !== 0;
      request = requestAnimationFrame(sample);
    };
    sample();
    await animation.finished;
    cancelAnimationFrame(request);
    return moved;
  })()`);
}

async function verifyRope(capture: string, touch = false) {
  const canvas = '[data-testid=whip-canvas]';
  await page.waitFor(`document.querySelector('${canvas}')?.width > 0`);
  const pixels = () => page.evaluate<string>(`(() => {
    const canvas = document.querySelector('${canvas}');
    return canvas.toDataURL();
  })()`);
  const before = await pixels();
  if (touch) {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y: 450 }] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 220, y: 400 }] });
  } else {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 650, y: 500 });
  }
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  expect(await pixels()).not.toBe(before);
  expect(await page.evaluate(`(() => {
    const canvas = document.querySelector('${canvas}');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) ink++;
    return ink > 100;
  })()`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', capture));
  if (touch) {
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  } else {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 650, y: 500, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 650, y: 500, button: 'left', clickCount: 1 });
  }
  await page.waitFor(`document.querySelector('${canvas}') === null`);
}

async function rethrowFromControl() {
  await page.click(button);
  await page.waitFor(`document.querySelector('[data-testid=whip-canvas]')`);
  await settled();
  await page.click(button);
  await page.waitFor(`document.querySelector('${button}').getAttribute('aria-pressed') === 'false'`);
  expect(await page.evaluate(`(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    window.dispatchEvent(event);
    return !event.defaultPrevented;
  })()`)).toBe(true);
  // Real pointer clicks must reach the control above the falling canvas.
  expect(await page.evaluate(`!!document.querySelector('[data-testid=whip-canvas]')`)).toBe(true);
  await page.click(button);
  await page.waitFor(`document.querySelector('${button}').getAttribute('aria-pressed') === 'true'`);
  await settled();
  await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await page.waitFor(`document.querySelector('[data-testid=whip-canvas]') === null`);
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

test('the Whip experiment uses footer controls, animates a rope and turns off immediately', async () => {
  expect(await page.evaluate(`document.querySelector('${button}') === null`)).toBe(true);
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-experiments]');
  // Fail promptly if the experiment is absent, rather than waiting for a click timeout.
  expect(await page.evaluate(`!!document.querySelector('${toggle}')`)).toBe(true);
  await page.click(toggle);
  await page.click('[data-testid=settings-back]');
  await page.waitFor(`document.querySelector('${button}')`);
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'whip-desktop.png'));
  expect(await page.evaluate(`document.querySelector('${button}').closest('.foot') !== null`)).toBe(true);
  expect(await shake()).toBe(true);
  await verifyRope('whip-rope-desktop.png');
  await page.evaluate(`globalThis.__boiteTest.setTheme('dark')`);
  expect(await shake()).toBe(true);
  await verifyRope('whip-rope-dark.png');
  await rethrowFromControl();
  // Escape releases the toy without triggering the app's underlying shortcuts.
  expect(await shake()).toBe(true);
  await page.waitFor(`document.querySelector('[data-testid=whip-canvas]')`);
  await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await page.waitFor(`document.querySelector('[data-testid=whip-canvas]') === null`);
  expect(await shake()).toBe(true);
  await page.waitFor(`document.querySelector('[data-testid=whip-canvas]')`);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.waitFor(`document.querySelector('[data-testid=whip-canvas]') === null`);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.evaluate(`globalThis.__boiteTest.setTheme('light')`);
  expect(await page.evaluate(`getComputedStyle(document.getElementById('app')).transform`)).toBe('none');
  await page.navigate(url);
  await page.waitFor(`document.querySelector('${button}')`);
  button = '[data-testid=whip-button-mobile]';
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('document.querySelector("[data-testid=mobile-tabs]")');
  await settled();
  expect(await page.evaluate(`(() => {
    const rect = document.querySelector('${button}').getBoundingClientRect();
    const tabs = document.querySelector('[data-testid=mobile-tabs]').getBoundingClientRect();
    const composer = document.querySelector('[data-testid=composer]').getBoundingClientRect();
    return document.querySelector('${button}').closest('.mobile-navigation') !== null && rect.right <= tabs.left && rect.top >= tabs.top && composer.bottom <= rect.top && rect.width >= 44 && rect.height >= 44;
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
    return whip.right <= agents.getBoundingClientRect().left && whip.right <= tabs.left && composer.bottom <= whip.top && agents.closest('nav') === null;
  })()`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'whip-agents-phone.png'));
  expect(await shake()).toBe(true);
  await verifyRope('whip-rope-phone.png', true);
  await rethrowFromControl();
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.click(button);
  expect(await page.evaluate(`document.getElementById('app').getAnimations().length`)).toBe(0);
  expect(await page.evaluate(`document.querySelector('[data-testid=whip-canvas]') === null`)).toBe(true);
  await page.click('[data-testid=mobile-settings]');
  await page.click('[data-testid=settings-tab-experiments]');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  // Switching the experiment off mid-hit stops the shake with the rope.
  expect(await page.evaluate(`(async () => {
    const running = await ${crack()};
    if (!running) return 'no shake';
    document.querySelector('${toggle}').click();
    return 'cracked';
  })()`)).toBe('cracked');
  await page.waitFor(`document.querySelector('${button}') === null`);
  expect(await page.evaluate(`document.querySelector('[data-testid=whip-canvas]') === null`)).toBe(true);
  expect(await page.evaluate(`document.getElementById('app').getAnimations().length`)).toBe(0);
  expect(await page.evaluate('JSON.parse(localStorage.getItem("boite.experiments")).includes("whip")')).toBe(false);
  expect(page.errors()).toEqual([]);
}, 45_000);
