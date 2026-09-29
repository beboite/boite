import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const timeline = '[data-testid=timeline]';
const jump = '[data-testid=jump-to-latest]';
const artifacts = process.env.BOITE_SCROLL_CAPTURES ?? join(import.meta.dir, '.artifacts');

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
}

beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent&long=1`;
  page = await BrowserPage.launch({ url });
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

for (const phone of [false, true]) {
  const name = phone ? 'phone' : 'desktop';
  test(`the return button stays centered throughout its entrance on ${name}`, async () => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: phone ? 390 : 1280, height: 844, deviceScaleFactor: 1, mobile: phone });
    await page.navigate(url);
    await page.waitFor(`document.querySelector('${timeline}')`);
    await settled();
    await page.evaluate(`document.querySelector('${timeline}').scrollTop = 0`);
    await page.waitFor(`document.querySelector('${jump}')`);
    const offsets = await page.evaluate<number[]>(`(() => {
      const button = document.querySelector('${jump}');
      const parent = button.parentElement.getBoundingClientRect();
      const animations = button.getAnimations();
      animations.forEach(a => a.pause());
      return [0, 0.5, 1].map(progress => {
        animations.forEach(a => a.currentTime = Number(a.effect.getTiming().duration) * progress);
        const r = button.getBoundingClientRect();
        return Math.abs(r.left + r.width / 2 - parent.left - parent.width / 2);
      });
    })()`);
    await page.evaluate(`document.querySelector('${jump}').getAnimations().forEach(a => a.currentTime = Number(a.effect.getTiming().duration) / 2)`);
    await page.screenshot(join(artifacts, `jump-entrance-${name}.png`));
    expect(Math.max(...offsets)).toBeLessThan(1);
    await page.evaluate(`document.querySelector('${jump}').getAnimations().forEach(a => a.finish())`);
    await settled();
    await page.click(jump);
    await page.waitFor(`!document.querySelector('${jump}') && (() => { const t = document.querySelector('${timeline}'); return t.scrollHeight - t.clientHeight - t.scrollTop < 2; })()`);
  }, 30_000);

  test(`the return button stays above expanded activity and accepts a pointer on ${name}`, async () => {
    await page.navigate(url);
    await page.waitFor(`document.querySelector('${timeline}')`);
    await settled();
    await page.evaluate(`(() => {
      const store = window.__boiteTest.workspace.active;
      store.openThread.activity = { goal: null, loop: null, tasks: Array.from({length: 8}, (_, i) => ({id: 'task-' + i, text: 'Inspect conversation interaction ' + i, status: i === 0 ? 'in_progress' : 'pending'})) };
      document.querySelector('${timeline}').scrollTop = 0;
    })()`);
    await page.waitFor(`document.querySelector('${jump}') && document.querySelector('[data-testid=activity-tasks-toggle]')`);
    await page.click('[data-testid=activity-tasks-toggle]');
    await settled();
    await page.screenshot(join(artifacts, `jump-activity-${name}.png`));
    const position = await page.evaluate<{ clear: boolean; reachable: boolean; x: number; y: number }>(`(() => {
      const button = document.querySelector('${jump}');
      const r = button.getBoundingClientRect();
      const dock = document.querySelector('[data-testid=thread-activity]').getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return { clear: r.bottom <= dock.top, reachable: button.contains(document.elementFromPoint(x, y)), x, y };
    })()`);
    expect(position.clear).toBe(true);
    expect(position.reachable).toBe(true);
    if (phone) expect(await page.evaluate(`document.querySelector('${jump}').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: position.x, y: position.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: position.x, y: position.y });
    await page.waitFor(`!document.querySelector('${jump}')`);
    await settled();
    await page.screenshot(join(artifacts, `jump-latest-${name}.png`));
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  }, 30_000);
}
