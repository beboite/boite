import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { echoThread, startTestCore, waitFor } from '../../packages/core/test/harness';
import { BrowserPage } from './lib/cdp';
import { ensureProductionUi } from './lib/prod-ui';

const frames = `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))))`;
const timeline = '[data-testid="timeline"]';

test('production desktop and phone restore cached reading before a slow core replies and hydrate folded output', async () => {
  ensureProductionUi();
  const harness = await startTestCore();
  let page: BrowserPage | undefined;
  try {
    const client = await harness.connect();
    const { threadId, accountId } = await echoThread(harness, client, 'Long conversation');
    const projectId = harness.core.threads.require(threadId).projectId!;
    const other = await client.call('threads.create', { projectId, providerId: 'echo', accountId, title: 'Other conversation' });
    const output = 'Complete command output\n'.repeat(80_000);
    harness.core.journal.append({ type: 'message.started', threadId, version: 1, payload: {} }, () => {
      harness.core.journal.putTurn({ id: 'history-turn', threadId, status: 'done', queuedAt: 1, startedAt: 1, finishedAt: 2, usage: null, error: null });
      for (let index = 0; index < 220; index++) harness.core.journal.putMessage({ id: `reading-${index}`, threadId, turnId: 'history-turn', role: index % 2 ? 'assistant' : 'user', state: 'complete', createdAt: index,
        parts: [...(index === 219 ? [{ type: 'tool' as const, toolId: 'large', name: 'Bash', input: { command: 'report' }, output, status: 'done' as const }] : []), { type: 'text', text: `Message ${index}. A paragraph with **formatted text** and a stable reading position.\n\nThe history stays in its conversation.` }] });
    });
    harness.core.journal.putMessage({ id: 'other-message', threadId: other.id, turnId: 'other-turn', role: 'assistant', state: 'complete', createdAt: 1, parts: [{ type: 'text', text: 'The other conversation.' }] });
    const getsFinished = new Map<string, number>();
    harness.core.router.register('threads.get', async params => {
      const result = harness.core.threads.get(params.threadId, params.after, params);
      await Bun.sleep(750);
      getsFinished.set(params.threadId, (getsFinished.get(params.threadId) ?? 0) + 1);
      return result;
    });
    page = await BrowserPage.launch({ url: `${harness.url}/?token=${harness.token}`, windowSize: { width: 1280, height: 900 } });
    await page.waitFor(`document.querySelector('[data-thread-id="${threadId}"]')`);
    const open = async (id: string, phone: boolean) => {
      if (phone) await page!.click('[data-testid="mobile-conversations"]');
      await page!.click(phone ? `[data-testid="mobile-thread-${id}"]` : `[data-thread-id="${id}"]`);
    };
    await open(threadId, false);
    await page.waitFor('document.querySelector(\'[data-mid="reading-219"]\')');
    expect(await page.evaluate('document.querySelectorAll("[data-mid]").length')).toBeLessThan(30);
    expect(await page.evaluate('!!document.querySelector("[data-testid=tool-output]")')).toBe(false);
    await page.click('[data-testid="tool-toggle"]');
    await page.waitFor(`document.querySelector('[data-testid="tool-output"]')?.textContent.length === ${output.length}`);
    await page.click('[data-testid="tool-toggle"]');
    await page.evaluate(frames);
    let phoneView = false;
    for (const phone of [false, true, true, false]) {
      await page.evaluate(frames);
      await page.evaluate(`(async () => {
        const box = document.querySelector('${timeline}');
        box.dispatchEvent(new WheelEvent('wheel', { deltaY: -800 }));
        box.scrollTop = box.scrollHeight / 2;
        box.dispatchEvent(new Event('scroll'));
        await ${frames}; await ${frames};
        const top = box.getBoundingClientRect().top;
        const node = [...box.querySelectorAll('[data-mid]')].find(node => node.getBoundingClientRect().bottom > top);
        globalThis.readingProof = { id: node.dataset.mid, offset: node.getBoundingClientRect().top - top };
      })()`);
      await open(other.id, phoneView);
      await page.waitFor('document.querySelector(\'[data-mid="other-message"]\')');
      const resized = phoneView !== phone;
      await page.send('Emulation.setDeviceMetricsOverride', { width: phone ? 390 : 1280, height: phone ? 844 : 900, deviceScaleFactor: 1, mobile: phone });
      phoneView = phone;
      await page.evaluate(frames);
      if (phone) await page.click('[data-testid="mobile-conversations"]');
      const completedBefore = getsFinished.get(threadId) ?? 0;
      const painted = await page.evaluate<number>(`(async () => {
        const started = performance.now();
        document.querySelector('${phone ? `[data-testid="mobile-thread-${threadId}"]` : `[data-thread-id="${threadId}"]`}').click();
        const deadline = started + 5000;
        while (!document.querySelector('[data-mid="' + readingProof.id + '"]') || document.querySelector('.body.mobile-covered')) {
          if (performance.now() > deadline) throw new Error('cached reading never became visible');
          await ${frames};
        }
        await ${frames};
        return performance.now() - started;
      })()`);
      expect(painted).toBeLessThan(500);
      await waitFor(() => (getsFinished.get(threadId) ?? 0) > completedBefore);
      await page.evaluate(frames);
      const drift = await page.evaluate<number>(`document.querySelector('[data-mid="' + readingProof.id + '"]').getBoundingClientRect().top - document.querySelector('${timeline}').getBoundingClientRect().top - readingProof.offset`);
      expect(Math.abs(drift)).toBeLessThan(2);
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-switch-${phone ? 'phone' : 'desktop'}.png`));
      console.log(`thread switch ${phone ? 'phone' : 'desktop'}${resized ? ' after resize' : ''}: ${painted.toFixed(1)} ms before a 750 ms reply; drift ${drift.toFixed(1)} px`);
    }
    expect(page.errors()).toEqual([]);
  } finally { await page?.close(); await harness.stop(); }
}, 90_000);
