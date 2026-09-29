import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { BrowserStatus, BrowserTask } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import BrowserPlugin from './BrowserPlugin.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(() => { if (mounted) unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

test('a task arriving while status loads stays visible and cancellable', async () => {
  let receive!: (task: BrowserTask) => void;
  let respond!: (status: BrowserStatus) => void;
  const initial = new Promise<BrowserStatus>(resolve => { respond = resolve; });
  const client = { on: (_event: string, listener: typeof receive) => { receive = listener; return () => {}; }, call: () => initial };
  mounted = mount(BrowserPlugin, { target: document.body, props: { store: { client } as unknown as Store, pluginId: 'jev-browser' } });
  flushSync();
  await vi.waitFor(() => expect(receive).toBeTypeOf('function'));
  const task: BrowserTask = { id: 'early', threadId: 't1', pluginId: 'jev-browser', goal: 'Save weekly notifications', status: 'running', step: 1, maxSteps: 20, startedAt: 1, finishedAt: null, url: 'https://example.org/', message: 'Checking the page', inputTokens: 12 };
  receive(task);
  receive({ ...task, step: 2 });
  respond({ config: { enabled: true, executablePath: null }, keyAvailable: true, tasks: [] });
  await vi.waitFor(() => expect(document.querySelector('[data-testid="browser-task"]')?.textContent).toContain(task.goal));
  expect(document.querySelectorAll('[data-testid="browser-task"]')).toHaveLength(1);
  expect(document.querySelector('[data-testid="browser-task"]')?.textContent).toContain('Step 2 of 20');
  expect(document.querySelector('[data-testid="browser-cancel"]')).not.toBeNull();
});
