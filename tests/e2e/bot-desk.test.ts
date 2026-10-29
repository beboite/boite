import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
const visible = (name: string) => `document.querySelector('${id(name)}')?.checkVisibility()`;
const capture = async (name: string) => {
  await page.settleAnimations();
  await page.screenshot(join(import.meta.dir, '.artifacts', `bot-desk-${name}.png`));
};

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&agents=1`, experiments: ['resident-agents'], windowSize: { width: 1440, height: 900 } });
  await page.waitFor(`window.__boiteTest?.workspace.active.connection === 'ready'`);
  const agentId = await page.evaluate<string>(`(async () => {
    window.__boiteTest.setTheme('dark');
    const store = window.__boiteTest.workspace.active;
    const nova = (await store.client.call('agents.snapshot', {})).profiles.find(p => p.name === 'Nova');
    store.showAgents();
    return nova.id;
  })()`);
  await page.click(id(`agent-entry-${agentId}`));
  await page.waitFor(visible('desk-work'));
}, 120_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 60_000);

test('the bot desk separates work, routines and memory without overflowing on desktop or phone', async () => {
  for (const width of [1440, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
    await page.click(id('desk-tab-work'));
    await page.waitFor(visible('desk-work'));
    expect(await page.evaluate(visible('desk-schedule'))).toBe(false);
    expect(await page.evaluate(visible('desk-memory'))).toBe(false);
    expect(await page.evaluate(visible('desk-steps'))).toBe(false);
    expect(await page.evaluate(visible('desk-budget'))).toBe(false);
    await capture(`work-${width}`);
    // All three tabs and every card stay inside the panel, including their text.
    const layout = await page.evaluate<{ inside: boolean; overflow: number; tabs: number[] }>(`(() => {
      const desk = document.querySelector('${id('agent-desk')}');
      const box = desk.getBoundingClientRect();
      return { inside: box.width > 0 && box.left >= 0 && box.right <= innerWidth + 1,
        overflow: desk.scrollWidth - desk.clientWidth,
        tabs: [...desk.querySelectorAll('[role=tab]')].map(tab => tab.scrollWidth - tab.clientWidth) };
    })()`);
    expect(layout.inside).toBe(true);
    expect(layout.overflow).toBeLessThanOrEqual(0);
    expect(layout.tabs).toHaveLength(3);
    expect(layout.tabs.every(overflow => overflow <= 0)).toBe(true);

    await page.click(`${id('desk-activity')} > summary`);
    await page.waitFor(visible('desk-steps'));
    await page.click(`${id('desk-activity')} > summary`);

    await page.click(id('desk-tab-routines'));
    await page.waitFor(visible('desk-schedule'));
    expect(await page.evaluate(visible('desk-work'))).toBe(false);
    await capture(`routines-${width}`);
    await page.click(id('desk-tab-memory'));
    await page.waitFor(visible('desk-memory'));
    expect(await page.evaluate(visible('desk-schedule'))).toBe(false);
    await capture(`memory-${width}`);

    await page.click(`${id('desk-today')} > summary`);
    await page.waitFor(visible('desk-budget'));
    expect(await page.text(id('desk-today'))).toContain('$1.35 of $2.00');
    await page.click(`${id('desk-today')} > summary`);
    await page.click(id('desk-tab-work'));
  }
}, 60_000);
