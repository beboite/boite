import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import DiffView from './DiffView.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

test('a long diff draws its first rows and the rest on demand, with exact counts', () => {
  const newText = Array.from({ length: 1000 }, (_, index) => `const line${index} = ${index};`).join('\n');
  running = mount(DiffView, { target: document.body, props: { path: 'src/big.ts', oldText: '', newText } });
  flushSync();
  expect(document.querySelectorAll('[data-testid=diff-row]')).toHaveLength(300);
  expect(document.querySelector('[data-testid=diff-view] .head')!.textContent).toContain('+1000');
  const more = document.querySelector<HTMLButtonElement>('[data-testid=diff-show-all]')!;
  expect(more.textContent).toContain('1000');
  more.click();
  flushSync();
  expect(document.querySelectorAll('[data-testid=diff-row]')).toHaveLength(1000);
  expect(document.querySelector('[data-testid=diff-show-all]')).toBeNull();
});

test('a short diff has no show-all button', () => {
  running = mount(DiffView, { target: document.body, props: { path: 'a.ts', oldText: 'a\n', newText: 'b\n' } });
  flushSync();
  expect(document.querySelectorAll('[data-testid=diff-row]')).toHaveLength(2);
  expect(document.querySelector('[data-testid=diff-show-all]')).toBeNull();
});
