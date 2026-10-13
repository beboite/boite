import { expect, vi } from 'vitest';
import { store } from '../lib/store.svelte';
import { count } from '../lib/format';
import { query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('the composer wears the context meter, a compaction is a divider, and a turn moves the meter', async ({ app: _app }) => {
  await waitFor(() => store.openThread?.id === 't-descriptors');

  // 31k of 200k, just compacted: the ring reads 16 percent and the divider says what went.
  await waitFor(() => document.querySelector('[data-testid=context-meter]') !== null);
  const meter = query('[data-testid=context-meter]');
  expect(meter.closest('[data-testid=composer]')).not.toBeNull();
  expect(query('[data-testid=context-trigger]').textContent?.trim()).toBe('');
  expect(meter.dataset.percent).toBe('16');
  expect(meter.dataset.level).toBe('low');
  query<HTMLButtonElement>('[data-testid=context-trigger]').click();
  await waitFor(() => document.querySelector('[data-testid=context-popup]') !== null);
  expect(query('[data-testid=context-popup]').textContent).toContain(count(31000));
  expect(query('[data-testid=compaction-part]').textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Context compacted, 184K to 31K tokens'
  );

  const input = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  input.value = 'one more turn';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => store.openThread?.status === 'idle' && (store.openThread?.context?.tokens ?? 0) > 31_000);
  // 31_000 + 600 + 13 * 4 = 31_652 of 200_000: still 16 percent, the tooltip moved.
  expect(query('[data-testid=context-meter]').dataset.percent).toBe('16');

  // A thread whose agent never reported wears no meter.
  query<HTMLButtonElement>('[data-thread-id="t-bench"]').click();
  await waitFor(() => store.openThread?.id === 't-bench');
  query<HTMLButtonElement>('[data-testid=context-trigger]').click();
  await waitFor(() => document.querySelector('[data-testid=context-popup]') !== null);
  expect(query('[data-testid=context-popup]').textContent).toContain('No measurement received');
});
