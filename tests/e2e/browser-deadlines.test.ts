import { existsSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { BrowserPage } from './lib/cdp.ts';

test('browser condition waits bound unresolved evaluations and refuse closed pages', async () => {
  const page = await BrowserPage.launch({ url: 'about:blank' });
  const pid = page.pid;
  const profile = page.profileDir;
  try {
    const expression = 'new Promise(() => {})';
    const started = performance.now();
    const waiting = page.waitFor(expression, 100);
    await expect(waiting).rejects.toThrow(`waitFor timed out on ${expression}`);
    await expect(waiting).rejects.toThrow('"ready":"complete"');
    const elapsed = performance.now() - started;
    console.info(`Unresolved condition: ${elapsed.toFixed(1)} ms for a 100 ms budget; captured browser ${pid}`);
    // Allows the bounded diagnostic grace and scheduling delay, not a fresh 20-second CDP deadline.
    expect(elapsed).toBeLessThan(1_000);
    expect(await page.evaluate<number>('2 + 2')).toBe(4);

    // This bounded task occupies the renderer long enough that even diagnostics cannot answer.
    const blocked = performance.now();
    await expect(page.waitFor('(() => { const end = performance.now() + 1500; while (performance.now() < end) {} return false; })()', 100))
      .rejects.toThrow('page diagnostic timed out');
    const blockedElapsed = performance.now() - blocked;
    console.info(`Unresponsive renderer: ${blockedElapsed.toFixed(1)} ms including bounded diagnostics`);
    expect(blockedElapsed).toBeLessThan(1_000);

    await page.close();
    const closed = performance.now();
    await expect(page.waitFor('true', 1_000)).rejects.toThrow('the browser is closed');
    expect(performance.now() - closed).toBeLessThan(250);
  } finally {
    await page.close();
    if (profile !== null) expect(existsSync(profile)).toBe(false);
    console.info(`Closed captured browser ${pid} and removed its profile`);
  }
  // Only this regression allows the old 20-second call deadline to finish for the red run.
}, 45_000);
