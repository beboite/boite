import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui';
import { confirmDeletion } from './lib/thread-removal';

let server: { close(): Promise<void> };
let url: string;
const state = 'globalThis.__boiteTest.workspace.active';
const id = (name: string) => `[data-testid="${name}"]`;
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
}, 30_000);
afterAll(async () => { await server?.close(); });

async function capture(page: BrowserPage, name: string) {
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

async function drag(page: BrowserPage, selector: string) {
  const box = await page.evaluate<{ x: number; y: number; width: number }>(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'});
    const range = document.createRange(); range.selectNodeContents(e);
    const r = e.matches('p') ? range.getClientRects()[0] : e.getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2, width: r.width - 10 };
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 5; step++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + Math.min(100, box.width) * step / 5, y: box.y, button: 'left', buttons: 1 });
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + Math.min(100, box.width), y: box.y, button: 'left', buttons: 0, clickCount: 1 });
}

test('closing an image and dragging chat text or a thread link preserves the conversation', async () => {
  const page = await BrowserPage.launch({ url, windowSize: { width: 1280, height: 900 } });
  try {
    await page.waitFor(`${state}.openThread`);
    await page.evaluate(`(async () => {
      const s = ${state}; await s.open('t-trace');
      s.openThread.memoryEvents = [];
      const canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 96;
      const context = canvas.getContext('2d'); const style = getComputedStyle(document.body);
      context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 192, 96);
      context.fillStyle = style.color; context.font = '16px sans-serif'; context.fillText('Selection reference', 12, 52);
      const parts = [
        { type: 'text', text: 'Select these words after closing the reference image. The conversation should stay open. [Launch game](build/game.exe)' },
        { type: 'file', name: 'reference.png', mimeType: 'image/png', bytes: 100, data: canvas.toDataURL().split(',')[1] }
      ];
      s.openThread.messages = [
        { id:'selection-message', threadId:'t-trace', turnId:'selection-turn', role:'assistant', state:'complete', createdAt:Date.now(), parts },
        { id:'selection-link', threadId:'t-trace', turnId:'selection-turn', role:'system', state:'complete', createdAt:Date.now()+1, parts:[{type:'text', text:'A linked conversation follows below.', started:{threadId:'t-descriptors', title:'Descriptor review', project:'notes'}}] }
      ];
    })()`);
    await page.waitFor(`document.querySelector('${id('artifact-enlarge')} img')?.naturalWidth === 192`);
    await page.click(id('artifact-enlarge'));
    await page.waitFor(`document.querySelector('${id('image-viewer')}')`);
    await page.click(id('image-viewer-close'));
    await page.waitFor(`!document.querySelector('${id('image-viewer')}')`);
    await capture(page, 'thread-selection-before.png');
    await drag(page, `${id('text-part')} p`);
    await capture(page, 'thread-selection-after.png');
    expect(await page.evaluate('window.getSelection().toString().length > 0')).toBe(true);
    expect(await page.evaluate(`${state}.openThread.id`)).toBe('t-trace');
    await page.evaluate(`(() => {
      window.__fileOpens = [];
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => { if (command === 'open_local_file') window.__fileOpens.push(args); } };
      ${state}.localCore = true;
    })()`);
    await page.evaluate('window.getSelection().removeAllRanges()');
    await drag(page, 'a[data-file-path="build/game.exe"]');
    expect(await page.evaluate('window.__fileOpens.length')).toBe(0);
    expect(await page.evaluate(`${state}.openThread.id`)).toBe('t-trace');
    await page.click('a[data-file-path="build/game.exe"]');
    await page.waitFor('window.__fileOpens.length === 1');
    expect(await page.evaluate('window.__fileOpens[0].path')).toBe('build/game.exe');
    await page.evaluate(`delete window.__TAURI_INTERNALS__; ${state}.localCore = false;`);
    await page.evaluate('window.getSelection().removeAllRanges()');
    await drag(page, id('spawn-marker-open'));
    expect(await page.evaluate(`${state}.openThread.id`)).toBe('t-trace');
    await capture(page, 'thread-selection-desktop.png');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await capture(page, 'thread-selection-phone.png');
    const tap = await page.evaluate<{ x: number; y: number }>(`(() => { const e = document.querySelector('${id('spawn-marker-open')}'); e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return {x:r.left + r.width / 2, y:r.top + r.height / 2}; })()`);
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tap] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitFor(`${state}.openThread?.id === 't-descriptors'`);
    expect(page.errors()).toEqual([]);
  } finally { await page.close(); }
}, 30_000);

