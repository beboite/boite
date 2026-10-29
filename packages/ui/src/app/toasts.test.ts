import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { type FakeClient } from '../lib/fake-client';
import { droppedFailure } from '../lib/client';
import { store } from '../lib/store.svelte';
import { test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('an offline read failure stays in machine status while action errors remain visible', async ({ app: _app }) => {
  const connection = store.connection;
  try {
    store.connection = 'connecting';
    store.reportError(droppedFailure('connection lost; check the conversation before resending'));
    flushSync();
    expect(store.errorOffline).toBe(true);
    expect(document.querySelector('[data-testid=error-toast]')).toBeNull();
    store.reportError(new Error('project permission denied'));
    flushSync();
    expect(document.querySelector('[data-testid=error-toast]')?.textContent).toContain('project permission denied');
  } finally { store.connection = connection; store.error = null; flushSync(); }
});

test('an error line of the core log shows the error toast, a warning does not', async ({ app: _app }) => {
  const fake = store.client as unknown as FakeClient;
  // Events reach the store as they are sent, so the warning has been handled once this returns.
  fake.emitCoreLog('warn', 'the disk is slow');
  expect(store.error).toBeNull();
  fake.emitCoreLog('error', 'the scheduler failed');
  await waitFor(() => document.querySelector('[data-testid=error-toast]')?.textContent?.includes('the scheduler failed') === true);
});

test('minor errors expire after five seconds and repeated errors get a fresh delay', async ({ app: _app }) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    store.reportError('og.jpg: file does not exist', 'minor');
    flushSync();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(store.error).toBe('og.jpg: file does not exist');
    expect(document.querySelector('[data-testid=error-toast]')).not.toBeNull();
    store.reportError('og.jpg: file does not exist', 'minor');
    flushSync();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(store.error).toBe('og.jpg: file does not exist');
    await vi.advanceTimersByTimeAsync(1);
    flushSync();
    expect(store.error).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[data-testid=error-toast]')).toBeNull();
  } finally { vi.useRealTimers(); }
});

test('a major error replacing a minor error remains visible beyond its timer', async ({ app: _app }) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    store.reportError('og.jpg: file does not exist', 'minor');
    flushSync();
    await vi.advanceTimersByTimeAsync(4_000);
    (store.client as unknown as FakeClient).emitCoreLog('error', 'the scheduler failed');
    flushSync();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.error).toBe('the scheduler failed');
    expect(store.errorSeverity).toBe('major');
    expect(document.querySelector('[data-testid=error-toast]')?.textContent).toContain('the scheduler failed');
    store.error = null;
    flushSync();
  } finally { vi.useRealTimers(); }
});
