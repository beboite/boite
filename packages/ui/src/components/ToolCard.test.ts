import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ToolCard from './ToolCard.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

/** Eight keys, so the pretty printed json is ten lines: past the six-line cut. */
const LONG_INPUT = {
  file_path: 'packages/core/src/main.ts',
  offset: 1,
  limit: 200,
  encoding: 'utf8',
  follow: false,
  retries: 2,
  timeoutMs: 5000,
  reason: 'read the entry point'
};

function openCard(input: unknown): void {
  running = mount(ToolCard, {
    target: document.body,
    props: { name: 'Read', input, output: 'ok', status: 'done' as const }
  });
  flushSync();
  query<HTMLButtonElement>('[data-testid=tool-toggle]').click();
  flushSync();
}

test('an expanded input past six lines opens cut, and Show all opens the rest', () => {
  openCard(LONG_INPUT);

  const pre = query<HTMLPreElement>('[data-testid=tool-input]');
  expect(pre.textContent?.split('\n').length).toBeGreaterThan(6);
  expect(pre.classList.contains('clamped')).toBe(true);

  // The text is whole under the cut: only the box is shorter, so a copy is complete.
  expect(pre.textContent).toContain('read the entry point');

  query<HTMLButtonElement>('[data-testid=tool-input-show-all]').click();
  flushSync();

  expect(query('[data-testid=tool-input]').classList.contains('clamped')).toBe(false);
  expect(document.querySelector('[data-testid=tool-input-show-all]')).toBeNull();
});

test('a short input has no cut and no Show all', () => {
  openCard({ file_path: 'packages/ui/src/app.css' });

  expect(query('[data-testid=tool-input]').classList.contains('clamped')).toBe(false);
  expect(document.querySelector('[data-testid=tool-input-show-all]')).toBeNull();
});
