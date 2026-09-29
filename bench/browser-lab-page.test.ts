import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LabPage, labReadinessScript, labStateScript } from './browser-lab-page.ts';

test('browser evidence script parses as browser JavaScript', () => {
  expect(() => new Function('return ' + labStateScript)).not.toThrow();
  expect(() => new Function('return ' + labReadinessScript(3000))).not.toThrow();
});

const task = { id: 'scope', url: 'https://example.org/', hosts: ['example.org'], goal: 'Read public pages', rubric: ['Read'] };
function fixture(vision = false, snapshot = '- link "Next" [ref=e1]', state: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lab-page-'));
  const calls: any[] = [];
  const engine = { command: async (action: string, args: any = {}): Promise<Record<string, any>> => {
    calls.push({ action, args });
    if (action === 'evaluate') return { result: { url: task.url, title: 'Example', text: 'Read the substantial public document with enough content for reliable observation.', readyState: 'complete', links: [{ text: 'Next', url: 'https://example.org/next' }], ...state } };
    if (action === 'snapshot') return { snapshot };
    if (action === 'tabs') return { tabs: [{ tabId: 't1', url: task.url }] };
    if (action === 'screenshot') { writeFileSync(args.path, 'image-fixture'); return { path: args.path }; }
    return { ok: true };
  } };
  return { calls, page: new LabPage(engine, task, vision, directory, performance.now() + 60_000), close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('observation waits for document content and rereads state before snapshot and capture', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-ready-'));
  const calls: string[] = [];
  const empty = { url: task.url, title: '', text: '', links: [], readyState: 'loading' };
  const loaded = { ...empty, title: 'Loaded history', text: 'The loaded history contains enough visible text for a substantial public document.', readyState: 'complete' };
  let painted = false;
  const engine = { command: async (action: string, args: any = {}): Promise<Record<string, any>> => {
    if (action === 'evaluate') {
      if (args.script === labStateScript) { calls.push('state'); return { result: painted ? loaded : empty }; }
      calls.push('readiness'); painted = true;
      return { result: { state: loaded, ready: true, timedOut: false } };
    }
    calls.push(action);
    if (action === 'snapshot') return { snapshot: painted ? 'Loaded history' : '(empty page)' };
    if (action === 'tabs') return { tabs: [] };
    if (action === 'screenshot') { painted = true; writeFileSync(args.path, 'loaded-page-image'); }
    return {};
  } };
  try {
    const page = new LabPage(engine, task, false, directory, performance.now() + 60000);
    const observed = await page.observe();
    expect(observed.text.title).toBe('Loaded history');
    expect(observed.text.snapshot).toBe('Loaded history');
    expect(calls).toEqual(['prepare_observation', 'state', 'readiness', 'snapshot', 'tabs', 'screenshot']);
    expect(page.history[0].readiness.initialState).toEqual(empty);
    expect(page.history[0].readiness.ready).toBe(true);
    expect(page.history[0].observationMs).toBeGreaterThanOrEqual(page.history[0].readiness.waitMs);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('readiness timeout keeps fresh evidence and explicitly reports the incomplete document', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-ready-'));
  const partial = { url: task.url, title: '', text: '', links: [], readyState: 'interactive' };
  const engine = { command: async (action: string, args: any = {}): Promise<Record<string, any>> => {
    if (action === 'evaluate') return { result: args.script === labStateScript ? partial : { state: partial, ready: false, timedOut: true } };
    if (action === 'snapshot') return { snapshot: '(empty page)' };
    if (action === 'tabs') return { tabs: [] };
    if (action === 'screenshot') writeFileSync(args.path, 'image');
    return {};
  } };
  try {
    const page = new LabPage(engine, task, false, directory, performance.now() + 60000);
    const observed = await page.observe();
    expect(observed.text.errors.some(error => error.includes('readiness:') && error.includes('timed out'))).toBe(true);
    expect(page.history[0].readiness).toMatchObject({ ready: false, timedOut: true, initialState: partial, timeoutMs: 3000 });
    expect(page.history[0].state).toEqual(partial);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('readiness script reacts to DOM signals and removes listeners and timer on success or timeout', async () => {
  for (const timeout of [false, true]) {
    const listeners = new Map<string, () => void>();
    const document = { readyState: 'loading', title: '', body: { innerText: '' }, querySelectorAll: () => [],
      addEventListener: (name: string, handler: () => void) => listeners.set(name, handler),
      removeEventListener: (name: string) => listeners.delete(name) };
    let mutation!: () => void, deadline!: () => void, disconnected = false, cleared = false;
    class Observer {
      constructor(callback: () => void) { mutation = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    }
    const run = new Function('document', 'MutationObserver', 'setTimeout', 'clearTimeout', 'location', 'innerWidth', 'innerHeight', 'matchMedia', 'return ' + labReadinessScript(3000));
    const pending = run(document, Observer, (callback: () => void, ms: number) => { expect(ms).toBe(3000); deadline = callback; return 1; },
      () => { cleared = true; }, { href: task.url }, 1280, 800, () => ({ matches: false }));
    expect(disconnected).toBe(false);
    if (timeout) deadline();
    else {
      document.readyState = 'interactive';
      listeners.get('readystatechange')!();
      expect(disconnected).toBe(false);
      document.title = 'Loaded';
      document.body.innerText = 'The document now contains more than fifty visible characters of useful content.';
      mutation();
    }
    const result = await pending;
    expect(result.ready).toBe(!timeout);
    expect(result.timedOut).toBe(timeout);
    expect(result.state.text).toBe(document.body.innerText);
    expect(disconnected && cleared).toBe(true);
    expect(listeners.size).toBe(0);
  }
});

test('substantial ready observations do not add a readiness evaluation', async () => {
  const f = fixture();
  try {
    await f.page.observe();
    expect(f.calls.filter(c => c.action === 'evaluate')).toHaveLength(1);
    expect(f.page.history[0].readiness).toBeUndefined();
  } finally { f.close(); }
});

test('native and Playwright refs remain actionable with surrounding attributes', async () => {
  for (const [snapshot, selector] of [
    ['- button "Labels" [expanded=false, ref=e116]', '@e116'],
    ['- button "Labels" [ref=f2e6] [expanded]', 'ref=f2e6'],
    ['- checkbox "Filter" [checked, ref=e8, disabled=false]', '@e8'],
  ]) {
    const f = fixture(false, snapshot);
    try {
      await f.page.observe();
      await f.page.execute({ commands: [{ action: 'click', selector }] });
      expect(f.calls.filter(c => c.action === 'click')).toHaveLength(1);
      expect(f.page.attempts[0].success).toBe(true);
    } finally { f.close(); }
  }
});

test('navigation requires an observed URL and preserves allowed cross-subdomain scope', async () => {
  const f = fixture();
  try {
    await f.page.observe();
    await f.page.execute({ commands: [{ action: 'open', url: 'https://example.org/invented' }] });
    expect(f.calls.some(c => c.action === 'navigate')).toBe(false);
    await f.page.execute({ commands: [{ action: 'open', url: 'https://example.org.evil.test/next' }] });
    expect(f.calls.some(c => c.action === 'navigate')).toBe(false);
    await f.page.execute({ commands: [{ action: 'open', url: 'https://example.org/next' }] });
    expect(f.calls.find(c => c.action === 'navigate').args.url).toBe('https://example.org/next');
  } finally { f.close(); }
});

test('navigation accepts delivered snapshot and current page URLs', async () => {
  for (const action of ['open', 'tab_new']) {
    const f = fixture(false, '- link "Destination" [ref=e1]\n  - /url: https://example.org/destination',
      { url: 'https://example.org/current', links: [] });
    try {
      await f.page.observe();
      for (const url of ['https://example.org/destination', 'https://example.org/current']) {
        await f.page.execute({ commands: [{ action, url }] });
        expect(f.page.attempts.at(-1).success).toBe(true);
        expect(f.calls.some(c => c.action === (action === 'open' ? 'navigate' : 'tab_new') && c.args.url === url)).toBe(true);
      }
    } finally { f.close(); }
  }
});

test('snapshot URL inventory excludes filtered, truncated and off-domain URLs', async () => {
  for (const [snapshot, query, url] of [
    ['- link "Keep" [ref=e1]\n  - /url: https://example.org/filtered', 'Keep', 'https://example.org/filtered'],
    ['x'.repeat(18001) + '\n  - /url: https://example.org/hidden', undefined, 'https://example.org/hidden'],
    ['  - /url: https://other.test/outside', undefined, 'https://other.test/outside'],
  ]) {
    const f = fixture(false, snapshot, { links: [] });
    try {
      await f.page.observe(query);
      await f.page.execute({ commands: [{ action: 'tab_new', url }] });
      expect(f.page.attempts[0].success).toBe(false);
      expect(f.calls.some(c => c.action === 'tab_new')).toBe(false);
    } finally { f.close(); }
  }
});
test('unobserved refs cannot act and DOM-only arms cannot click coordinates', async () => {
  const f = fixture();
  try {
    await f.page.observe();
    await f.page.execute({ commands: [{ action: 'click', selector: '@e999' }] });
    await f.page.execute({ commands: [{ action: 'click_xy', x: 10, y: 10 }] });
    expect(f.calls.some(c => c.action === 'click' || c.action === 'mouse')).toBe(false);
    await f.page.execute({ commands: [{ action: 'click', selector: '@e1' }] });
    expect(f.calls.filter(c => c.action === 'click')).toHaveLength(1);
  } finally { f.close(); }
});
test('finish records a claim and evidence without granting success', async () => {
  const f = fixture();
  try {
    await f.page.execute({ commands: [{ action: 'finish', answer: 'Claim only' }] });
    expect(f.page.finished).toBe(true);
    expect(f.page.answer).toBe('Claim only');
    expect(f.page.history).toHaveLength(1);
    expect('verified' in f.page).toBe(false);
  } finally { f.close(); }
});

test('rendering drift blocks stale actions and distinguishes bad setup from recoverable runtime drift', async () => {
  const state = { viewport: { width: 1280, height: 800 }, darkMode: false };
  const f = fixture(false, '- link "Next" [ref=e1]', state);
  try {
    await f.page.observe();
    state.viewport.width = 360;
    const error = await f.page.observe().catch(error => error);
    expect(error.invalidatesCampaign).toBe(false);
    state.viewport.width = 1280;
    await f.page.execute({ commands: [{ action: 'click', selector: '@e1' }] });
    expect(f.calls.some(c => c.action === 'click')).toBe(false);
    await f.page.execute({ commands: [{ action: 'click', selector: '@e1' }] });
    expect(f.calls.filter(c => c.action === 'click')).toHaveLength(1);
  } finally { f.close(); }
  const bad = fixture(false, '', { viewport: { width: 360, height: 505 } });
  try {
    const error = await bad.page.observe().catch(error => error);
    expect(error.invalidatesCampaign).toBe(true);
  } finally { bad.close(); }
});
