import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { RpcErrorCode, type CoreLogRecord, type CoreLogsQuery } from '@boite/contracts';
import { RpcFailure } from '../lib/client';
import DiagnosticsPage from './DiagnosticsPage.svelte';
import type { Store } from '../lib/store.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** `core.logs` as the core answers it: newest first, `since` and `until` inclusive, at most `limit`. */
function logs(records: CoreLogRecord[], query: CoreLogsQuery): CoreLogRecord[] {
  return records
    .filter(record => (query.since === undefined || record.at >= query.since) && (query.until === undefined || record.at <= query.until))
    .sort((a, b) => b.at - a.at)
    .slice(0, query.limit ?? 100);
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) { await Promise.resolve(); await tick(); }
  flushSync();
}

test('a burst past one page between two reads reaches the page whole, and rows the cap drops leave Load older', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const start = Date.now();
  const record = (index: number): CoreLogRecord => ({ id: `r${index}`, runId: 'run_test', level: 'info', at: start - 60_000 + index, origin: 'core', source: 'test', event: 'test.line', message: `line ${index}` });
  const records = Array.from({ length: 10 }, (_, index) => record(index));
  const call = vi.fn(async (method: string, params: CoreLogsQuery) => {
    if (method === 'core.logs') return logs(records, params);
    return new Promise(() => {});
  });
  const store = { client: { call }, owner: true, connection: 'ready', threads: [], settings: null } as unknown as Store;
  running = mount(DiagnosticsPage, { target: document.body, props: { store } });
  await settle();
  const shown = () => [...document.querySelectorAll('[data-testid=diagnostics-record]')].length;
  expect(shown()).toBe(10);
  expect(document.querySelector('[data-testid=diagnostics-older]')).toBeNull();

  // 450 records in one interval: more than the 200 one read returns.
  for (let index = 10; index < 460; index += 1) records.push(record(index));
  await vi.advanceTimersByTimeAsync(3000);
  await settle();
  expect(shown()).toBe(460);

  // Past the 2000 rows the page keeps, the oldest leave the view and Load older offers them again.
  for (let index = 460; index < 2100; index += 1) records.push(record(index));
  for (let round = 0; round < 3; round += 1) { await vi.advanceTimersByTimeAsync(3000); await settle(); }
  expect(shown()).toBe(2000);
  expect(document.querySelector('[data-testid=diagnostics-older]')).not.toBeNull();
});

test('a core older than the anonymized log names its machine and turns off the export and the report it cannot answer', async () => {
  const call = vi.fn(async (method: string) => {
    if (method === 'core.logs') return [];
    throw new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: `unknown method ${method}` });
  });
  const store = { client: { call }, owner: true, connection: 'ready', threads: [], settings: null, core: { hostname: 'boite' } } as unknown as Store;
  running = mount(DiagnosticsPage, { target: document.body, props: { store } });
  await settle();
  const outdated = document.querySelector('[data-testid=diagnostics-outdated]');
  expect(outdated?.textContent).toContain('Boite on boite');
  expect(document.querySelector('[data-testid=diagnostics-problems]')).toBeNull();
  expect((document.querySelector('[data-testid=diagnostics-export]') as HTMLButtonElement).disabled).toBe(true);
  expect((document.querySelector('[data-testid=diagnostics-report]') as HTMLButtonElement).disabled).toBe(true);
  expect(document.body.textContent).not.toContain('unknown method');
  expect(call.mock.calls.map(([method]) => method)).not.toContain('diagnostics.export');
});

test('a problem says when it was last seen in one sentence, the relative time carrying its own "ago"', async () => {
  const problem = { origin: 'core', source: 'test', event: 'test.failed', level: 'error', count: 1, firstAt: Date.now() - 2_400_000, lastAt: Date.now() - 2_400_000, message: 'failed', threadIds: [] };
  const call = vi.fn(async (method: string) => {
    if (method === 'diagnostics.summary') return { problems: [problem] };
    if (method === 'core.logs') return [];
    return new Promise(() => {});
  });
  const store = { client: { call }, owner: true, connection: 'ready', threads: [], settings: null } as unknown as Store;
  running = mount(DiagnosticsPage, { target: document.body, props: { store } });
  await settle();
  const when = document.querySelector('[data-testid=diagnostics-problem] .when')!.textContent!;
  expect(when).toMatch(/^last seen 40 min\.? ago$/);
});
