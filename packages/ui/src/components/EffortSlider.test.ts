import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { EffortLevel } from '@boite/contracts';
import EffortSlider from './EffortSlider.svelte';

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

function open(active: string | null, onpick: (id: string) => void): void {
  mounted = mount(EffortSlider, { target: document.body, props: { levels: LEVELS, active, onpick } });
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
