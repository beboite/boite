import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PermissionCard from './PermissionCard.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

function button(id: 'permission-allow' | 'permission-deny'): HTMLButtonElement {
  const node = document.querySelector<HTMLButtonElement>(`[data-testid=${id}]`);
  if (!node) throw new Error(`no ${id}`);
  return node;
}

test('both buttons hold while an answer is out, and come back when it fails', async () => {
  const sent: string[] = [];
  let settle: (taken: boolean) => void = () => undefined;
  running = mount(PermissionCard, {
    target: document.body,
    props: {
      toolName: 'Bash',
      decision: null,
      request: null,
      answer: (decision: 'allow' | 'deny') => {
        sent.push(decision);
        return new Promise<boolean>((resolve) => { settle = resolve; });
      }
    }
  });
  flushSync();
  // Three taps before the card redraws: only the first one is sent.
  button('permission-allow').click();
  button('permission-allow').click();
  button('permission-deny').click();
  flushSync();
  expect(button('permission-allow').disabled).toBe(true);
  expect(button('permission-deny').disabled).toBe(true);
  expect(sent).toEqual(['allow']);
  settle(false);
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
  expect(button('permission-allow').disabled).toBe(false);
  button('permission-deny').click();
  expect(sent).toEqual(['allow', 'deny']);
});
