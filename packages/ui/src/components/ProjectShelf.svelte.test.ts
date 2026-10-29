import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { projectThreadView } from '../lib/project-threads.svelte';
import type { ProjectEntry } from '../lib/project-view.svelte';
import ProjectShelf from './ProjectShelf.svelte';

let mounted: ReturnType<typeof mount> | undefined;
let store: Store | undefined;
const settle = async () => {
  await import('./ProjectShelfRows.svelte');
  await import('./DoneThread.svelte');
  for (let i = 0; i < 30; i++) { await Promise.resolve(); flushSync(); }
};
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  projectThreadView.shelfOpen = false;
  store?.client?.close(); store?.detach(); store = undefined;
  localStorage.clear();
});

test('history rows an idle project reported leave Alt+digit once the fold empties', async () => {
  const client = new FakeClient({ delayMs: 0 });
  store = new Store(); store.attach(client); await store.connect();
  await store.archive('t-trace', true);
  const entry: ProjectEntry = { machine: { id: 'local', label: 'local', store } as never, project: store.projects.find(project => project.id === 'p-boite')! };
  const onrows = vi.fn();
  const props = $state({ projects: [entry], multi: false, now: Date.now(), onrows });
  mounted = mount(ProjectShelf, { target: document.body, props });
  projectThreadView.shelfOpen = true;
  await settle();
  projectThreadView.toggle(entry, 'done');
  await settle();
  expect(onrows).toHaveBeenLastCalledWith([{ store, threadId: 't-trace' }]);
  // The project leaves the fold, the fold's rows go with it, and so does what they lent Alt+digit.
  props.projects = [];
  await settle();
  expect(onrows).toHaveBeenLastCalledWith([]);
  projectThreadView.toggle(entry, 'done');
});
