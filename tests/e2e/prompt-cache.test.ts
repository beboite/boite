import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';

const req = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(req.resolve('vite'));
let server: { close(): Promise<void> };
let port = 0;
const pages: BrowserPage[] = [];

beforeAll(async () => {
  port = await freePort();
  const vite = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true } });
  server = vite;
  await vite.listen();
}, 90_000);
afterAll(async () => {
  await Promise.all(pages.map((page) => page.close()));
  await server?.close();
}, 15_000);

const STORE = `(await import('/src/lib/workspace.svelte.ts')).workspace.active`;
const CHIP = '[data-testid="prompt-cache"]';

/**
 * Opens the recent thread and gives it a cache that finished `minutesAgo`
 * minutes back, on the thread's own model and account.
 */
async function open(size: { width: number; height: number }, cache: { minutesAgo: number; ttlSeconds: number; maxSeconds?: number; source: string }, experiment = true, locale = 'en'): Promise<BrowserPage> {
  const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: size });
  pages.push(page);
  await page.waitFor(`document.querySelector('[data-testid="context-trigger"]')`);
  await page.evaluate(`(async () => {
    (await import('/src/lib/i18n.svelte.ts')).setLocaleSetting(${JSON.stringify(locale)});
    (await import('/src/lib/experiments.ts')).setExperiment('prompt-cache', ${experiment});
    const store = ${STORE};
    const thread = store.openThread;
    thread.promptCache = { at: Date.now() - ${cache.minutesAgo} * 60000, ttlSeconds: ${cache.ttlSeconds}, ${cache.maxSeconds === undefined ? '' : `maxSeconds: ${cache.maxSeconds},`} source: '${cache.source}', readTokens: 12400, model: thread.model, accountId: thread.accountId };
  })()`);
  return page;
}

async function capture(page: BrowserPage, name: string): Promise<void> {
  await page.click('[data-testid="context-trigger"]');
  await page.waitFor(`document.querySelector('[data-testid="prompt-cache-detail"]')`);
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir, '.artifacts', `${name}.png`));
}

test('a warm Claude cache counts down beside the context meter', async () => {
  const page = await open({ width: 1300, height: 850 }, { minutesAgo: 29, ttlSeconds: 3600, source: 'reported' });
  await page.waitFor(`document.querySelector('${CHIP}')`);
  expect(await page.evaluate<string>(`document.querySelector('${CHIP}').dataset.state`)).toBe('warm');
  expect(await page.text(CHIP)).toContain('31 min');
  await capture(page, 'prompt-cache-desktop');
  expect(await page.text('[data-testid="prompt-cache-detail"]')).toContain('1 h lifetime, reported by the agent');
}, 90_000);

test('past the OpenAI 30 minutes the cache reads maybe, on a phone and in French', async () => {
  const page = await open({ width: 390, height: 844 }, { minutesAgo: 40, ttlSeconds: 1800, maxSeconds: 86_400, source: 'documented' }, true, 'fr');
  await page.waitFor(`document.querySelector('${CHIP}')?.dataset.state === 'maybe'`);
  expect(await page.text(CHIP)).toContain('23 h');
  await capture(page, 'prompt-cache-phone-fr');
  expect(await page.text('[data-testid="prompt-cache-detail"]')).toContain('Peut-être encore chaud');
}, 90_000);

test('another model reads cold, and the experiment off draws nothing', async () => {
  const page = await open({ width: 1300, height: 850 }, { minutesAgo: 2, ttlSeconds: 300, source: 'documented' });
  await page.waitFor(`document.querySelector('${CHIP}')?.dataset.state === 'warm'`);
  await page.evaluate(`(async () => { (${STORE}).openThread.model = 'another-model'; })()`);
  await page.waitFor(`document.querySelector('${CHIP}')?.dataset.state === 'cold'`);
  await capture(page, 'prompt-cache-cold');
  expect(await page.text('[data-testid="prompt-cache-detail"]')).toContain('another model or account');

  const off = await open({ width: 1300, height: 850 }, { minutesAgo: 2, ttlSeconds: 300, source: 'documented' }, false);
  await off.waitFor(`document.querySelector('[data-testid="context-trigger"]')`);
  expect(await off.evaluate<boolean>(`!!document.querySelector('${CHIP}')`)).toBe(false);
}, 90_000);
