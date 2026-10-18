import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PermissionCard from './PermissionCard.svelte';
import { parts } from '../lib/deferred-parts';

let running: Record<string, unknown> | null = null;
let landed: typeof parts.DiffView.current;

afterEach(() => {
  parts.DiffView.current = landed;
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

test('an edit is not allowed before its diff shows, and can still be denied', () => {
  // The setup loaded the diff's chunk; this card draws before it has landed.
  landed = parts.DiffView.current;
  expect(landed).toBeDefined();
  parts.DiffView.current = undefined;
  const sent: string[] = [];
  running = mount(PermissionCard, {
    target: document.body,
    props: {
      toolName: 'Edit',
      decision: null,
      request: {
        id: 'r1', threadId: 't1', turnId: 'u1', toolName: 'Edit', description: null, createdAt: '2026-10-18T00:00:00.000Z',
        input: { file_path: 'src/a.ts', old_string: 'one', new_string: 'two' }
      } as never,
      answer: (decision: 'allow' | 'deny') => { sent.push(decision); return true; }
    }
  });
  flushSync();
  const allow = document.querySelector<HTMLButtonElement>('[data-testid=permission-allow]')!;
  const deny = document.querySelector<HTMLButtonElement>('[data-testid=permission-deny]')!;
  expect(document.querySelector('[data-testid=deferred-loading]')).not.toBeNull();
  expect(allow.disabled).toBe(true);
  allow.click();
  expect(sent).toEqual([]);
  expect(deny.disabled).toBe(false);

  // The diff lands: the change shows, and only then can it be allowed.
  parts.DiffView.current = landed;
  flushSync();
  expect(document.querySelector('[data-testid=deferred-loading]')).toBeNull();
  expect(allow.disabled).toBe(false);
  deny.click();
  expect(sent).toEqual(['deny']);
});
