import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui.ts';
let server: { close(): Promise<void> };
let page: BrowserPage;
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({url:`http://127.0.0.1:${port}/?fake=1&open=recent`,windowSize:{width:1300,height:850}});
  await page.waitFor(`document.querySelector('[data-thread-id]')`);
}, 90000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);
test('notification stays readable and can be dismissed', async () => {
  await page.evaluate(`(async () => { const {workspace} = await import('/src/lib/workspace.svelte.ts'); workspace.active.error = 'Could not connect to the build machine. Check the connection in Settings and try again. The current conversation is saved.'; })()`);
  await page.waitFor(`document.querySelector('[data-testid="error-toast"]')`);
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir,'.artifacts/notification-desktop.png'));
  expect(await page.evaluate(`document.querySelector('[data-testid="error-toast"]').textContent`)).toContain('conversation is saved');
  expect(await page.evaluate(`(() => {const p = document.querySelector('.notification-card p'); return p.scrollHeight <= p.clientHeight && getComputedStyle(p).whiteSpace === 'pre-wrap';})()`)).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await page.screenshot(join(import.meta.dir,'.artifacts/notification-phone.png'));
  expect(await page.evaluate(`(() => {const r = document.querySelector('[data-testid="error-toast"]').getBoundingClientRect();return r.left >= 0 && r.right <= innerWidth && r.bottom < innerHeight / 2;})()`)).toBe(true);
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await page.screenshot(join(import.meta.dir,'.artifacts/notification-light.png'));
  await page.click('[data-testid="error-toast"] button');
  await page.waitFor(`!document.querySelector('[data-testid="error-toast"]')`);
  expect(await page.evaluate(`(async () => {const {workspace} = await import('/src/lib/workspace.svelte.ts'); return workspace.active.error;})()`)).toBe(null);
});

test('older cores do not flood sidebar errors and manual lookup explains the missing feature', async () => {
  await page.send('Emulation.setDeviceMetricsOverride',{width:1300,height:850,deviceScaleFactor:1,mobile:false});
  await page.evaluate(`(async () => {
    const {workspace} = await import('/src/lib/workspace.svelte.ts');
    const {resetPullRequestSupport} = await import('/src/lib/pull-request.ts');
    const {RpcFailure} = await import('/src/lib/client.ts');
    const store = workspace.active;
    const client = store.client;
    const call = client.call.bind(client);
    window.__prCalls = 0;
    client.call = (method, params) => {
      if (method === 'threads.pullRequest') { window.__prCalls++; return Promise.reject(new RpcFailure({code:-32601,message:'unknown method threads.pullRequest'})); }
      return call(method, params);
    };
    resetPullRequestSupport(client);
    store.connection = 'connecting'; await new Promise(requestAnimationFrame); store.connection = 'ready';
  })()`);
  await page.waitFor(`window.__prCalls === 1`);
  expect(await page.evaluate(`document.querySelector('[data-testid="error-toast"]') === null`)).toBe(true);
  await page.evaluate(`document.querySelector('[data-testid="thread-row"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}))`);
  await page.waitFor(`document.querySelector('[role="menuitem"]')`);
  await page.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e => e.textContent.includes('Refresh pull request')).click()`);
  await page.waitFor(`document.querySelector('[data-testid="error-toast"]')?.textContent.includes('Update Boite')`);
  expect(await page.evaluate(`window.__prCalls`)).toBe(1);
});

test('unsupported goals identify the host without sending a normal turn', async () => {
  await page.evaluate(`(async () => {
    const {workspace} = await import('/src/lib/workspace.svelte.ts');
    const {RpcFailure} = await import('/src/lib/client.ts');
    const store = workspace.active; store.core.hostname = 'Older host';
    const client = store.client; const call = client.call.bind(client);
    window.__normalTurns = 0;
    client.call = (method, params) => {
      if (method === 'threads.activity.set') return Promise.reject(new RpcFailure({code:-32601,message:'unknown method threads.activity.set'}));
      if (method === 'turns.start') window.__normalTurns++;
      return call(method,params);
    };
    await store.send('/goal Verify two tasks');
  })()`);
  await page.waitFor(`document.querySelector('[data-testid="error-toast"]')?.textContent.includes('Update Boite on Older host')`);
  expect(await page.evaluate(`window.__normalTurns`)).toBe(0);
  await page.evaluate(`document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));`);
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir,'.artifacts/goal-compat-desktop.png'));
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir,'.artifacts/goal-compat-phone.png'));
});
