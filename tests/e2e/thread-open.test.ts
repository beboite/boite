import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { INITIAL_MESSAGE_PAGE } from '../../packages/contracts/src/index.ts';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, type RunningCore } from './lib/core.ts';
import { startCoreWithLongThread } from './lib/long-thread.ts';
import { mobileAction } from './lib/mobile.ts';

const artifacts = process.env.BOITE_OPEN_CAPTURES ?? join(import.meta.dir, '.artifacts');
/** Slow enough that the bar is on screen for seconds, as on a phone link. */
const THROTTLE = { offline: false, latency: 150, downloadThroughput: 150 * 1024, uploadThroughput: 64 * 1024 };

let core: RunningCore;
let long: string;
let short: string;
/** What the first page of the long thread weighs, as the core serializes it. */
let pageBytes = 0;

beforeAll(async () => {
  const seeded = await startCoreWithLongThread();
  core = seeded.core;
  long = seeded.long;
  short = seeded.short;
  const client = await connect(core.url, core.token, { client: { name: 'test', version: '0' }, timeoutMs: 30_000 });
  try {
    pageBytes = Buffer.byteLength(JSON.stringify(await client.call('threads.get', { threadId: long, limit: INITIAL_MESSAGE_PAGE, compactTools: true, compactFiles: true, compactImages: true })));
  } finally {
    client.close();
  }
}, 120_000);

afterAll(async () => {
  await core?.stop();
}, 30_000);

/** "1.2 MB" or "340 kB" back to bytes, give or take the rounding. */
function parseSize(text: string): number {
  const match = /([\d.,]+)\s*([kK]B|MB)/.exec(text);
  if (!match) throw new Error(`no size in ${text}`);
  return Number(match[1]!.replace(',', '.')) * (match[2] === 'MB' ? 1024 * 1024 : 1024);
}

for (const phone of [false, true]) {
  const name = phone ? 'phone' : 'desktop';
  test(`a long thread shows what of its page arrived against the core's total, then its text, on ${name}`, async () => {
    const page = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    try {
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"', 30_000);
      // A phone lists its threads on a screen of their own; a desktop in its sidebar.
      const row = (id: string): string => (phone ? `[data-testid=mobile-thread-${id}]` : `[data-thread-id="${id}"]`);
      if (phone) await mobileAction(page, 'mobile-conversations');
      await page.waitFor(`document.querySelector('${row(short)}')`);
      // The boot's own reopen settles first; then the short thread is the one on screen.
      await Bun.sleep(1_500);
      await page.click(row(short));
      await page.waitFor(`document.querySelector('[data-testid=timeline]') && !document.querySelector('[data-testid=thread-loading]')`, 30_000);
      if (phone) {
        await mobileAction(page, 'mobile-conversations');
        await page.waitFor(`document.querySelector('${row(long)}')`);
      }

      await page.send('Network.enable', {});
      await page.send('Network.emulateNetworkConditions', THROTTLE);
      await page.click(row(long));
      // The click is answered at once, phone sidebar closed, before a byte of the page.
      await page.waitFor('document.querySelector("[data-testid=thread-loading]")', 5_000);
      await page.waitFor('document.querySelector("[data-testid=thread-loading-progress]")', 30_000);
      // Let the bar move off its first slice before the capture.
      await Bun.sleep(1_200);
      const progress = await page.text('[data-testid=thread-loading-progress]');
      await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
      await page.screenshot(join(artifacts, `thread-open-loading-${name}.png`));
      const [received, total] = progress.split('/').map((side) => parseSize(side));
      // The total is the core's: the page it serializes, plus the response envelope.
      expect(Math.abs(total! - pageBytes) / pageBytes).toBeLessThan(0.06);
      expect(received!).toBeGreaterThan(0);
      expect(received!).toBeLessThan(total!);

      await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await page.waitFor('document.querySelector("[data-testid=timeline] [data-mid^=msg_fixture]")', 60_000);
      expect(await page.evaluate('!!document.querySelector("[data-testid=thread-loading]")')).toBe(false);
      await page.screenshot(join(artifacts, `thread-open-done-${name}.png`));
    } finally {
      await page.close();
    }
  }, 180_000);
}
