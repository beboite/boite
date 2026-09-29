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
  document.body.innerHTML = '';
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
