import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserLabNativeTransport, BrowserLabPlaywrightCommands, createBrowserLabEngine, playwrightSelector, scrollDelta } from './browser-lab-engine.ts';

test('native errors retain details and a timed-out reply does not poison the following command', async () => {
  const socket = new EventEmitter() as EventEmitter & { destroyed: boolean; write: (line: string) => void };
  socket.destroyed = false;
  const writes: any[] = [];
  socket.write = line => { writes.push(JSON.parse(line)); };
  const transport = new BrowserLabNativeTransport(socket as unknown as Socket, 20);
  try {
    const first = transport.command('click', { selector: '@e1' });
    socket.emit('data', JSON.stringify({ id: writes[0].id, success: false, error: 'Element is obscured by cookie dialog' }) + '\n');
    await expect(first).rejects.toThrow('Element is obscured by cookie dialog');
    await expect(transport.command('click', { selector: '@e2' })).rejects.toThrow('not cancelled or retried');
    const third = transport.command('evaluate', { script: 'document.title' });
    socket.emit('data', JSON.stringify({ id: writes[1].id, success: true, data: { clicked: true } }) + '\n');
    socket.emit('data', JSON.stringify({ id: writes[2].id, success: true, data: { result: 'Recovered' } }) + '\n');
    expect(await third).toEqual({ result: 'Recovered' });
    expect(socket.destroyed).toBe(false);
  } finally { transport.dispose(); }
  expect(socket.listenerCount('data')).toBe(0);
});

test('native rejects concurrent commands and preserves split JSON responses', async () => {
  const socket = new EventEmitter() as EventEmitter & { destroyed: boolean; write: (line: string) => void };
  let id = '';
  socket.destroyed = false; socket.write = line => { id = JSON.parse(line).id; };
  const transport = new BrowserLabNativeTransport(socket as unknown as Socket);
  try {
    const result = transport.command('snapshot');
    await expect(transport.command('click')).rejects.toThrow('Only one');
    const raw = JSON.stringify({ id, success: true, data: { snapshot: 'link' } }) + '\n';
    socket.emit('data', raw.slice(0, 10)); socket.emit('data', raw.slice(10));
    expect(await result).toEqual({ snapshot: 'link' });
  } finally { transport.dispose(); }
});

test('Playwright mappings retain refs, normal actionability and native wheel semantics', async () => {
  expect(playwrightSelector('@e12')).toBe('aria-ref=e12');
  expect(playwrightSelector('e5')).toBe('aria-ref=e5');
  expect(playwrightSelector('@f2e6')).toBe('aria-ref=f2e6');
  expect(playwrightSelector('input[name=q]')).toBe('input[name=q]');
  expect(scrollDelta({ direction: 'up', amount: 120 })).toEqual([0, -120]);
  expect(scrollDelta({ x: 20, y: 30 })).toEqual([20, 30]);
  const calls: unknown[] = [];
  const page: any = { isClosed: () => false, setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
    locator: (selector: string) => ({ click: (...args: unknown[]) => { calls.push({ selector, args }); }, fill: (value: string) => { calls.push(value); } }),
    _snapshotForAI: async () => ({ full: '- heading "Hello" [ref=e1]\n- link "More" [ref=e2]' }),
    mouse: { wheel: (...args: unknown[]) => { calls.push(args); } },
  };
  const engine = new BrowserLabPlaywrightCommands({ contexts: () => [{ pages: () => [page] }] });
  await engine.command('click', { selector: '@e2' });
  expect(calls[0]).toEqual({ selector: 'aria-ref=e2', args: [] });
  await engine.command('fill', { selector: 'input', value: 'hello' });
  await engine.command('scroll', { direction: 'down', amount: 400 });
  expect(calls[2]).toEqual([0, 400]);
  expect(await engine.command('snapshot')).toMatchObject({ refs: { e2: { selector: 'aria-ref=e2' } } });
  await expect(engine.command('snapshot', { selector: 'main' })).rejects.toThrow('does not support');
  await expect(engine.command('invented')).rejects.toThrow('Unsupported');
});

