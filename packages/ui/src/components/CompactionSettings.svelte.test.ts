import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Settings } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import CompactionSettings from './CompactionSettings.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });
const settle = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); flushSync(); } };
const node = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
const click = async (id: string) => { node(id).click(); await settle(); };
const flip = async (id: string, checked: boolean) => {
  node(id).checked = checked;
  node(id).dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
};
function render(backgroundOnly = false) {
  const store = $state({ owner: true, settings: {
    autoCompact: { tokens: 200_000, moments: ['cache-expiry'] }, backgroundCompaction: true,
  } as Partial<Settings>, saveSettings: vi.fn(async (patch: Partial<Settings>) => {
    store.settings = { ...store.settings, ...patch }; return true;
  }) });
  mounted = mount(CompactionSettings, { target: document.body, props: { store: store as unknown as Store, backgroundOnly } });
  flushSync();
  return store;
}

test('types inherit live defaults, customize independently, and can restore inheritance', async () => {
  const store = render();
  for (const type of ['agent', 'subagent', 'bot']) {
    await click(`compaction-target-${type}`);
    expect(node('compaction-inherited')).not.toBeNull();
    expect(node('auto-compact-tokens').matches(':disabled')).toBe(true);
    expect(node('auto-compact-tokens').value).toBe('200000');
  }
  await click('compaction-target-subagent');
  await flip('compaction-customize', true);
  expect(store.settings.compactionByType?.subagent).toEqual({
    autoCompact: { tokens: 200_000, moments: ['cache-expiry'] }, backgroundCompaction: true,
  });
  await click('auto-compact-preset-400000');
  await click('compaction-target-common');
  await click('auto-compact-preset-800000');
  await click('compaction-target-bot');
  expect(node('auto-compact-tokens').value).toBe('800000');
  await flip('compaction-customize', true);
  // A null rule explicitly disables the bot instead of falling back to common.
  await flip('auto-compact-on', false);
  expect(store.settings.compactionByType?.bot?.autoCompact).toBeNull();
  await click('compaction-target-subagent');
  expect(node('auto-compact-tokens').value).toBe('400000');
  // Reset also flushes a pending edit before removing its type, so it cannot reappear.
  node('auto-compact-tokens').value = '350000';
  node('auto-compact-tokens').dispatchEvent(new Event('input', { bubbles: true }));
  await flip('compaction-customize', false);
  expect(store.settings.compactionByType?.subagent).toBeUndefined();
  expect(store.settings.compactionByType?.bot?.autoCompact).toBeNull();
  expect(node('auto-compact-tokens').value).toBe('800000');
});

test('experimental background compaction is independently configurable for each type', async () => {
  const store = render(true);
  await click('compaction-target-bot');
  await flip('compaction-customize', true);
  await flip('background-compaction-on', false);
  expect(store.settings.backgroundCompaction).toBe(true);
  expect(store.settings.compactionByType?.bot).toEqual({
    autoCompact: { tokens: 200_000, moments: ['cache-expiry'] }, backgroundCompaction: false,
  });
  await click('compaction-target-agent');
  expect(node('background-compaction-on').checked).toBe(true);
  expect(node('background-compaction-on').matches(':disabled')).toBe(true);
});

test('a draft saves to its original type when switching scopes', async () => {
  const store = render();
  await click('compaction-target-subagent');
  await flip('compaction-customize', true);
  node('auto-compact-tokens').value = '350000';
  node('auto-compact-tokens').dispatchEvent(new Event('input', { bubbles: true }));
  await click('compaction-target-bot');
  expect(store.settings.compactionByType?.subagent?.autoCompact?.tokens).toBe(350_000);
  expect(store.settings.compactionByType?.bot).toBeUndefined();
  expect(node('auto-compact-tokens').value).toBe('200000');
});

test.each([false, true])('switching types awaits the previous save before another edit (backgroundOnly=%s)', async (backgroundOnly) => {
  const store = render(backgroundOnly);
  await click('compaction-target-subagent');
  await flip('compaction-customize', true);
  let answer!: () => void;
  store.saveSettings.mockImplementationOnce((patch: Partial<Settings>) => new Promise<boolean>(resolve => {
    answer = () => { store.settings = { ...store.settings, ...patch }; resolve(true); };
  }));
  if (backgroundOnly) await flip('background-compaction-on', false);
  else await click('auto-compact-preset-400000');
  await click('compaction-target-bot');
  expect(node('compaction-target-subagent').getAttribute('aria-pressed')).toBe('true');
  answer();
  await settle();
  expect(node('compaction-target-bot').getAttribute('aria-pressed')).toBe('true');
  await flip('compaction-customize', true);
  if (backgroundOnly) {
    await flip('background-compaction-on', false);
    expect(store.settings.compactionByType?.subagent?.backgroundCompaction).toBe(false);
    expect(store.settings.compactionByType?.bot?.backgroundCompaction).toBe(false);
  } else {
    await click('auto-compact-preset-800000');
    expect(store.settings.compactionByType?.subagent?.autoCompact?.tokens).toBe(400_000);
    expect(store.settings.compactionByType?.bot?.autoCompact?.tokens).toBe(800_000);
  }
});
