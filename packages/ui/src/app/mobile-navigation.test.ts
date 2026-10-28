import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { store } from '../lib/store.svelte';
import { mountOnFake, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

// The phone's navigation chunk, swapped for one this test fails on purpose
// once the setup has loaded the real one (`test-setup.ts`). A getter, so App
// reads whichever is current when it runs.
const navigation = vi.hoisted(() => ({ part: undefined as unknown, fail: undefined as ((error: Error) => void) | undefined }));
vi.mock('../lib/mobile-navigation', async (original) => {
  const real = await original<typeof import('../lib/mobile-navigation')>();
  navigation.part = real.mobileNavigation;
  return { ...real, get mobileNavigation() { return navigation.part; } };
});

test('a navigation chunk that fails after the core answered says so, and a retry brings the phone header', async () => {
  const { LazyComponent } = await import('../lib/lazy-component.svelte');
  let calls = 0;
  navigation.part = new LazyComponent(() => {
    calls += 1;
    if (calls > 1) return import('../components/MobileNavigation.svelte');
    return new Promise((_, reject) => { navigation.fail = reject; });
  });

  const mounted = mountOnFake();
  await waitFor(() => store.connection === 'ready' && navigation.fail !== undefined);
  // Still on its way: the page holds its boot screen rather than a phone with no header.
  expect(document.querySelector('.app.ready')).toBeNull();
  navigation.fail!(new Error('offline'));
  await mounted;

  expect(document.querySelector('[data-testid=mobile-navigation-failed]')?.getAttribute('role')).toBe('alert');
  expect(document.querySelector('[data-testid=mobile-header]')).toBeNull();
  document.querySelector<HTMLButtonElement>('[data-testid=mobile-navigation-retry]')!.click();
  flushSync();
  await waitFor(() => document.querySelector('[data-testid=mobile-header]') !== null);
  expect(calls).toBe(2);
  expect(document.querySelector('[data-testid=mobile-navigation-failed]')).toBeNull();
});
