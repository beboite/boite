import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let port: number;
const id = (value: string) => `[data-testid="${value}"]`;
beforeAll(async () => { port = await freePort(); server = await startUi(port); }, 60_000);
afterAll(async () => { await server?.close(); }, 30_000);

/** Every box inside `selector` that its own button clips: none when the row grows with its text. */
const clipped = (selector: string) => `(() => {
  const row = document.querySelector('${selector}');
  const box = row.getBoundingClientRect();
  return [...row.querySelectorAll('span')].filter(span => {
    const inner = span.getBoundingClientRect();
    return inner.height > 0 && (inner.top < box.top - 0.5 || inner.bottom > box.bottom + 0.5);
  }).map(span => span.textContent);
})()`;

test('the contacts column\'s rows hold their text: the empty row\'s wrapped tip grows it instead of spilling over the title', async () => {
  const page = await BrowserPage.launch({ url: 'about:blank', windowSize: { width: 1280, height: 900 } });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      localStorage.setItem('boite.experiments', JSON.stringify(['contacts']));
      localStorage.setItem('boite.contacts-rail-folded', '0');` });
    await page.navigate(`http://127.0.0.1:${port}/?fake=1&open=recent`);
    await page.waitFor(`document.querySelector('${id('rail-contact')}')`);
    expect(await page.evaluate<string[]>(clipped(id('rail-contact')))).toEqual([]);

    await page.evaluate(`globalThis.__boiteTest.workspace.machines[0].store.client.call('contacts.remove', { coreId: 'core-chris' })`);
    await page.waitFor(`document.querySelector('${id('contacts-rail-empty')}')`);
    expect(await page.evaluate<string[]>(clipped(id('contacts-rail-empty')))).toEqual([]);
    const { head, row } = await page.evaluate<{ head: number; row: number }>(`({ head: document.querySelector('${id('contacts-rail-home')}').getBoundingClientRect().bottom,
      row: document.querySelector('${id('contacts-rail-empty')}').querySelector('.name').getBoundingClientRect().top })`);
    expect(row).toBeGreaterThanOrEqual(head);
    expect(page.errors()).toEqual([]);
  } finally { await page.close(); }
}, 30_000);

test('contact requests appear above desktop and phone pages and open the request to answer', async () => {
  const page = await BrowserPage.launch({ url: 'about:blank', windowSize: { width: 1440, height: 900 } });
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('boite.experiments', JSON.stringify(['contacts']));` });
    await page.navigate(`http://127.0.0.1:${port}/?fake=1&open=recent`);
    await page.waitFor(`document.querySelector('${id('contact-request-notice')}')`);
    await page.evaluate(`globalThis.__boiteTest.setTheme('dark')`);
    await page.settleAnimations();
    expect(await page.evaluate(`document.querySelector('${id('contact-request-notice')}').getBoundingClientRect().width > 0`)).toBe(true);
    await page.screenshot(join(import.meta.dir, '.artifacts/contact-request-desktop.png'));

    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.waitFor(`document.querySelector('${id('mobile-header')} ${id('contact-request-open')}')`);
    await page.settleAnimations();
    expect(await page.evaluate(`document.querySelector('${id('contact-request-notice')}').getBoundingClientRect().width > 0`)).toBe(true);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.screenshot(join(import.meta.dir, '.artifacts/contact-request-phone.png'));
    await page.click(id('contact-request-review'));
    await page.waitFor(`document.querySelector('${id('contact-requests')} ${id('contact-request-creq-pending')}')`);
    await page.evaluate(`globalThis.__boiteTest.workspace.active.client.call('contacts.decide', { id: 'creq-pending', accept: false, reason: 'The shared work is finished.' })`);
    await page.waitFor(`!document.querySelector('${id('contact-request-open')}')`);
    expect(page.errors()).toEqual([]);
  } finally { await page.close(); }
}, 30_000);

test('the shared project picker searches every linked machine on desktop and phone', async () => {
  const page = await BrowserPage.launch({ url: 'about:blank', windowSize: { width: 1440, height: 1000 } });
  const picker = id('contact-open-core-chris');
  const search = id('contact-open-core-chris-search');
  const remoteGrant = `${id('contact-grant-p-notes')}[data-machine-id="http://builder.test"]`;
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('boite.experiments', JSON.stringify(['contacts']));` });
    await page.navigate(`http://127.0.0.1:${port}/?fake=1&machines=1`);
    await page.waitFor(`globalThis.__boiteTest?.workspace.machines.length === 2`);
    await page.evaluate(`globalThis.__boiteTest.setTheme('dark'); globalThis.__boiteTest.workspace.active.showHome('core-chris')`);
    await page.waitFor(`document.querySelector('${picker}')`);
    await page.click(picker);
    await page.waitFor(`document.querySelector('${search}')`);
    await page.settleAnimations();
    const choices = `${id('contact-open-core-chris-list')} [role=option]`;
    expect(await page.evaluate(`Array.from(document.querySelectorAll('${choices}')).map(row => JSON.parse(row.dataset.value)[0])`)).toEqual(['local', 'http://builder.test']);
    expect(await page.evaluate(`document.querySelector('${id('contact-open-core-chris-menu')}').textContent`)).toContain('Builder');
    await page.screenshot(join(import.meta.dir, '.artifacts', 'contact-share-desktop.png'));
    await page.type(search, 'notes Builder');
    expect(await page.evaluate(`document.querySelectorAll('${choices}').length`)).toBe(1);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.waitFor(`document.querySelector('${remoteGrant}')`);
    expect(await page.evaluate(`document.querySelectorAll('${id('contact-grant-p-notes')}').length`)).toBe(1);
    expect(await page.evaluate(`globalThis.__boiteTest.workspace.active === globalThis.__boiteTest.workspace.primary`)).toBe(true);
    await page.evaluate(`document.querySelector('${id('contact-shared')}').scrollIntoView({block:'center'})`);
    await page.settleAnimations();
    await page.screenshot(join(import.meta.dir, '.artifacts', 'contact-share-granted-desktop.png'));

    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.click(picker);
    await page.waitFor(`document.querySelector('${search}')`);
    await page.settleAnimations();
    const bounds = await page.evaluate<{ left: number; right: number; bottom: number }>(`(() => { const r = document.querySelector('${id('contact-open-core-chris-menu')}').getBoundingClientRect(); return {left:r.left,right:r.right,bottom:r.bottom}; })()`);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(390);
    expect(bounds.bottom).toBeLessThanOrEqual(844);
    await page.screenshot(join(import.meta.dir, '.artifacts', 'contact-share-phone.png'));
    await page.type(search, 'no-such-project');
    expect(await page.evaluate(`document.querySelectorAll('${choices}').length`)).toBe(0);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    expect(await page.evaluate(`document.querySelector('${picker}').getAttribute('aria-expanded')`)).toBe('true');
    // Escape clears the query, then closes the same picker and restores its trigger.
    for (let step = 0; step < 2; step++) await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.waitFor(`!document.querySelector('${id('contact-open-core-chris-menu')}')`);
    expect(await page.evaluate(`document.activeElement === document.querySelector('${picker}')`)).toBe(true);
    expect(page.errors()).toEqual([]);
  } finally { await page.close(); }
}, 30_000);
