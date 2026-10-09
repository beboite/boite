import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

// The agent's browser runs on the machine of the conversation and every client
// watches it the same way: here the fake core's agent opens a page, and the
// panel brings the Agent browser tab forward, covered until the user shows it.
let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
const artifacts = join(import.meta.dir, '.artifacts');
const store = 'globalThis.__boiteTest.workspace.active';

async function capture(name: string) {
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
  await page.screenshot(join(artifacts, name));
}
/** What the agent's page says it received, through the agent's own snapshot. */
async function pageText(): Promise<string> {
  return page.evaluate<string>(`${store}.client.call('browser.command', { threadId: 't-trace', action: { kind: 'snapshot' } }).then(reply => reply.value.text)`);
}
/** A real pointer press and release in the middle of the shown frame. */
async function tapFrame() {
  const box = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${id('remote-browser-frame')}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 3 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased'] as const) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
async function size(width: number, height: number) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 720 });
}

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
  await size(1280, 900);
  await page.waitFor(`document.querySelector('[data-thread-id="t-trace"]')`);
  await page.click('[data-thread-id="t-trace"]');
  await page.waitFor(`${store}.openThread?.id === 't-trace'`);
}, 90_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('a page the agent opens shows the Agent browser covered, naming the machine; Show streams it and a tap reaches the page', async () => {
  const machine = await page.evaluate<string>(`globalThis.__boiteTest.workspace.machines.find(m => m.store === ${store}).label`);
  await page.evaluate(`${store}.client.call('browser.command', { threadId: 't-trace', action: { kind: 'open', url: 'https://example.com/docs' } })`);
  await page.waitFor(`document.querySelector('${id('agent-browser-cover-text')}')`);
  expect(await page.text(id('agent-browser-cover-text'))).toBe(`This agent controls a browser on ${machine}`);
  expect(await page.text(id('agent-browser-cover'))).toContain('example.com/docs');
  expect(await page.evaluate<number>(`document.querySelectorAll('${id('remote-browser-frame')}').length`)).toBe(0);
  await capture('agent-browser-cover-desktop.png');

  await page.click(id('agent-browser-show'));
  await page.waitFor(`document.querySelector('${id('remote-browser-frame')}')?.complete && document.querySelector('${id('remote-browser-frame')}').naturalWidth > 100`);
  expect(await page.evaluate<string>(`document.querySelector('${id('remote-browser-address')}').value`)).toBe('https://example.com/docs');
  await tapFrame();
  await page.waitFor(`${store}.client.call('browser.command', { threadId: 't-trace', action: { kind: 'snapshot' } }).then(reply => reply.value.text.includes('Taps: 1'))`);
  // The next frame draws the tap the page took.
  await Bun.sleep(1200);
  await capture('agent-browser-live-desktop.png');
  // The owner opens a tab from the strip, on a new tab page, and leaves it without opening anything.
  const loaded = `document.querySelector('${id('remote-browser-frame')}')?.complete && document.querySelector('${id('remote-browser-frame')}').naturalWidth > 100`;
  for (const [width, height, name] of [[390, 844, 'phone'], [1280, 900, 'desktop']] as const) {
    await size(width, height);
    await page.click(id('agent-browser-new'));
    await page.waitFor(`document.activeElement === document.querySelector('${id('agent-browser-start-address')}')`);
    await capture(`agent-browser-new-tab-${name}.png`);
    await page.click(id('agent-browser-draft-close'));
    await page.waitFor(loaded);
  }
  // A page entered there opens as a tab of its own, live at once.
  await page.click(id('agent-browser-new'));
  await page.waitFor(`document.activeElement === document.querySelector('${id('agent-browser-start-address')}')`);
  await page.evaluate(`(() => { const field = document.querySelector('${id('agent-browser-start-address')}'); field.value = 'shop.example/cart'; field.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('${id('agent-browser-start')}').requestSubmit(); })()`);
  await page.waitFor(`document.querySelectorAll('${id('agent-browser-tab')}').length === 2 && document.querySelector('${id('remote-browser-address')}')?.value === 'https://shop.example/cart'`);
  await page.waitFor(loaded);
  // Its × closes it; the agent's page comes back.
  await page.evaluate(`document.querySelectorAll('${id('agent-browser-close')}')[1].click()`);
  await page.waitFor(`document.querySelectorAll('${id('agent-browser-tab')}').length === 1 && document.querySelector('${id('remote-browser-address')}')?.value === 'https://example.com/docs'`);
  await page.waitFor(loaded);

  // Hide covers it again on this client; the phone width shows the same cover.
  await page.click(id('agent-browser-hide'));
  await page.waitFor(`document.querySelector('${id('agent-browser-cover')}')`);
  await size(390, 844);
  await page.waitFor(`document.querySelector('${id('agent-browser-show')}')?.getBoundingClientRect().width > 0`);
  await capture('agent-browser-cover-phone.png');
  await page.click(id('agent-browser-show'));
  await page.waitFor(`document.querySelector('${id('remote-browser-frame')}')?.complete && document.querySelector('${id('remote-browser-frame')}').naturalWidth > 100`);
  await tapFrame();
  await page.waitFor(`${store}.client.call('browser.command', { threadId: 't-trace', action: { kind: 'snapshot' } }).then(reply => reply.value.text.includes('Taps: 2'))`);
  expect(await pageText()).toContain('Taps: 2');
  await Bun.sleep(1200);
  await capture('agent-browser-live-phone.png');
  await size(1280, 900);
}, 60_000);

test('a device the agent opens shows the same cover naming the machine, and Show starts its frames', async () => {
  for (const [width, height, name] of [[1280, 900, 'desktop'], [390, 844, 'phone']] as const) {
    await size(width, height);
    await page.evaluate(`${store}.client.call('devices.list', { threadId: 't-trace' }).then(list => ${store}.client.call('devices.open', { threadId: 't-trace', deviceId: list.devices.find(device => device.platform === 'android').id }))`);
    await page.waitFor(`document.querySelector('${id('device-cover-text')}')?.getBoundingClientRect().width > 0`, 15_000);
    expect(await page.text(id('device-cover-text'))).toMatch(/^This agent controls a device on .+/);
    expect(await page.evaluate<number>(`document.querySelectorAll('${id('device-frame')}').length`)).toBe(0);
    await capture(`device-cover-${name}.png`);
    await page.click(id('device-show'));
    await page.waitFor(`document.querySelector('${id('device-frame')}')?.complete && document.querySelector('${id('device-frame')}').naturalWidth > 100`, 15_000);
    await capture(`device-live-${name}.png`);
    await page.click(id('device-hide'));
    await page.waitFor(`document.querySelector('${id('device-cover')}')`);
  }
  await size(1280, 900);
}, 60_000);
