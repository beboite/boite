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

test('a navigation a late history.back() takes over fails inside a 30 s hook, naming the back and the history it left', async () => {
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch: request => new Response(`<!doctype html><title>${new URL(request.url).search}</title>`, { headers: { 'content-type': 'text/html' } }),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const page = await BrowserPage.launch({ url: `${origin}/?start` });
  try {
    await page.navigate(`${origin}/?a`);
    // A phone overlay closes and pops its entry, and a second pop reaches the browser as the next document
    // commits: the browser goes back to an older document and the requested one never commits.
    await page.evaluate(`history.pushState({ boiteOverlay: 'menu', boiteDepth: 1 }, ''); history.back(); addEventListener('pagehide', () => history.back(), { once: true }); null`);
    const started = performance.now();
    const failure = await page.navigate(`${origin}/?b`).then(() => null, (error: Error) => error.message);
    const elapsed = performance.now() - started;
    console.info(`Navigation taken over by a late back: ${elapsed.toFixed(0)} ms\n${failure}`);
    expect(failure).toContain('the requested navigation never committed');
    expect(failure).toContain('history.back() with state {"boiteOverlay":"menu","boiteDepth":1}');
    // The tab went back to the first page, before the overlay's own document.
    expect(failure).toMatch(/History: about:blank \(auto_toplevel\), \* http:\/\/127\.0\.0\.1:\d+\/ \(typed\), /);
    // bun's hook budget in the e2e files is 30 s: the navigation's own report must come first.
    expect(elapsed).toBeLessThan(25_000);
  } finally {
    await page.close();
    server.stop(true);
  }
}, 45_000);
