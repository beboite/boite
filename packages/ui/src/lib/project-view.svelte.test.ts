import { afterEach, expect, test } from 'vitest';
import { ProjectView } from './project-view.svelte';
import type { ProjectEntry } from './project-view.svelte';
import { Store } from './store.svelte';
import { FakeClient } from './fake-client';

afterEach(() => localStorage.clear());

test('a saved order and filter survive a local core restarting on a different port', async () => {
  const store = new Store();
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
  store.core = { ...store.core!, hostname: 'workstation' };
  const machine = { id: 'http://localhost:7337', label: 'This PC', store };
  const entries: ProjectEntry[] = store.projects.map(project => ({ machine, project }));
  const view = new ProjectView();
  view.toggle(entries);
  const [first, second] = view.keys;
  view.pick(second!);
  view.move(entries, second!, first!);
  const expected = view.sorted(entries).map(e => e.project.id);
  const selected = view.selected(entries)?.project.id;

  machine.id = 'http://localhost:8448';
  const restored = new ProjectView();
  expect(restored.sorted(entries).map(e => e.project.id)).toEqual(expected);
  expect(restored.selected(entries)?.project.id).toBe(selected);
  store.detach();
});
