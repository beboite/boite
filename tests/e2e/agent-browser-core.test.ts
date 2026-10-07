import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '../../packages/core/src/client.ts';
import { findChromium } from '../../packages/core/src/browser/chromium.ts';
import { BrowserPage } from './lib/cdp.ts';
import { mintPairing, pairingUrlOf, startCore } from './lib/core.ts';
import { mobileAction } from './lib/mobile.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

// The whole path on a real core: the core starts its own headless Chromium for
// the conversation, the owner's desktop and a paired phone show it covered,
// then live, and a tap on the frame reaches the real page.
const id = (name: string) => `[data-testid="${name}"]`;
const artifacts = join(import.meta.dir, '.artifacts');
const real = findChromium().path ? test : test.skip;

const PAGE = `<!doctype html><title>Counter</title><style>body{margin:0;font:28px sans-serif;background:#eef}
button{position:absolute;left:0;top:0;width:100%;height:100%;font:48px sans-serif;background:#4a7;color:white;border:0}</style>
<button id="go" onclick="this.textContent='Clicked '+(++window.n)">Tap me</button><script>window.n=0</script>`;

// A field to type in and a line to copy, for the computer's keyboard and clipboard.
const TYPE = `<!doctype html><title>Notes</title><style>body{margin:0;font:28px sans-serif}
textarea{position:absolute;left:0;top:0;width:100%;height:50%;box-sizing:border-box;font:28px sans-serif}</style>
<textarea id="t"></textarea><p style="position:absolute;top:60%;left:20px">Below the field</p>`;

async function capture(page: BrowserPage, name: string) {
  await page.evaluate('document.fonts.ready');
  await page.screenshot(join(artifacts, name));
}
/** A real pointer press and release in the middle of the shown frame. */
async function tapFrame(page: BrowserPage, touch: boolean) {
  const box = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${id('remote-browser-frame')}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (touch) {
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [box] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else for (const type of ['mousePressed', 'mouseReleased'] as const) await page.send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 });
}
const frameShown = `document.querySelector('${id('remote-browser-frame')}')?.complete && document.querySelector('${id('remote-browser-frame')}').naturalWidth > 100`;

real('the core runs the agent browser; desktop and phone show it covered, then live, and their taps reach the page', async () => {
  ensureProductionUi();
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => new Response(new URL(request.url).pathname === '/type' ? TYPE : PAGE, { headers: { 'content-type': 'text/html' } }) });
  const core = await startCore();
  const owner = await connect(core.url, core.token);
  const pages: BrowserPage[] = [];
  try {
    await owner.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
    const cwd = join(core.dataDir, 'workspace');
    await mkdir(cwd);
    const project = await owner.call('projects.add', { path: cwd, name: 'Workspace' });
    const account = (await owner.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!;
    const thread = await owner.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Check the counter' });
    const button = async (tabId?: string) => (await owner.call('browser.command', { threadId: thread.id, ...(tabId ? { tabId } : {}), action: { kind: 'evaluate', expression: 'document.querySelector("#go").textContent' } })).value;

    for (const phone of [false, true]) {
      const page = await BrowserPage.launch({ url: phone ? await mintPairing(core) : pairingUrlOf(core), windowSize: { width: 1280, height: 900 } });
      pages.push(page);
      if (phone) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      } else await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      if (phone) await mobileAction(page, 'mobile-conversations');
      const row = phone ? id(`mobile-thread-${thread.id}`) : `[data-thread-id="${thread.id}"]`;
      await page.waitFor(`document.querySelector('${row}')`);
      await page.click(row);
      await Bun.sleep(1000);
      // The agent opens a page while the conversation is on screen: the panel comes forward, covered.
      const { tabId } = await owner.call('browser.command', { threadId: thread.id, action: { kind: 'open', url: site.url.href } });
      await page.waitFor(`document.querySelector('${id('agent-browser-cover-text')}')?.getBoundingClientRect().width > 0`, 20_000);
      expect(await page.text(id('agent-browser-cover-text'))).toMatch(/^This agent controls a browser on .+/);
      await page.waitFor(`document.querySelector('${id('agent-browser-cover')}').textContent.includes('Counter')`);
      expect(await page.evaluate<number>(`document.querySelectorAll('${id('remote-browser-frame')}').length`)).toBe(0);
      await capture(page, `agent-browser-core-cover-${phone ? 'phone' : 'desktop'}.png`);
      await page.click(id('agent-browser-show'));
      await page.waitFor(frameShown, 20_000);
      const before = await button(tabId);
      await tapFrame(page, phone);
      const deadline = Date.now() + 10_000;
      while (await button(tabId) === before && Date.now() < deadline) await Bun.sleep(100);
      expect(await button(tabId)).not.toBe(before);
      // The next frames draw what the page became.
      await Bun.sleep(1500);
      await capture(page, `agent-browser-core-live-${phone ? 'phone' : 'desktop'}.png`);
      // The phone keeps its text field and keys under the page.
      if (phone) { expect(await page.evaluate<number>(`document.querySelectorAll('${id('remote-browser-text')}, ${id('remote-browser-copy')}').length`)).toBe(2); continue; }
      // A computer has no text field under the page: a click, then its own keyboard and clipboard.
      expect(await page.evaluate<number>(`document.querySelectorAll('${id('remote-browser-text')}').length`)).toBe(0);
      const remote = async (expression: string) => (await owner.call('browser.command', { threadId: thread.id, tabId, action: { kind: 'evaluate', expression } })).value;
      const until = async (read: () => Promise<unknown>, wanted: unknown) => {
        const end = Date.now() + 10_000;
        let seen = await read();
        while (seen !== wanted && Date.now() < end) { await Bun.sleep(100); seen = await read(); }
        expect(seen).toBe(wanted);
      };
      await owner.call('browser.command', { threadId: thread.id, tabId, action: { kind: 'navigate', url: `${site.url.href}type` } });
      await page.waitFor(`document.querySelector('${id('remote-browser-address')}').value.endsWith('/type')`, 20_000);
      await Bun.sleep(600);
      const field = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${id('remote-browser-frame')}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 4 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased'] as const) await page.send('Input.dispatchMouseEvent', { type, ...field, button: 'left', clickCount: 1 });
      await until(() => remote('document.activeElement.id'), 't');
      const chord = async (key: string, command?: string) => {
        const base = { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), ...(command === undefined ? {} : { modifiers: 2 }) };
        await page.send('Input.dispatchKeyEvent', { type: command === undefined ? 'keyDown' : 'rawKeyDown', ...base, ...(command === undefined ? { text: key } : command ? { commands: [command] } : {}) });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      };
      for (const key of 'hello') await chord(key);
      await until(() => remote('document.querySelector("#t").value'), 'hello');
      // Control+V takes this computer's clipboard to the page, Control+A and Control+C bring the page's text back.
      await page.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
      await page.evaluate('navigator.clipboard.writeText(" collé ici")');
      await chord('v', 'paste');
      await until(() => remote('document.querySelector("#t").value'), 'hello collé ici');
      await page.evaluate('navigator.clipboard.writeText("")');
      await chord('a', '');
      await chord('c', 'copy');
      await until(() => page.evaluate<string>('navigator.clipboard.readText()'), 'hello collé ici');
      await Bun.sleep(1500);
      await capture(page, 'agent-browser-core-typed-desktop.png');
    }
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    owner.close();
    await core.stop();
    site.stop(true);
  }
}, 180_000);
