import { expect, vi } from 'vitest';
import { store } from '../lib/store.svelte';
import { work } from '../lib/work-prefs.svelte';
import { query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('the trace panel shows the I/O a process moved, and none for a record that measured nothing', async ({ app: _app }) => {
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');

  const client = store.client!;
  const call = client.call.bind(client);
  let reads = 0;
  const requests = vi.spyOn(client, 'call').mockImplementation((method, params) => {
    // Bound a broken feedback loop so the regression fails instead of freezing its worker.
    if (method === 'trace.get' && ++reads > 3) return Promise.reject(new Error('Trace snapshot triggered another trace read'));
    return call(method, params);
  });
  try {
    store.panel.open('trace');
    await waitFor(() => document.querySelectorAll('[data-testid=trace-row]').length === 3);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(reads).toBe(1);

    expect(query('[data-testid=trace-panel]').textContent).toContain('I/O');
    const cellOf = (pid: number): string =>
      query(`[data-testid=trace-row][data-pid="${pid}"] [data-testid=trace-io]`).textContent?.trim() ?? '';
    // 1_240_000 bytes through the same `bytes()` the memory column uses.
    expect(cellOf(21_140)).toBe('1 MB');
    expect(cellOf(21_402)).toBe('80 kB');
    // Nothing measured reads like an unmeasured peak memory, from the same formatter.
    expect(cellOf(21_460)).toBe('none');
    expect(query('[data-testid=trace-row][data-pid="21460"]').textContent).toContain('none');
  } finally { requests.mockRestore(); }
});

test('trace processes disclose the command, PID and measurements without narrow columns', async ({ app: _app }) => {
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');
  store.panel.open('trace');
  await waitFor(() => document.querySelectorAll('[data-testid=trace-row]').length === 3);
  const row = query<HTMLDetailsElement>('[data-testid=trace-row][data-pid="21140"]');
  expect(row.open).toBe(false);
  expect(row.querySelector('.exe')?.textContent).toBe('claude.exe');
  row.querySelector('summary')!.click();
  expect(row.open).toBe(true);
  expect(row.textContent).toContain('21140');
  expect(row.textContent).toContain('CPU time');
  expect(row.querySelector('.command')?.textContent).toContain('claude');
});

test('hiding the trace card takes it off the launcher and leaves an open trace tab alone', async ({ app: _app }) => {
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');
  store.panel.closeAll();
  store.panel.open('trace');
  await waitFor(() => document.querySelector('[data-testid=trace-panel]') !== null);
  work.show('panel.trace', false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.querySelector('[data-testid=trace-panel]')).not.toBeNull();

  store.panel.closeAll();
  store.togglePanel();
  await waitFor(() => document.querySelector('[data-testid=panel-launcher]') !== null);
  expect(document.querySelector('[data-testid=launch-trace]')).toBeNull();
  expect(document.querySelector('[data-testid=launch-files]')).not.toBeNull();
  work.show('panel.trace', true);
  await waitFor(() => document.querySelector('[data-testid=launch-trace]') !== null);
});
