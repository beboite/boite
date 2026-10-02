import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { ToolPart } from '../lib/tool-groups';
import ToolGroup from './ToolGroup.svelte';

let component: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (component) unmount(component, { outro: false });
  component = null;
  document.body.innerHTML = '';
});

test('a folded run counts every failed or denied call even after a success', () => {
  const parts: ToolPart[] = ['error', 'denied', 'done'].map((status, index) => ({
    type: 'tool', toolId: String(index), name: 'Bash', input: { command: 'git status' },
    output: 'command output', status: status as ToolPart['status'], exitCode: index === 0 ? 2 : null
  }));
  component = mount(ToolGroup, { target: document.body, props: { parts, isBackground: () => false } });
  flushSync();
  const toggle = document.querySelector<HTMLButtonElement>('[data-testid=tool-group-toggle]')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-label')).toContain('2 unsuccessful calls');
  expect(document.querySelector('[data-testid=tool-group-issues]')?.textContent).toBe('2');
  expect(document.querySelector('[data-testid=tool-output]')).toBeNull();
  toggle.click();
  flushSync();
  expect(document.querySelectorAll('[data-testid=tool-card]')).toHaveLength(3);
  expect(document.querySelector('[data-testid=tool-exit-code]')?.textContent).toBe('Exit code 2');
  document.querySelector<HTMLButtonElement>('[data-testid=tool-toggle]')!.click();
  flushSync();
  expect(document.querySelector('[data-testid=tool-output]')?.textContent).toBe('command output');
});
