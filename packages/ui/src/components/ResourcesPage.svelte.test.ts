import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { ThreadResources } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import ResourcesPage from './ResourcesPage.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const running: ThreadResources = {
  threadId: 't-run', title: 'Builds the app', status: 'running',
  live: [{ pid: 4100, parentPid: null, threadId: 't-run', exe: 'C:\\tools\\cargo.exe', commandLine: null, startedAt: Date.now() - 65_000, exitedAt: null, exitCode: null, cpuMs: null, peakMemoryBytes: null, ioBytes: null }],
  load: { processes: 1, cpuPercent: 41.6, memoryBytes: 512 * 1024 * 1024 },
};

test('the task list reads itself again while the page is open, and stops once it closes', async () => {
  vi.useFakeTimers();
  const store = $state({ connection: 'ready', settings: null, resources: [] as ThreadResources[], refreshResources: vi.fn(async () => { store.resources = [running]; }) });
  mounted = mount(ResourcesPage, { target: document.body, props: { store: store as unknown as Store } });
  await settle();
  expect(document.querySelector('[data-testid="resources-empty"]')).not.toBeNull();
  expect(store.refreshResources).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(2000);
  await settle();
  expect(store.refreshResources).toHaveBeenCalledTimes(1);
  const row = document.querySelector('[data-testid="resource-row"]')!;
  expect(row.querySelector('[data-testid="resource-load"]')!.textContent).toContain('42 %');
  expect(row.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(document.body.textContent).not.toContain('Refresh');

  await vi.advanceTimersByTimeAsync(2000);
  expect(store.refreshResources).toHaveBeenCalledTimes(2);
  await unmount(mounted);
  mounted = undefined;
  await vi.advanceTimersByTimeAsync(6000);
  expect(store.refreshResources).toHaveBeenCalledTimes(2);
});