const live = process.env.BOITE_BENCH_ENGINE_SMOKE === '1' ? test : test.skip;
live('both engines use an owned Edge browser, real public pages, recover after action errors and clean up', async () => {
  const { startTestCore } = await import('../packages/core/test/harness.ts');
  const { findBrowser } = await import('../tests/e2e/lib/cdp.ts');
  const output = process.env.BOITE_BENCH_ENGINE_OUTPUT;
  const binary = process.env.BOITE_BROWSER_TEST_BINARY;
  if (!output || !binary) throw new Error('Expected BOITE_BENCH_ENGINE_OUTPUT and BOITE_BROWSER_TEST_BINARY.');
  mkdirSync(output, { recursive: true });
  const harness = await startTestCore();
  const results: unknown[] = [];
  try {
    for (const kind of ['agent-browser', 'playwright'] as const) {
      const logs: unknown[] = [];
      const engine = await createBrowserLabEngine(kind, { core: harness.core, taskId: `engine-smoke-${kind}`, binary, executablePath: findBrowser(), log: entry => logs.push(entry) });
      const start = performance.now();
      try {
        await engine.command('viewport', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await engine.command('navigate', { url: 'https://example.com', waitUntil: 'load' });
        expect((await engine.command('evaluate', { script: 'document.title' })).result).toBe('Example Domain');
        const snapshot = await engine.command('snapshot', { interactive: true });
        expect(String(snapshot.snapshot)).toContain('Learn more');
        const ref = String(snapshot.snapshot).match(/link "Learn more" \[ref=((?:f\d+)?e\d+)\]/)?.[1];
        expect(ref).toBeDefined();
        await expect(engine.command('click', { selector: '#boite-missing-element' })).rejects.toThrow();
        expect((await engine.command('evaluate', { script: 'document.title' })).result).toBe('Example Domain');
        await engine.command('click', { selector: `@${ref}` });
        // Navigation commitment is observed explicitly rather than a fixed sleep.
        const deadline = Date.now() + 15_000;
        let url = '';
        do { url = String((await engine.command('evaluate', { script: 'location.href' })).result); if (/(^|\.)iana\.org$/.test(new URL(url).hostname)) break; await Bun.sleep(50); } while (Date.now() < deadline);
        expect(new URL(url).hostname).toMatch(/(^|\.)iana\.org$/);
        await engine.command('back');
        const tabs = await engine.command('tabs');
        expect(Array.isArray(tabs.tabs)).toBe(true);
        const created = await engine.command('tab_new', { url: 'https://example.com' });
        const allTabs = await engine.command('tabs');
        expect((allTabs.tabs as unknown[]).length).toBe(2);
        await engine.command('tab_switch', { tabId: (allTabs.tabs as any[])[0].tabId ?? (allTabs.tabs as any[])[0].id });
        expect((await engine.command('evaluate', { script: '[innerWidth,innerHeight]' })).result).toEqual([1280, 800]);
        await engine.command('mouse', { eventType: 'mouseMoved', x: 5, y: 5 });
        await engine.command('mouse', { eventType: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
        await engine.command('mouse', { eventType: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });
        await engine.command('screenshot', { path: join(output, `${kind}.png`) });
        await engine.command('navigate', { url: 'https://www.gov.uk/', waitUntil: 'load' });
        const form = await engine.command('snapshot', { interactive: true });
        const searchRef = String(form.snapshot).match(/(?:textbox|searchbox|combobox) [^\n]*?\[[^\]]*ref=((?:f\d+)?e\d+)\]/)?.[1];
        expect(searchRef).toBeDefined();
        await engine.command('fill', { selector: `@${searchRef}`, value: 'renew adult passport' });
        const fields = await engine.command('evaluate', { script: 'Array.from(document.querySelectorAll("input")).map(input => input.value)' });
        expect(fields.result).toContain('renew adult passport');
        results.push({ kind, metadata: engine.metadata, created, ms: performance.now() - start });
      } finally {
        await engine.close();
        expect(harness.core.procs.liveCount(engine.processGroup)).toBe(0);
        writeFileSync(join(output, `${kind}.json`), JSON.stringify(logs, null, 2));
      }
    }
  } finally { await harness.stop(); writeFileSync(join(output, 'summary.json'), JSON.stringify(results, null, 2)); }
}, 120_000);
