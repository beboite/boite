import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

// `team=1` seeds a running workflow and its subagents on `t-trace`: the bar
// that counts them stands between the timeline and the composer, where the
// band of tasks floats.
let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
async function size(phone: boolean) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: phone ? 390 : 1280, height: phone ? 844 : 900, deviceScaleFactor: 1, mobile: phone
  });
  await page.waitFor(`innerWidth === ${phone ? 390 : 1280}`);
}
async function settle() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  // The band measures itself on the next frame; the timeline's reserve follows.
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&team=1` });
  await page.waitFor(`document.querySelector('${id('thread-row')}[data-thread-id="t-trace"]')`);
  await size(false);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

test('the task band stacks above the subagent bar, folded and open, on desktop and phone', async () => {
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => store.open('t-trace'))`);
  await page.waitFor(`document.querySelector('${id('active-subagents')}')?.textContent.includes('1 workflow')`);
  // Enough to scroll, so the last message has to clear the band at the bottom.
  await page.evaluate(`globalThis.__boiteTest.workspace.active.openThread.messages.at(-1).parts.push({ type: 'text', text: 'Earlier conversation context.\\n'.repeat(80) })`);
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => { store.openThread.activity = {goal:null,loop:null,tasks:[
    {id:'read',text:'Read the review findings',status:'completed'},
    {id:'wait',text:'Wait for the reviewer subagent',status:'in_progress'}
  ]}; })`);
  await page.waitFor(`document.querySelector('${id('activity-tasks-toggle')}')`);
  const layout = `(() => {
    const band = document.querySelector('${id('thread-activity')}').getBoundingClientRect();
    const bar = document.querySelector('${id('active-subagents')}').getBoundingClientRect();
    const covering = document.elementFromPoint(bar.left + bar.width / 2, bar.top + bar.height / 2);
    const messages = document.querySelectorAll('[data-mid]');
    return { gap: bar.top - band.bottom, barOnTop: !!covering?.closest('${id('agent-dock')}'), lastClear: messages[messages.length - 1].getBoundingClientRect().bottom <= band.top };
  })()`;
  for (const phone of [false, true]) {
    await size(phone);
    for (const open of [false, true]) {
      if (await page.evaluate(`document.querySelector('${id('activity-tasks-toggle')}').getAttribute('aria-expanded') === 'true'`) !== open) await page.click(id('activity-tasks-toggle'));
      await page.evaluate(`document.querySelector('${id('timeline')}').scrollTop = document.querySelector('${id('timeline')}').scrollHeight`);
      await settle();
      const at = await page.evaluate<{ gap: number; barOnTop: boolean; lastClear: boolean }>(layout);
      await page.screenshot(join(import.meta.dir, '.artifacts', `activity-agent-dock-${open ? 'open' : 'folded'}-${phone ? 'phone' : 'desktop'}.png`));
      expect(at.gap).toBeGreaterThanOrEqual(0);
      expect(at.barOnTop).toBe(true);
      // Open details overlay the timeline by design; the folded band keeps the latest message in view.
      if (!open) expect(at.lastClear).toBe(true);
    }
  }
  // A notice standing in the same column leaves the bar where the band expects it, on the composer.
  await size(false);
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => { store.openThread.retry = { kind: 'capacity', turnId: 'turn-retry', at: Date.now() + 600_000, attempt: 1, attempts: 3 }; })`);
  await page.waitFor(`document.querySelector('${id('thread-retry')}')`);
  await settle();
  const withNotice = await page.evaluate<{ gap: number; barOnTop: boolean }>(layout);
  expect(withNotice.gap).toBeGreaterThanOrEqual(0);
  expect(withNotice.barOnTop).toBe(true);
  await page.evaluate(`import('/src/lib/store.svelte.ts').then(({store}) => { store.openThread.retry = null; })`);
  // Queued prompts make room for the band inside the composer: it stays under them, the bar above them all.
  await page.evaluate(`globalThis.__boiteTest.workspace.active.composerStates['t-trace'] = { text: '', attachments: [], queued: [{ text: 'Check the review once the subagent is back', attachments: [] }], paused: true, sending: false }`);
  await page.waitFor(`(() => { const band = document.querySelector('${id('thread-activity')}'); return band.offsetHeight > 0 && parseFloat(document.querySelector('.queue-region').style.paddingBottom) === band.offsetHeight; })()`);
  await settle();
  const stack = await page.evaluate<{ order: boolean; barOnTop: boolean }>(`(() => {
    const [bar, queue, band, composer] = ['${id('active-subagents')}', '${id('composer-queued')}', '${id('thread-activity')}', '${id('composer')}'].map(selector => document.querySelector(selector).getBoundingClientRect());
    const covering = document.elementFromPoint(bar.left + bar.width / 2, bar.top + bar.height / 2);
    return { order: bar.bottom <= queue.top && queue.bottom <= band.top && band.bottom <= composer.top, barOnTop: !!covering?.closest('${id('agent-dock')}') };
  })()`);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'activity-agent-dock-queued-desktop.png'));
  expect(stack).toEqual({ order: true, barOnTop: true });
  expect(page.errors()).toEqual([]);
}, 60_000);
