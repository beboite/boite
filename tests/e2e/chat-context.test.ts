import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
const req = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(req.resolve('vite'));
let server: { close(): Promise<void> };
let page: BrowserPage;
beforeAll(async () => {
  const port = await freePort();
  const vite = await createServer({root:join(import.meta.dir,'../../packages/ui'),server:{host:'127.0.0.1',port,strictPort:true}});
  server = vite; await vite.listen();
  page = await BrowserPage.launch({url:`http://127.0.0.1:${port}/?fake=1`,windowSize:{width:1300,height:850}});
  await page.waitFor(`document.querySelector('[data-thread-id]')`);
}, 90000);
afterAll(async () => { await page?.close(); await server?.close(); });

async function update(code: string) {
  await page.evaluate(`(async () => { const {workspace} = await import('/src/lib/workspace.svelte.ts'); const store = workspace.active; const thread = store.openThread; ${code} })()`);
}
async function capture(name: string) {
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir,'.artifacts',name + '.png'));
}
test('receipts follow actual activity, response indicator stays left and completion contains only duration', async () => {
  await update(`window.__answer = JSON.parse(JSON.stringify(thread.messages.at(-1)));`);
  await update(`thread.messages = thread.messages.filter(m => m.role === 'user'); const turn = thread.turns[0]; turn.status = 'running'; turn.startedAt = Date.now(); turn.finishedAt = null; thread.status = 'running';`);
  await page.waitFor(`document.querySelector('[data-testid="turn-summary"][data-status="running"]')`);
  expect(await page.evaluate(`document.querySelector('.author') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelectorAll('.receipts .received').length`)).toBe(1);
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-summary"]').textContent.trim()`)).toBe('');
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-summary"]').getBoundingClientRect().left < document.querySelector('.bubble').getBoundingClientRect().left`)).toBe(true);
  await page.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-testid="turn-summary"] svg')).animationName`)).toBe('none');
  await page.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await page.evaluate(`Object.defineProperty(document,'hidden',{value:true,configurable:true}); document.dispatchEvent(new Event('visibilitychange'));`);
  await page.waitFor(`getComputedStyle(document.querySelector('[data-testid="turn-summary"] svg')).animationPlayState === 'paused'`);
  await page.evaluate(`delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));`);
  await capture('quiet-chat-waiting');
  await update(`const answer = window.__answer; answer.parts = [{type:'text',text:'A complete answer.'}]; answer.state = 'streaming'; thread.messages.push(answer);`);
  await page.waitFor(`document.querySelectorAll('.receipts .received').length === 2`);
  await update(`const turn = thread.turns[0]; turn.status = 'done'; turn.finishedAt = turn.startedAt + 3800; thread.status = 'idle'; thread.messages.at(-1).state = 'complete';`);
  await page.waitFor(`document.querySelector('[data-testid="turn-summary"]').textContent.includes('3.8')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-summary"]').textContent.trim()`)).toBe('3.8 s');
  await capture('quiet-chat-done');
}, 30000);
test('context opens on hover, shows exact segments, and compaction needs its own click', async () => {
  await update(`thread.context = {tokens:31000,window:200000,at:Date.now(),breakdown:{input:18000,cache:10000,output:3000}}; thread.sessionId = 'test-session'; window.__compactCalls = 0; store.compact = async () => {window.__compactCalls++;};`);
  await page.evaluate(`document.querySelector('[data-testid="context-meter"]').dispatchEvent(new MouseEvent('mouseenter'))`);
  await page.waitFor(`document.querySelector('[data-testid="context-popup"]')`);
  expect(await page.evaluate(`window.__compactCalls`)).toBe(0);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="context-popup"] .bar span').length`)).toBe(3);
  expect(await page.evaluate(`document.querySelector('[data-testid="context-popup"]').textContent.includes((31000).toLocaleString())`)).toBe(true);
  await capture('quiet-context-desktop');
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await capture('quiet-context-phone');
  expect(await page.evaluate(`(() => {const r = document.querySelector('[data-testid="context-popup"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;})()`)).toBe(true);
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await capture('quiet-context-light');
  await page.click('[data-testid="context-compact"]');
  await page.waitFor(`!document.querySelector('[data-testid="context-popup"]')`);
  expect(await page.evaluate(`window.__compactCalls`)).toBe(1);
}, 30000);
