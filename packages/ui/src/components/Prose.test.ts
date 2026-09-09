import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Prose from './Prose.svelte';

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

test('a fenced block carries a copy button that writes the code to the clipboard', async () => {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

  running = mount(Prose, {
    target: document.body,
    props: { text: 'Run it:\n\n```sh\nbun run --cwd packages/ui test\n```\n' }
  });
  flushSync();
  await tick();

  // One button per fenced block, inside the wrapper the effect hangs around it.
  const button = query<HTMLButtonElement>('[data-testid=code-copy]');
  expect(button.parentElement?.classList.contains('code-block')).toBe(true);
  expect(document.querySelectorAll('[data-testid=code-copy]')).toHaveLength(1);
  expect(button.textContent).toBe('Copy');

  button.click();
  await tick();
  await tick();

  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText.mock.calls[0]?.[0]).toContain('bun run --cwd packages/ui test');
  expect(button.textContent).toBe('Copied');

  // The label goes back on the way out, so nothing has to time it.
  button.dispatchEvent(new Event('pointerleave'));
  expect(button.textContent).toBe('Copy');
});

test('a block that is still being written carries no button yet', async () => {
  // The pass that hangs them walks every block of the answer, and it ran every
  // 48 ms while the part streamed, for a button on code nobody can copy yet.
  running = mount(Prose, {
    target: document.body,
    props: { text: 'Run it:\n\n```sh\nbun run --cwd packages/ui te', live: true }
  });
  flushSync();
  // Past the 48 ms the markdown itself is gated on, so the block is really there.
  await new Promise((resolve) => setTimeout(resolve, 120));
  flushSync();
  await tick();

  expect(document.querySelector('pre')).not.toBeNull();
  expect(document.querySelector('[data-testid=code-copy]')).toBeNull();
});

test('text with no fenced block gets no button', async () => {
  running = mount(Prose, { target: document.body, props: { text: 'Plain `inline` text only.' } });
  flushSync();
  await tick();

  expect(document.querySelector('[data-testid=code-copy]')).toBeNull();
});
