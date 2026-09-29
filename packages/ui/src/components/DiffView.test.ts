import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import DiffView from './DiffView.svelte';
import { diffPrefs, setDiffPref } from '../lib/diff-prefs.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  setDiffPref('ignoreWhitespace', false);
  setDiffPref('split', false);
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

test('the whitespace switch hides reindented lines for every diff and remembers it', () => {
  running = mount(DiffView, { target: document.body, props: { path: 'a.ts', oldText: 'if (a) {\n  run();\n}\n', newText: 'if (a) {\n    run();\n}\n' } });
  flushSync();
  expect(document.querySelectorAll('[data-testid=diff-row]')).toHaveLength(2 + 2);
  const toggle = document.querySelector<HTMLButtonElement>('[data-testid=diff-whitespace]')!;
  toggle.click();
  flushSync();
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(diffPrefs.ignoreWhitespace).toBe(true);
  expect(JSON.parse(localStorage.getItem('boite.diffView')!)).toEqual({ split: false, ignoreWhitespace: true });
  expect(document.querySelectorAll('[data-testid=diff-row]')).toHaveLength(0);
  expect(document.querySelector('[data-testid=diff-whitespace-only]')).not.toBeNull();
});

test('a narrow box offers no side-by-side view and draws one column', () => {
  setDiffPref('split', true);
  running = mount(DiffView, { target: document.body, props: { path: 'a.ts', oldText: 'a\n', newText: 'b\n' } });
  flushSync();
  expect(document.querySelector('[data-testid=diff-split]')).toBeNull();
  expect(document.querySelector('[data-testid=diff-view]')!.getAttribute('data-layout')).toBe('unified');
});
