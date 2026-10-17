import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from './lib/core.ts';

// A chunk that failed to load comes back through its Retry button in a real
// browser. Chromium keeps a failed `import()` for the life of the page, so
// asking for the same file again never reaches the network: the retry has to
// load a fresh page once the core answers (`packages/ui/src/lib/retry-load.ts`).
const TIMEOUT = 90_000;

let core: RunningCore;

beforeAll(async () => {
  core = await startCore();
}, TIMEOUT);

afterAll(async () => {
  await core?.stop();
}, 30_000);

async function blockedPage(pattern: string, width: number, height: number): Promise<BrowserPage> {
  const page = await BrowserPage.launch({ url: 'about:blank', windowSize: { width, height } });
  await page.send('Network.setBlockedURLs', { urls: [pattern] });
  await page.navigate(pairingUrlOf(core));
  return page;
}

test('a catalogue that did not load leaves a notice whose retry boots the app', async () => {
  const page = await blockedPage('*/assets/strings.*', 1280, 800);
  try {
    await page.waitFor(`document.querySelector('[data-testid=boot-failure]') !== null`, 30_000);
    expect(await page.text('[data-testid=boot-failure]')).toContain('Boite could not load');
    expect(await page.evaluate<boolean>(`document.querySelector('.app') === null`)).toBe(true);

    await page.send('Network.setBlockedURLs', { urls: [] });
    await page.click('[data-testid=boot-failure] button');
    await page.waitFor(`document.querySelector('.app.ready') !== null`, 30_000);
    expect(page.errors()).toEqual([]);
  } finally {
    await page.close();
  }
}, TIMEOUT);

test("a phone whose navigation chunk did not load says so, and its retry brings the header", async () => {
  const page = await blockedPage('*/assets/MobileNavigation-*', 390, 844);
  try {
    await page.waitFor(`document.querySelector('.app.ready [data-testid=mobile-navigation-failed]') !== null`, 30_000);
    expect(await page.text('[data-testid=mobile-navigation-failed]')).toContain('The navigation did not load.');
    expect(await page.evaluate<boolean>(`document.querySelector('[data-testid=mobile-header]') === null`)).toBe(true);

    await page.send('Network.setBlockedURLs', { urls: [] });
    await page.click('[data-testid=mobile-navigation-retry]');
    await page.waitFor(`document.querySelector('[data-testid=mobile-header]') !== null`, 30_000);
    expect(await page.evaluate<boolean>(`document.querySelector('[data-testid=mobile-navigation-failed]') === null`)).toBe(true);
  } finally {
    await page.close();
  }
}, TIMEOUT);
