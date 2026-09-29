import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import MessageActions from './MessageActions.svelte';
import { contextMenu } from '../lib/context-menu.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  contextMenu.close();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function draw(props: Record<string, unknown>): HTMLElement {
  running = mount(MessageActions, { target: document.body, props: props as never });
  flushSync();
  return document.body.querySelector('[data-testid=message-actions]')!;
}

function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  return writeText;
}

test('the copy button takes the whole message, read at the click, and says it copied', async () => {
  const writeText = stubClipboard();
  let answer = 'first';
  const row = draw({ text: () => answer });
  answer = 'first\n\nsecond';
  const copy = row.querySelector<HTMLButtonElement>('[data-testid=message-copy]')!;
  copy.click();
  await tick();
  await Promise.resolve();
  flushSync();
  expect(writeText).toHaveBeenCalledWith('first\n\nsecond');
  expect(copy.getAttribute('aria-label')).toBe('Copied');
});

test('only the actions handed over are drawn, and an empty text hides the copy', () => {
  const row = draw({ text: '' });
  expect(row.querySelector('button')).toBeNull();
  unmount(running!, { outro: false });
  const all = draw({ text: 'x', edit: () => {}, retry: () => {}, fork: () => {} });
  expect([...all.querySelectorAll('button')].map((button) => button.dataset['testid'])).toEqual(['message-copy', 'message-edit', 'message-retry', 'message-fork']);
});

test('a prompt shows its clock and reads its exact time on hover', () => {
  const at = Date.UTC(2026, 8, 28, 10, 31, 5);
  const row = draw({ text: 'x', at });
  const time = row.querySelector<HTMLTimeElement>('[data-testid=message-time]')!;
  expect(time.dateTime).toBe(new Date(at).toISOString());
  expect(time.title.startsWith('Sent ')).toBe(true);
  expect(time.title).toMatch(/2026/);
});

test('fork asks where: the same checkout or a worktree of its own', () => {
  const fork = vi.fn();
  const row = draw({ text: 'x', fork });
  row.querySelector<HTMLButtonElement>('[data-testid=message-fork]')!.click();
  expect(contextMenu.current?.items.map((item) => item.id)).toEqual(['here', 'worktree']);
  contextMenu.current!.onpick('worktree');
  expect(fork).toHaveBeenCalledWith(true);
  contextMenu.current!.onpick('here');
  expect(fork).toHaveBeenLastCalledWith(false);
});
