import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ThinkingPart from './ThinkingPart.svelte';
import * as markdown from '../lib/markdown';

vi.mock('../lib/markdown', async (original) => {
  const actual = await original<typeof import('../lib/markdown')>();
  return { ...actual, renderMarkdown: vi.fn(actual.renderMarkdown) };
});

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

test('reasoning ticks while live, freezes at its recorded end and leaves old blocks untimed', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const props = $state({ text: 'Checking files', live: true, startedAt: 8_000 as number | null, finishedAt: null as number | null });
  running = mount(ThinkingPart, { target: document.body, props });
  flushSync();
  expect(document.querySelector('[data-testid=thinking-elapsed]')?.textContent).toBe('2s');
  vi.advanceTimersByTime(3000);
  flushSync();
  expect(document.querySelector('[data-testid=thinking-elapsed]')?.textContent).toBe('5s');
  props.live = false;
  props.finishedAt = 12_000;
  flushSync();
  vi.advanceTimersByTime(20_000);
  flushSync();
  expect(document.querySelector('[data-testid=thinking-elapsed]')?.textContent).toBe('4s');
  expect(vi.getTimerCount()).toBe(0);
  props.startedAt = null;
  flushSync();
  expect(document.querySelector('[data-testid=thinking-elapsed]')).toBeNull();
});

test('opening reasoning keeps earlier headings and shows the paragraph still arriving', () => {
  const props = $state({ text: '**Inspecting files**\nFirst finding.\n\n**Checking results**\nStill checking', live: true });
  running = mount(ThinkingPart, { target: document.body, props });
  flushSync();
  document.querySelector<HTMLButtonElement>('[data-testid=thinking-toggle]')!.click();
  flushSync();
  const body = document.querySelector('[data-testid=thinking-text]')!;
  expect(body.textContent).toContain('Inspecting files');
  expect(body.textContent).toContain('Still checking');
  props.live = false;
  flushSync();
  expect(body.querySelectorAll('strong')).toHaveLength(2);
});

test('a folded reasoning renders each new paragraph once and keeps the earlier ones', () => {
  const props = $state({ text: '', live: true });
  running = mount(ThinkingPart, { target: document.body, props });
  flushSync();
  const toggle = document.querySelector<HTMLButtonElement>('[data-testid=thinking-toggle]')!;
  toggle.click();
  flushSync();
  toggle.click();
  flushSync();

  const render = vi.mocked(markdown.renderMarkdown);
  render.mockClear();
  let first: Element | null = null;
  const paragraph = 'Checking the next file for the same pattern before changing anything. '.repeat(3).trim();
  for (let index = 0; index < 40; index += 1) {
    for (const word of `${paragraph} (${index})`.split(' ')) {
      props.text += `${word} `;
      flushSync();
    }
    props.text += '\n\n';
    flushSync();
    first ??= document.querySelector('[data-testid=thinking-text] p');
  }
  props.live = false;
  flushSync();

  const body = document.querySelector('[data-testid=thinking-text]')!;
  expect(body.querySelectorAll('p')).toHaveLength(40);
  // The first paragraph is the node it was when it arrived: nothing rewrote the whole body.
  expect(body.querySelector('p')).toBe(first);
  // Each paragraph went through the renderer about once, not the whole text once per paragraph.
  const rendered = render.mock.calls.reduce((sum, [source]) => sum + source.length, 0);
  expect(rendered).toBeLessThan(props.text.length * 2);
});

test('a reasoning with no text offers nothing to unfold', () => {
  const props = $state({ text: '', live: true });
  running = mount(ThinkingPart, { target: document.body, props });
  flushSync();
  const toggle = document.querySelector<HTMLButtonElement>('[data-testid=thinking-toggle]')!;
  toggle.click();
  flushSync();
  expect(toggle.querySelector('.fold-caret')).toBeNull();
  expect(toggle.hasAttribute('aria-expanded')).toBe(false);
  expect(document.querySelector('.fold')!.classList.contains('open')).toBe(false);

  props.text = 'Reading the file.';
  flushSync();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelector('.fold')!.classList.contains('open')).toBe(true);
});
