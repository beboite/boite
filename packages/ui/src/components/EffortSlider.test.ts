import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { EffortLevel } from '@boite/contracts';
import EffortSlider from './EffortSlider.svelte';
import ComposerOptions from './ComposerOptions.svelte';

const LEVELS: EffortLevel[] = [
  { id: 'off', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'high', label: 'High' }
];

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
});

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

function open(active: string | null, onpick: (id: string) => void, ondefault?: () => void): void {
  mounted = mount(EffortSlider, { target: document.body, props: { levels: LEVELS, active, onpick, ondefault } });
  flushSync();
  query<HTMLButtonElement>('[data-testid=composer-effort]').click();
  flushSync();
}

test('a model whose agent keeps its own level reads Default, with no level lit, until one is picked', () => {
  const onpick = vi.fn();
  // A pi model other than the session's: no level picked and no default known.
  open(null, onpick);
  expect(query('[data-testid=composer-effort]').textContent?.trim()).toBe('Default');
  expect(query('[data-testid=composer-effort-menu] .heading').textContent?.trim()).toBe('Default');
  expect(document.querySelectorAll('[data-testid=composer-effort-menu] .dot.on')).toHaveLength(0);
  expect(document.querySelector('[data-testid=composer-effort-menu] .thumb')).toBeNull();
  expect(query('[data-testid=effort-track]').getAttribute('aria-valuetext')).toBe('Default');

  // Even the first level is a pick, not the level already running.
  query<HTMLButtonElement>('[data-testid=composer-effort-menu] [data-dot=off]').click();
  expect(onpick).toHaveBeenCalledWith('off');
});

test('a known level lights its dots and names itself', () => {
  open('low', vi.fn());
  expect(query('[data-testid=composer-effort]').textContent?.trim()).toBe('Low');
  expect(Array.from(document.querySelectorAll('[data-testid=composer-effort-menu] .dot.on')).map(dot => dot.getAttribute('data-dot'))).toEqual(['off', 'low']);
  expect(document.querySelector('[data-testid=composer-effort-menu] .thumb')).not.toBeNull();
});

test('a level picked on such a model can be handed back to the agent with Default', () => {
  const ondefault = vi.fn();
  open('high', vi.fn(), ondefault);
  query<HTMLButtonElement>('[data-testid=effort-default]').click();
  expect(ondefault).toHaveBeenCalledOnce();
});

test('the Default switch is absent while the agent already picks, and for a model with a default', async () => {
  open(null, vi.fn(), vi.fn());
  expect(document.querySelector('[data-testid=effort-default]')).toBeNull();
  await unmount(mounted!);
  document.body.innerHTML = '';
  open('high', vi.fn());
  expect(document.querySelector('[data-testid=effort-default]')).toBeNull();
});

test('on a phone the options sheet offers Default first and sends no level for it', async () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(max-width: 720px)', media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  const oneffort = vi.fn();
  mounted = mount(ComposerOptions, { target: document.body, props: {
    levels: LEVELS, effort: 'high', agentDefault: true, speeds: [], speed: null, modes: ['default'], modeLabel: (mode: string) => mode, modeHint: () => '',
    mode: 'default', worktree: null, canAttach: false, busy: false, onattach() {}, oneffort, onspeed() {}, onmode() {}, onworktree() {}
  } });
  flushSync();
  query<HTMLButtonElement>('[data-testid=composer-options]').click();
  flushSync();
  const choices = Array.from(document.querySelectorAll<HTMLInputElement>('input[name=mobile-effort]'));
  expect(choices.map(input => input.value)).toEqual(['', 'off', 'low', 'high']);
  choices[0]!.click();
  expect(oneffort).toHaveBeenCalledWith(null);
  vi.restoreAllMocks();
});