test('dropping URL text keeps the app open and still inserts text in the composer', async () => {
  const page = await BrowserPage.launch({ url, windowSize: { width: 1280, height: 900 } });
  try {
    await page.waitFor(`${state}.openThread`);
    const text = url + '&dropped=1';
    await page.evaluate(`(async () => {
      await ${state}.open('t-trace');
      document.addEventListener('dragover', event => { window.__textDropOver = event.defaultPrevented; });
    })()`);
    for (const phone of [false, true]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: phone ? 390 : 1280, height: phone ? 844 : 900, deviceScaleFactor: 1, mobile: phone });
      for (const target of ['timeline', 'composer-input']) {
        const point = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${id(target)}').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
        const data = { items: [{ mimeType: 'text/uri-list', data: text }, { mimeType: 'text/plain', data: text }], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver']) await page.send('Input.dispatchDragEvent', { type, ...point, data });
        expect(await page.evaluate('window.__textDropOver')).toBe(target === 'timeline');
        await page.send('Input.dispatchDragEvent', { type: 'drop', ...point, data });
        const history = await page.send('Page.getNavigationHistory', {}) as { currentIndex: number; entries: Array<{ url: string }> };
        expect(history.entries[history.currentIndex]!.url).toBe(url);
        expect(await page.evaluate(`${state}.openThread.id`)).toBe('t-trace');
        if (target === 'composer-input') {
          expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe(text);
          await page.type(id('composer-input'), '');
        }
      }
      await capture(page, `text-drop-${phone ? 'phone' : 'desktop'}.png`);
    }
    expect(page.errors()).toEqual([]);
  } finally { await page.close(); }
}, 30_000);

test('archive and delete leave a project draft on desktop and phone', async () => {
  const page = await BrowserPage.launch({ url, windowSize: { width: 1280, height: 900 } });
  try {
    await page.waitFor(`${state}.openThread`);
    for (const phone of [false, true]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: phone ? 390 : 1280, height: phone ? 844 : 900, deviceScaleFactor: 1, mobile: phone });
      for (const action of ['archive', 'delete']) {
        await page.evaluate(`(async () => {
          const s = ${state}; const row = await s.client.call('threads.create', {projectId:'p-boite', title:'Navigation check', providerId:'echo', accountId:'a-echo', model:'echo-1', permissionMode:'default'});
          await globalThis.__boiteTest.workspace.select(s, row.id);
        })()`);
        await page.waitFor(`document.querySelector('${id('thread-menu-trigger')}')`);
        const threadId = await page.evaluate<string>(`${state}.openThread.id`);
        await page.click(id('thread-menu-trigger'));
        await page.click(`${id('thread-menu-trigger-menu')} [data-value=${action}]`);
        if (action === 'delete') await confirmDeletion(page, threadId);
        await page.waitFor(`${state}.openThread === null && ${state}.draft?.projectId === 'p-boite'`);
        expect(await page.evaluate(`!!document.querySelector('${id('composer-input')}')`)).toBe(true);
        expect(await page.evaluate(`${state}.openThread`)).toBeNull();
      }
      await capture(page, `thread-cleared-${phone ? 'phone' : 'desktop'}.png`);
    }
    expect(page.errors()).toEqual([]);
  } finally { await page.close(); }
}, 30_000);

test('projects sink after losing recent threads and the sidebar follows a selected project promoted by a prompt', async () => {
  const page = await BrowserPage.launch({ url, windowSize: { width: 1280, height: 900 } });
  try {
    await page.waitFor(`${state}.openThread`);
    await page.evaluate(`globalThis.__boiteTest.workspace.view = 'projects'`);
    await page.evaluate(`(async () => {
      const s = ${state}; s.collapsedProjects = s.projects.map(p => p.id);
      for (let i = 0; i < 24; i++) {
        const p = await s.client.call('projects.add', {path:'/workspace/navigation/project-' + i});
        await s.client.call('threads.create', {projectId:p.id, title:'Conversation ' + i, providerId:'echo', accountId:'a-echo', model:'echo-1', permissionMode:'default'});
        s.collapsedProjects.push(p.id);
      }
      const base = Date.now() + 100000;
      s.threads = s.threads.map((t, i) => ({...t, lastUserMessageAt:base + i * 1000}));
      const target = s.threads.find(t => t.title === 'Conversation 0');
      await globalThis.__boiteTest.workspace.select(s, target.id);
      s.threads.find(t => t.id === target.id).lastUserMessageAt = base;
    })()`);
    await page.waitFor(`document.querySelectorAll('${id('project')}').length === 26`);
    await page.evaluate(`document.querySelector('${id('sidebar')} .scroll').scrollTop = 500`);
    await page.waitFor(`document.querySelector('${id('sidebar')} .scroll').scrollTop >= 400`);
    await capture(page, 'project-promotion-before.png');
    await page.evaluate(`(() => { const s = ${state}; const t = s.threads.find(t => t.id === s.openThread.id); t.lastUserMessageAt = Date.now() + 1000000; })()`);
    await page.waitFor(`document.querySelector('${id('project')}')?.dataset.projectId === ${state}.openThread.projectId`);
    await page.waitFor(`document.querySelector('${id('sidebar')} .scroll').scrollTop === 0`);
    await capture(page, 'project-promotion-after.png');
    await page.evaluate(`${state}.archive(${state}.openThread.id)`);
    await page.waitFor(`${state}.draft`);
    expect(await page.evaluate(`document.querySelector('${id('project')}').dataset.projectId === ${state}.draft.projectId`)).toBe(false);
    expect(await page.evaluate(`${state}.openThread`)).toBeNull();
    expect(page.errors()).toEqual([]);
  } finally { await page.close(); }
}, 40_000);
