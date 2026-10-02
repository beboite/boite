import { expect, test, vi } from 'vitest';
import { browserDiagnostics, trackBrowserAction } from './browser-tools.svelte';

vi.mock('./browser-bridge', () => ({ browserBridge: {
  on: vi.fn(),
  protocol: vi.fn(async () => ({ entries: [], dropped: 0 })),
} }));

test('action history records failure without retaining evaluated code or exception text', async () => {
  const id = 'history-privacy';
  const failure = new Error('synthetic private page content');
  await expect(trackBrowserAction(id, { kind: 'evaluate', expression: 'synthetic private expression' }, async () => { throw failure; })).rejects.toBe(failure);
  await expect(trackBrowserAction(id, { kind: 'reset-viewport' }, async () => 'reset')).resolves.toBe('reset');
  expect((await browserDiagnostics(id)).history).toEqual([
    { at: expect.any(Number), action: 'evaluate', ok: false, durationMs: expect.any(Number) },
    { at: expect.any(Number), action: 'reset-viewport', ok: true, durationMs: expect.any(Number) },
  ]);
  await browserDiagnostics(id, true);
  expect((await browserDiagnostics(id)).history).toEqual([]);
});
