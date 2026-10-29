import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AutoCompact, CompactionTarget, Settings } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import AutoCompactSettings from './AutoCompactSettings.svelte';
import KeyedHost from './AutoCompactSettings.test-host.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const input = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;

function render(autoCompact: AutoCompact | null, target?: CompactionTarget, compactionByType?: Settings['compactionByType']) {
  const store = $state({
    owner: true,
    settings: { autoCompact, compactionByType, backgroundCompaction: true } as Partial<Settings>,
    saveSettings: vi.fn(async (patch: Partial<Settings>) => {
      store.settings = { ...store.settings, ...patch };
      return true;
    }),
  });
  mounted = mount(AutoCompactSettings, { target: document.body, props: { store: store as unknown as Store, target } });
  flushSync();
  return store;
}
const flip = async (id: string, checked: boolean) => {
  const box = input(id);
  box.checked = checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
};

test('a subagent edit preserves common defaults, other types and its background setting', async () => {
  const store = render({ tokens: 200_000, moments: ['cache-expiry'] }, 'subagent', {
    subagent: { autoCompact: { tokens: 400_000, moments: ['turn-end'] }, backgroundCompaction: false },
    bot: { autoCompact: null, backgroundCompaction: true },
  });
  expect(input('auto-compact-tokens').value).toBe('400000');
  await flip('auto-compact-turn-end', false);
  expect(store.settings.autoCompact?.tokens).toBe(200_000);
  expect(store.settings.compactionByType).toEqual({
    subagent: { autoCompact: { tokens: 400_000, moments: [] }, backgroundCompaction: false },
    bot: { autoCompact: null, backgroundCompaction: true },
  });
});

test('switching it on asks for no size, and the last moment switched off turns it all off', async () => {
  const store = render(null);
  expect(input('auto-compact-threshold')).toBeNull();
  await flip('auto-compact-on', true);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: null, moments: ['background', 'cache-expiry'] } });
  expect(input('auto-compact-turn-end').checked).toBe(false);
  expect(input('auto-compact-threshold').checked).toBe(false);
  expect(input('auto-compact-tokens')).toBeNull();

  await flip('auto-compact-turn-end', true);
  expect(store.settings.autoCompact?.moments).toEqual(['turn-end', 'background', 'cache-expiry']);
  for (const moment of ['turn-end', 'background', 'cache-expiry']) await flip(`auto-compact-${moment}`, false);
  expect(store.settings.autoCompact).toBeNull();
  expect(input('auto-compact-on').checked).toBe(false);
});

test('the independent token limit survives switching off the last idle moment until its own switch is off', async () => {
  const store = render({ tokens: 200_000, moments: ['cache-expiry'] });
  await flip('auto-compact-cache-expiry', false);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 200_000, moments: [] } });
  expect(store.settings.autoCompact).toEqual({ tokens: 200_000, moments: [] });
  expect(input('auto-compact-on').checked).toBe(true);
  expect(input('auto-compact-threshold').checked).toBe(true);
  expect(input('auto-compact-tokens').value).toBe('200000');
  expect(input('auto-compact-cache-expiry').checked).toBe(false);

  await flip('auto-compact-threshold', false);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: null });
  expect(store.settings.autoCompact).toBeNull();
  expect(input('auto-compact-on').checked).toBe(false);
  expect(input('auto-compact-threshold')).toBeNull();
});

test('the size is its own switch: on it saves a valid number or a preset, off it goes back to any size', async () => {
  const store = render({ tokens: null, moments: ['turn-end'] });
  await flip('auto-compact-threshold', true);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 200_000, moments: ['turn-end'] } });
  const type = async (value: string) => {
    const field = input('auto-compact-tokens');
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  };
  const calls = store.saveSettings.mock.calls.length;
  await type('500');
  expect(store.saveSettings.mock.calls.length).toBe(calls);
  expect(document.querySelector('[data-testid="auto-compact-tokens-error"]')).not.toBeNull();
  await type('350000');
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 350_000, moments: ['turn-end'] } });
  input('auto-compact-preset-400000').click();
  await settle();
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 400_000, moments: ['turn-end'] } });
  expect(input('auto-compact-tokens').value).toBe('400000');

  await flip('auto-compact-threshold', false);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: null, moments: ['turn-end'] } });
  await flip('auto-compact-threshold', true);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 400_000, moments: ['turn-end'] } });
});

test('no control moves while a save is on its way, so a second change never rebuilds the rule from the old one', async () => {
  const store = render({ tokens: null, moments: ['background', 'cache-expiry'] });
  let answer!: (ok: boolean) => void;
  store.saveSettings.mockImplementationOnce((patch: Partial<Settings>) => new Promise<boolean>(resolve => {
    answer = ok => { store.settings = { ...store.settings, ...patch }; resolve(ok); };
  }));
  await flip('auto-compact-background', false);
  for (const id of ['auto-compact-on', 'auto-compact-turn-end', 'auto-compact-cache-expiry', 'auto-compact-threshold']) expect(input(id).disabled).toBe(true);
  answer(true);
  await settle();
  expect(input('auto-compact-turn-end').disabled).toBe(false);
  await flip('auto-compact-turn-end', true);
  expect(store.settings.autoCompact).toEqual({ tokens: null, moments: ['turn-end', 'cache-expiry'] });
});

