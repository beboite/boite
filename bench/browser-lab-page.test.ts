import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LabPage, labStateScript } from './browser-lab-page.ts';

test('browser evidence script parses as browser JavaScript', () => {
  expect(() => new Function('return ' + labStateScript)).not.toThrow();
});

const task = { id: 'scope', url: 'https://example.org/', hosts: ['example.org'], goal: 'Read public pages', rubric: ['Read'] };
function fixture(vision = false, snapshot = '- link "Next" [ref=e1]', state: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lab-page-'));
  const calls: any[] = [];
  const engine = { command: async (action: string, args: any = {}): Promise<Record<string, any>> => {
    calls.push({ action, args });
    if (action === 'evaluate') return { result: { url: task.url, title: 'Example', text: 'Read', links: [{ text: 'Next', url: 'https://example.org/next' }], ...state } };
    if (action === 'snapshot') return { snapshot };
    if (action === 'tabs') return { tabs: [{ tabId: 't1', url: task.url }] };
    if (action === 'screenshot') { writeFileSync(args.path, 'image-fixture'); return { path: args.path }; }
    return { ok: true };
  } };
  return { calls, page: new LabPage(engine, task, vision, directory, performance.now() + 60_000), close: () => rmSync(directory, { recursive: true, force: true }) };
}

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
