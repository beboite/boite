import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { mobileAction } from './lib/mobile.ts';
import { startUi } from './lib/ui.ts';
import { showThreadView } from './lib/views.ts';

let server: { close(): Promise<void> };
let port: number;
beforeAll(async () => { port = await freePort(); server = await startUi(port); }, 60_000);
afterAll(async () => { await server?.close(); }, 30_000);

for (const width of [1280, 390]) {
  test(`a detected merge moves a running prompt to Done and retains its answer at ${width}px`, async () => {
    const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent&stream=tokens`, windowSize: { width, height: width < 720 ? 844 : 900 },
      args:['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4', '--renderer-process-limit=1', '--js-flags=--max-old-space-size=128'] });
    try {
      await page.waitFor('globalThis.__boiteTest?.workspace.active?.connection === "ready"');
      expect(await page.evaluate(`matchMedia('(hover: hover) and (pointer: fine)').matches`)).toBe(true);
      if (width < 720) await mobileAction(page, 'mobile-conversations');
      await showThreadView(page, 'projects', width < 720 ? 'mobile-' : '');
      const threadId = await page.evaluate<string>(`(async () => {
        const store = globalThis.__boiteTest.workspace.active;
        const thread = await store.client.call('threads.create', {projectId:'p-boite', providerId:'echo', accountId:'a-echo', title:'Finish the merge report', worktree:{branch:'boite/merge-report'}});
        // The seed clock is fixed; show elapsed time against the browser's wall clock.
        const started = Date.now();
        store.client.on('thread.updated', summary => {
          if (summary.id !== thread.id || summary.status !== 'running') return;
          const row = store.threads.find(row => row.id === thread.id);
          if (row) { row.runningSince = started; row.requestSince = started; }
        });
        await store.client.call('turns.start', {threadId:thread.id, prompt:'The change is merged. '.repeat(200) + 'Final merge report retained.'});
        return thread.id;
      })()`);
      const root = `[data-testid="${width < 720 ? 'mobile-list' : 'sidebar'}"]`;
      const project = `${root} [data-project-id="p-boite"]`;
      await page.waitFor(`document.querySelector('${root} [data-thread-id="${threadId}"] [data-testid="thread-state"][data-state="working"]')`);
      await page.evaluate(`(async () => {
        const store = globalThis.__boiteTest.workspace.active;
        const thread = await store.client.call('threads.get', {threadId:${JSON.stringify(threadId)}});
        store.client.setMergedPrFixture(thread.id, {repository:'github.com/example/repo', branch:thread.branch, tip:'a'.repeat(40), clean:true,
          candidates:[{repository:'github.com/example/repo', branch:thread.branch, sha:'a'.repeat(40), number:407, url:'https://github.com/example/repo/pull/407', mergedAt:'2026-10-23T12:00:00Z'}]});
        await store.client.call('threads.pullRequest', {threadId:thread.id});
      })()`);
      const toggle = `${project} [data-testid="project-done-toggle"]`;
      await page.waitFor(`document.querySelector('${toggle}')?.dataset.count === '1'`);
      await page.click(toggle);
      const done = `${root} [data-testid="done-thread"][data-thread-id="${threadId}"]`;
      await page.waitFor(`document.querySelector('${done} [data-testid="thread-state"][data-state="working"]')`);
      expect(await page.evaluate(`document.querySelector('${done} [data-testid="done-thread-pr"]')?.dataset.state`)).toBe('MERGED');
      await page.settleAnimations();
      await page.screenshot(join(import.meta.dir, '.artifacts', `merged-pr-running-done-${width}.png`));
      await page.evaluate(`document.querySelector('${done} [data-testid="done-thread-open"]').focus()`);
      await page.settleAnimations();
      expect(await page.evaluate(`getComputedStyle(document.querySelector('${done} [data-testid="thread-state"]')).opacity`)).toBe('0');
      expect(await page.evaluate(`getComputedStyle(document.querySelector('${done} [data-testid="done-thread-restore"]')).opacity`)).toBe('1');
      if (width >= 720) {
        const point = await page.evaluate<{x:number; y:number}>(`(() => {
          document.activeElement.blur();
          const box = document.querySelector('${done} [data-testid="done-thread-open"]').getBoundingClientRect();
          return {x:box.x + box.width / 2, y:box.y + 12};
        })()`);
        await page.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...point});
        await page.waitFor(`document.querySelector('${done}').matches(':hover') && getComputedStyle(document.querySelector('${done} [data-testid="thread-state"]')).opacity === '0' && getComputedStyle(document.querySelector('${done} [data-testid="done-thread-restore"]')).opacity === '1'`);
        expect(await page.evaluate(`document.querySelector('${done}').matches(':hover')`)).toBe(true);
        expect(await page.evaluate(`getComputedStyle(document.querySelector('${done} [data-testid="thread-state"]')).opacity`)).toBe('0');
        await page.screenshot(join(import.meta.dir, '.artifacts', `merged-pr-restore-hover-${width}.png`));
        await page.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:width - 1, y:1});
      } else {
        await page.send('Emulation.setTouchEmulationEnabled', {enabled:true, maxTouchPoints:1});
        await page.waitFor(`matchMedia('(hover: none)').matches && matchMedia('(pointer: coarse)').matches && getComputedStyle(document.querySelector('${done} [data-testid="thread-state"]')).opacity === '1' && getComputedStyle(document.querySelector('${done} [data-testid="done-thread-restore"]')).display === 'none'`);
        expect(await page.evaluate(`matchMedia('(hover: none)').matches && matchMedia('(pointer: coarse)').matches`)).toBe(true);
        expect(await page.evaluate(`getComputedStyle(document.querySelector('${done} [data-testid="thread-state"]')).opacity`)).toBe('1');
        expect(await page.evaluate(`getComputedStyle(document.querySelector('${done} [data-testid="done-thread-restore"]')).display`)).toBe('none');
        await page.screenshot(join(import.meta.dir, '.artifacts', `merged-pr-running-touch-${width}.png`));
      }
      await page.evaluate('document.activeElement.blur()');
      await page.waitFor(`globalThis.__boiteTest.workspace.active.client.call('threads.get', {threadId:${JSON.stringify(threadId)}}).then(t => t.status === 'idle')`, 20_000);
      const saved = await page.evaluate<{ archived: boolean; final: boolean }>(`globalThis.__boiteTest.workspace.active.client.call('threads.get', {threadId:${JSON.stringify(threadId)}}).then(t => ({archived:t.archived, final:t.messages.some(m => m.role === 'assistant' && m.parts.some(p => p.type === 'text' && p.text.endsWith('Final merge report retained.')))}))`);
      expect(saved).toEqual({ archived: true, final: true });
      await page.waitFor(`!document.querySelector('${done} [data-testid="thread-state"]')`);
      await page.screenshot(join(import.meta.dir, '.artifacts', `merged-pr-finished-done-${width}.png`));
    } finally { await page.close(); }
  }, 40_000);
}
