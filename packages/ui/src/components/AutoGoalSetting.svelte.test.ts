import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Settings } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import AutoGoalSetting from './AutoGoalSetting.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const field = () => document.querySelector<HTMLInputElement>('[data-testid="auto-goal-min-chars"]')!;
const type = async (value: string) => {
  field().value = value;
  field().dispatchEvent(new Event('input', { bubbles: true }));
  field().dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
};

test('a length typed back to the saved one still follows a change saved elsewhere', async () => {
  const store = $state({
    owner: true,
    settings: { autoGoalMinChars: 1500 } as Partial<Settings>,
    saveSettings: vi.fn(async () => true),
  });
  mounted = mount(AutoGoalSetting, { target: document.body, props: { store: store as unknown as Store } });
  flushSync();
  await type('1600');
  await type('1500');
  expect(store.saveSettings).toHaveBeenCalledTimes(1);

  store.settings = { autoGoalMinChars: 3000 };
  await settle();
  expect(field().value).toBe('3000');
});

test('a length typed back before the field loses focus, so with no change event, still follows a change saved elsewhere', async () => {
  const store = $state({
    owner: true,
    settings: { autoGoalMinChars: 1500 } as Partial<Settings>,
    saveSettings: vi.fn(async () => true),
  });
  mounted = mount(AutoGoalSetting, { target: document.body, props: { store: store as unknown as Store } });
  flushSync();
  for (const value of ['1600', '1500']) {
    field().value = value;
    field().dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  }
  store.settings = { autoGoalMinChars: 3000 };
  await settle();
  expect(field().value).toBe('3000');
  expect(store.saveSettings).not.toHaveBeenCalled();
});