test('a preset waits for summary instructions to save before rebuilding the type policy', async () => {
  const store = render({ tokens: 100_000, moments: ['cache-expiry'] }, 'subagent', {
    subagent: { autoCompact: { tokens: 200_000, moments: ['turn-end'] }, backgroundCompaction: false, compactionSummary: 'old' },
    bot: { autoCompact: null, backgroundCompaction: true },
  });
  const answers: (() => void)[] = [];
  store.saveSettings.mockImplementation((patch: Partial<Settings>) => new Promise<boolean>(resolve => {
    answers.push(() => { store.settings = { ...store.settings, ...patch }; resolve(true); });
  }));
  const summary = document.querySelector<HTMLTextAreaElement>('[data-testid="compaction-summary"]')!;
  summary.value = 'new instructions';
  summary.dispatchEvent(new Event('input', { bubbles: true }));
  summary.dispatchEvent(new Event('blur'));
  await settle();
  const switchesDisabled = ['auto-compact-on', 'auto-compact-turn-end', 'auto-compact-threshold']
    .every(id => input(id).disabled);
  input('auto-compact-preset-400000').click();
  await settle();
  const requestsBeforeAnswer = store.saveSettings.mock.calls.length;
  answers.shift()!();
  await settle();
  answers.shift()!();
  await settle();

  expect(store.settings.compactionByType?.subagent).toEqual({
    autoCompact: { tokens: 400_000, moments: ['turn-end'] }, backgroundCompaction: false, compactionSummary: 'new instructions',
  });
  expect(requestsBeforeAnswer).toBe(1);
  expect(switchesDisabled).toBe(true);
  expect(store.saveSettings).toHaveBeenCalledTimes(2);
  expect(store.settings.autoCompact?.tokens).toBe(100_000);
  expect(store.settings.compactionByType?.bot).toEqual({ autoCompact: null, backgroundCompaction: true });
});

test('a typed size saves after a pause or when the page leaves, without waiting for the field to lose focus', async () => {
  vi.useFakeTimers();
  try {
    const store = render({ tokens: 200_000, moments: ['cache-expiry'] });
    const typeOnly = async (value: string) => {
      const field = input('auto-compact-tokens');
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    };
    await typeOnly('250000');
    expect(store.saveSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 250_000, moments: ['cache-expiry'] } });
    expect(document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state')).toBe('saved');

    // A save on its way never takes the focus from the field being typed in.
    let answer!: (ok: boolean) => void;
    store.saveSettings.mockImplementationOnce((patch: Partial<Settings>) => new Promise<boolean>(resolve => {
      answer = ok => { store.settings = { ...store.settings, ...patch }; resolve(ok); };
    }));
    await typeOnly('300000');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(input('auto-compact-tokens').disabled).toBe(false);
    answer(true);
    await settle();

    // Leaving the page with a size still typed saves it.
    await typeOnly('450000');
    await unmount(mounted!);
    mounted = undefined;
    await settle();
    expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 450_000, moments: ['cache-expiry'] } });
  } finally {
    vi.useRealTimers();
  }
});

test('retrying a refused size leaves the switch alone, and the switch clears what the field left behind', async () => {
  const store = render({ tokens: 200_000, moments: ['cache-expiry'] });
  const type = async (value: string) => {
    const field = input('auto-compact-tokens');
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  };
  store.saveSettings.mockResolvedValueOnce(false);
  await type('250000');
  const status = () => document.querySelector('[data-testid="save-status"]');
  expect(status()?.getAttribute('data-state')).toBe('error');
  (status()!.querySelector('.reason') as HTMLElement).click();
  await settle();
  expect(input('auto-compact-threshold').checked).toBe(true);
  status()!.querySelector('button')!.click();
  await settle();
  expect(input('auto-compact-threshold').checked).toBe(true);
  expect(store.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 250_000, moments: ['cache-expiry'] } });

  await type('500');
  expect(status()?.getAttribute('data-state')).toBe('invalid');
  await flip('auto-compact-threshold', false);
  await flip('auto-compact-threshold', true);
  expect(input('auto-compact-tokens').value).toBe('200000');
  expect(status()).toBeNull();
  // A size changed elsewhere shows once the switch has sent the field's.
  store.settings = { ...store.settings, autoCompact: { tokens: 600_000, moments: ['cache-expiry'] } };
  await settle();
  expect(input('auto-compact-tokens').value).toBe('600000');
});

test('a size typed on one machine saves there when the settings bar switches to another', async () => {
  const make = () => {
    const machine = $state({ owner: true, settings: { autoCompact: { tokens: 200_000, moments: ['cache-expiry'] } } as Partial<Settings>,
      saveSettings: vi.fn(async (patch: Partial<Settings>) => { machine.settings = { ...machine.settings, ...patch }; return true; }) });
    return machine;
  };
  const first = make(), second = make();
  const pick = $state({ store: first as unknown as Store });
  mounted = mount(KeyedHost, { target: document.body, props: { pick } });
  flushSync();
  const field = input('auto-compact-tokens');
  field.value = '250000';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  pick.store = second as unknown as Store;
  await settle();
  expect(first.saveSettings).toHaveBeenLastCalledWith({ autoCompact: { tokens: 250_000, moments: ['cache-expiry'] } });
  expect(second.saveSettings).not.toHaveBeenCalled();
});

test('a size typed while a switch saves goes after it, on the rule that switch left', async () => {
  vi.useFakeTimers();
  try {
    const store = render({ tokens: 200_000, moments: ['background', 'cache-expiry'] });
    let answer!: (ok: boolean) => void;
    store.saveSettings.mockImplementationOnce((patch: Partial<Settings>) => new Promise<boolean>(resolve => {
      answer = ok => { store.settings = { ...store.settings, ...patch }; resolve(ok); };
    }));
    await flip('auto-compact-background', false);
    const field = input('auto-compact-tokens');
    field.value = '250000';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(store.saveSettings).toHaveBeenCalledTimes(1);
    answer(true);
    await settle();
    expect(store.settings.autoCompact).toEqual({ tokens: 250_000, moments: ['cache-expiry'] });
  } finally {
    vi.useRealTimers();
  }
});
