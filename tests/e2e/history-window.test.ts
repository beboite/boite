import { expect, test } from 'bun:test';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore } from './lib/core.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

const timeline = '[data-testid=timeline]';

test('history read above rows the window never measured stays still once the wheel stops', async () => {
  ensureProductionUi();
  const core = await startCore();
  const client = await connect(core.url, core.token);
  let page: BrowserPage | undefined;
  try {
    await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
    const project = await client.call('projects.add', { path: core.dataDir, name: 'History' });
    const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, permissionMode: 'default', title: 'Long answers' });
    // Answers several times taller than the window's 80 px estimate.
    for (let turn = 0; turn < 14; turn++) {
      await client.call('turns.start', { threadId: thread.id, prompt: `Turn ${turn}. ` + 'A paragraph long enough to wrap across the conversation column.\n\n'.repeat(10) });
      for (let wait = 0; wait < 200; wait++) {
        const { turns } = await client.call('threads.get', { threadId: thread.id });
        if (turns.every(each => each.status !== 'running' && each.status !== 'queued')) break;
        await Bun.sleep(50);
      }
    }
    page = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: { width: 1280, height: 900 } });
    await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
    await page.click(`[data-thread-id="${thread.id}"]`);
    await page.waitFor(`document.querySelectorAll('${timeline} [data-mid]').length > 0`);
    const box = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${timeline}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (let notch = 0; notch < 60; notch++) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -120 });
      await Bun.sleep(100);
    }
    await Bun.sleep(500);
    // A row the window mounted and dropped before its measurement frame kept its estimate: the
    // shorter spacer moved the anchored list, which mounted the row again, sixteen times a second.
    const churn = await page.evaluate<{ rows: number; tops: number }>(`new Promise((done) => {
      const box = document.querySelector('${timeline}');
      let rows = 0;
      const tops = new Set([Math.round(box.scrollTop)]);
      const watch = new MutationObserver((records) => { for (const record of records) for (const node of [...record.addedNodes, ...record.removedNodes]) if (node instanceof HTMLElement && node.matches('[data-mid]')) rows += 1; });
      watch.observe(box, { childList: true, subtree: true });
      const onScroll = () => tops.add(Math.round(box.scrollTop));
      box.addEventListener('scroll', onScroll);
      setTimeout(() => { watch.disconnect(); box.removeEventListener('scroll', onScroll); done({ rows, tops: tops.size }); }, 1000);
    })`);
    expect(churn).toEqual({ rows: 0, tops: 1 });
    expect(page.errors()).toEqual([]);
  } finally { await page?.close(); client.close(); await core.stop(); }
}, 120_000);
