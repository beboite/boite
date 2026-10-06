import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui';

/* The steward on the fake core (`?fake=1&steward=1`): its settings, its letters, its notices and the prompt its agent wrote. */

const out = (name: string) => join(import.meta.dir, '.artifacts', `steward-${name}.png`);
const store = 'globalThis.__boiteTest.workspace.active';
const still = 'Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])';

async function size(page: BrowserPage, width: number, height: number): Promise<void> {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await page.evaluate(still);
}

test('steward settings, letters, notices and agent prompts read apart from the user, on desktop and phone', async () => {
  const port = await freePort();
  const server = await startUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&steward=1&open=recent`, windowSize: { width: 1280, height: 900 } });
    await page.waitFor(`${store}.connection === 'ready' && !!${store}.openThread`);
    const ids = await page.evaluate<{ steward: string; target: string }>(`(async () => {
      const client = ${store}.client;
      const [grant] = await client.call('stewards.list', {});
      const view = await client.call('collaboration.get', { threadId: grant.threadId });
      return { steward: grant.threadId, target: view.messages.find(letter => letter.origin === 'steward').to.threadId };
    })()`);

    for (const [width, height, name] of [[1280, 900, 'desktop'], [390, 844, 'phone']] as const) {
      await size(page, width, height);
      await page.evaluate(`${store}.open(${JSON.stringify(ids.steward)})`);
      await page.waitFor(`${store}.openThread?.id === ${JSON.stringify(ids.steward)}`);
      await page.click('[data-testid=thread-menu-trigger]');
      await page.click('[data-value=coordination]');
      await page.waitFor('document.querySelector("[data-testid=coordination-dialog]")?.open && !!document.querySelector("[data-testid=steward-chip]")');
      await page.evaluate(still);
      await page.screenshot(out(`settings-top-${name}`));
      await page.evaluate('document.querySelector("[data-testid=steward-settings]").scrollIntoView({ block: "start" })');
      await page.evaluate(still);
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.screenshot(out(`settings-${name}`));
      await page.click('[data-testid=coordination-close]');

      await page.evaluate(`${store}.open(${JSON.stringify(ids.target)})`);
      await page.waitFor(`${store}.openThread?.id === ${JSON.stringify(ids.target)} && !!document.querySelector('[data-testid=agent-prompt]') && !!document.querySelector('[data-testid=agent-message-summary][data-kind=steward]')`);
      if (name === 'desktop') {
        // Who looks after what shows without opening anything: the steward among the agents in charge,
        // its picture on the projects it covers, and its name on the header of a thread it covers.
        await page.waitFor(`!!document.querySelector('[data-testid=steward-at-work][data-thread-id=${JSON.stringify(ids.steward)}]')`);
        expect(await page.evaluate(`document.querySelectorAll('[data-testid=project-steward][data-thread-id=${JSON.stringify(ids.steward)}]').length`)).toBeGreaterThan(0);
        await page.waitFor('!!document.querySelector("[data-testid=thread-steward-chip]")');
        await page.evaluate(still);
        await page.screenshot(out(`visible-${name}`));
        await page.click('[data-testid=thread-steward-chip]');
        await page.waitFor(`${store}.openThread?.id === ${JSON.stringify(ids.steward)}`);
        expect(await page.evaluate('!!document.querySelector("[data-testid=thread-steward-chip]")')).toBe(false);
        await page.evaluate(`${store}.open(${JSON.stringify(ids.target)})`);
        await page.waitFor(`${store}.openThread?.id === ${JSON.stringify(ids.target)} && !!document.querySelector('[data-testid=agent-prompt]')`);
      }
      await page.evaluate('document.querySelector("[data-testid=agent-prompt]").scrollIntoView({ block: "start" })');
      await page.evaluate(still);
      await page.screenshot(out(`target-${name}`));
      await page.click('[data-testid=agent-message-summary][data-kind=steward]');
      await page.waitFor('!!document.querySelector("[data-testid=agent-messages-surface] .forwarded.steward")');
      await page.evaluate(still);
      await page.screenshot(out(`target-letters-${name}`));
      await page.click('[data-testid=panel-close]');
      await page.waitFor('!document.querySelector("[data-testid=right-panel]")');

      await page.evaluate(`${store}.open(${JSON.stringify(ids.steward)})`);
      await page.waitFor(`${store}.openThread?.id === ${JSON.stringify(ids.steward)} && !!document.querySelector('[data-testid=agent-message-summary][data-kind=notice]')`);
      await page.evaluate('document.querySelector("[data-testid=agent-message-summary][data-kind=notice]").scrollIntoView({ block: "center" })');
      await page.evaluate(still);
      await page.screenshot(out(`steward-${name}`));
      await page.click('[data-testid=agent-message-summary][data-kind=notice]');
      await page.waitFor('!!document.querySelector("[data-testid=agent-messages-surface] [data-testid=agent-notice]")');
      await page.evaluate(still);
      await page.screenshot(out(`steward-letters-${name}`));
      await page.click('[data-testid=panel-close]');
      await page.waitFor('!document.querySelector("[data-testid=right-panel]")');
    }
    expect(page.errors()).toEqual([]);
  } finally {
    await page?.close();
    await server.close();
  }
}, 180_000);
