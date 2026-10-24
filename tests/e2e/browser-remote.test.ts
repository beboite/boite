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
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

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
  // The page takes the size of the view by default: the frame fills it with no band around it.
  await page.waitFor(`(() => { const area = document.querySelector('.screen-area'), shown = document.querySelector('.screen'); return !!shown && Math.abs(shown.offsetWidth - area.clientWidth) <= 2 && Math.abs(shown.offsetHeight - area.clientHeight) <= 2; })()`);
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
  await page.evaluate(`document.querySelector('.tab.selected ${id('agent-browser-close')}').click()`);
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

test('a tap on a list of the page opens its options over the frame, and a pick reaches the page', async () => {
  const loaded = `document.querySelector('${id('remote-browser-frame')}')?.complete && document.querySelector('${id('remote-browser-frame')}').naturalWidth > 100`;
  for (const [width, height, name, label] of [[1280, 900, 'desktop', 'Large'], [390, 844, 'phone', 'Medium']] as const) {
    await size(width, height);
    await page.waitFor(loaded);
    // The fake page's list spans 40..280 × 396..460 CSS pixels of a page drawn at half size.
    await page.waitFor(`(() => { const r = document.querySelector('${id('remote-browser-frame')}').getBoundingClientRect(); return r.width > 200; })()`);
    await Bun.sleep(800);
    const at = await page.evaluate<{ x: number; y: number }>(`(() => { const img = document.querySelector('${id('remote-browser-frame')}'), r = img.getBoundingClientRect(), scale = r.width / (img.naturalWidth * 2); return { x: r.x + 100 * scale, y: r.y + 420 * scale }; })()`);
    for (const type of ['mousePressed', 'mouseReleased'] as const) await page.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 });
    await page.waitFor(`document.querySelectorAll('${id('remote-browser-picker')} [role=option]').length === 4`);
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('${id('remote-browser-picker')} [role=option]')].map(row => row.textContent + (row.disabled ? ' (off)' : ''))`)).toEqual(['Small', 'Medium', 'Large', 'Huge (off)']);
    await capture(`agent-browser-select-${name}.png`);
    await page.evaluate(`[...document.querySelectorAll('${id('remote-browser-picker')} [role=option]')].find(row => row.textContent === '${label}').click()`);
    await page.waitFor(`!document.querySelector('${id('remote-browser-picker')}')`);
    await page.waitFor(`${store}.client.call('browser.command', { threadId: 't-trace', action: { kind: 'snapshot' } }).then(reply => reply.value.text.includes('combobox [ref=e3]: "${label}"'))`);
  }
  await Bun.sleep(1200);
  await capture('agent-browser-select-chosen-phone.png');
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

test('with the live stream on in Experiments, Show plays the device as video on a canvas', async () => {
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-experiments]');
  await page.waitFor(`document.querySelector('${id('device-stream-on')}')`);
  expect(await page.evaluate<boolean>(`document.querySelector('${id('device-stream-on')}').checked`)).toBe(false);
  await page.click(id('device-stream-on'));
  await page.waitFor(`${store}.settings?.deviceStream === true`);
  await page.evaluate(`document.querySelector('${id('device-stream-settings')}').scrollIntoView({ block: 'center' })`);
  await capture('device-stream-settings-desktop.png');
  await page.click('[data-testid=settings-back]');
  await page.waitFor(`document.querySelector('[data-thread-id="t-trace"]')`);
  for (const [width, height, name] of [[1280, 900, 'desktop'], [390, 844, 'phone']] as const) {
    await size(width, height);
    await page.evaluate(`${store}.client.call('devices.list', { threadId: 't-trace' }).then(list => ${store}.client.call('devices.open', { threadId: 't-trace', deviceId: list.devices.find(device => device.platform === 'android').id }))`);
    await page.waitFor(`document.querySelector('${id('device-show')}')?.getBoundingClientRect().width > 0`, 15_000);
    await page.click(id('device-show'));
    // The fake core streams 72×160 H.264 frames; the browser's own VideoDecoder draws them.
    await page.waitFor(`(() => { const canvas = document.querySelector('${id('device-stream')}'); return !!canvas && !canvas.hidden && canvas.width === 72 && canvas.height === 160; })()`, 15_000);
    expect(await page.evaluate<number>(`document.querySelectorAll('${id('device-frame')}').length`)).toBe(0);
    await Bun.sleep(500);
    await capture(`device-stream-${name}.png`);
    await page.click(id('device-hide'));
    await page.waitFor(`document.querySelector('${id('device-cover')}')`);
  }
  await page.evaluate(`${store}.saveSettings({ deviceStream: false })`);
  await size(1280, 900);
}, 60_000);

test('a phone chooses between chat and the agent browser without closing its pages or losing the draft', async () => {
  const origin = await page.evaluate<string>('location.origin');
  await size(390, 844);
  await page.evaluate(`localStorage.removeItem('boite:right-panel:v1'); localStorage.setItem('boite.locale', 'fr')`);
  await page.navigate(`${origin}/?fake=1&open=recent`);
  await page.waitFor(`${store}.connection === 'ready' && ${store}.openThread`);
  await page.evaluate(`${store}.open('t-trace')`);
  await page.waitFor(`${store}.openThread?.id === 't-trace' && document.querySelector('[data-testid=composer-input]')`);
  await page.evaluate(`(() => { const field = document.querySelector('[data-testid=composer-input]'); field.value = 'Keep this draft while the agent browses'; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  const first = await page.evaluate<string>(`${store}.client.call('browser.command', { threadId: 't-trace', action: { kind: 'open', url: 'https://example.com/docs' } }).then(reply => reply.tabId)`);
  await page.settleAnimations();
  expect(await page.evaluate(`${store}.panelOpen`)).toBe(false);
  expect(await page.evaluate(`document.querySelector('[data-testid=right-panel]') === null`)).toBe(true);
  await capture('agent-browser-chat-phone.png');

  await page.click(id('phone-browser-toggle'));
  await page.waitFor(`document.querySelector('${id('agent-browser-cover')}')`);
  await page.click(id('agent-browser-show'));
  await page.waitFor(`document.querySelector('${id('remote-browser-frame')}')?.naturalWidth > 100`);
  expect(await page.text(id('panel-close'))).toBe('Discussion');
  expect(await page.evaluate(`(() => { const back = document.querySelector('${id('panel-close')}'), tabs = document.querySelector('${id('panel-tabs')}'); const b = back.getBoundingClientRect(), t = tabs.getBoundingClientRect(); return back.scrollWidth <= back.clientWidth && b.height >= 44 && b.left >= 0 && b.right <= t.left && t.right <= innerWidth; })()`)).toBe(true);
  await capture('agent-browser-return-phone.png');
  await page.click(id('panel-close'));
  await page.waitFor(`!document.querySelector('${id('right-panel')}')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-input]').value`)).toBe('Keep this draft while the agent browses');
  expect(await page.evaluate(`${store}.client.call('browser.remoteStatus', { threadId: 't-trace' }).then(status => status.live && status.tabs.some(tab => tab.tabId === ${JSON.stringify(first)}))`)).toBe(true);
  expect(await pageText()).toContain('example.com/docs');

  // More pages never pull the phone back out of the chat.
  await page.evaluate(`${store}.client.call('panel.open', { threadId: 't-trace', surface: { kind: 'browser', url: 'https://shop.example/cart' } })`);
  await page.settleAnimations();
  expect(await page.evaluate(`${store}.panelOpen`)).toBe(false);
  await page.click(id('phone-browser-toggle'));
  await page.waitFor(`document.querySelectorAll('${id('agent-browser-tab')}').length === 2 && document.querySelector('${id('remote-browser-address')}')?.value === 'https://shop.example/cart'`);
  await page.evaluate('history.back()');
  await page.waitFor(`!document.querySelector('${id('right-panel')}')`);
  expect(await page.evaluate(`${store}.client.call('browser.remoteStatus', { threadId: 't-trace' }).then(status => status.tabs.length)`)).toBe(2);
  expect(await page.evaluate(`document.querySelector('[data-testid=composer-input]').value`)).toBe('Keep this draft while the agent browses');
  expect(page.errors()).toEqual([]);
}, 60_000);
