import { afterEach, expect, test } from 'vitest';
import { ProjectView } from './project-view.svelte';
import type { ProjectEntry } from './project-view.svelte';
import { Store } from './store.svelte';
import { FakeClient } from './fake-client';
import { test as storeTest } from '../test/fake-client';

afterEach(() => localStorage.clear());

storeTest('removing the newest thread ranks a project by its surviving conversations, including imported history', async ({ store }) => {
  const machine = { id: 'local', label: 'This PC', store };
  const entries: ProjectEntry[] = store.projects.map(project => ({ machine, project: { ...project, createdAt: 1000 } }));
  const base = store.threads[0]!;
  store.threads = [
    { ...base, id: 'old', projectId: 'p-boite', lastUserMessageAt: 100, createdAt: 50 },
    { ...base, id: 'new', projectId: 'p-boite', lastUserMessageAt: 2000, createdAt: 1500 },
    { ...base, id: 'other', projectId: 'p-notes', lastUserMessageAt: 500, createdAt: 200 }
  ];
  const view = new ProjectView();
  expect(view.sorted(entries).map(entry => entry.project.id)).toEqual(['p-boite', 'p-notes']);
  store.threads = store.threads.filter(thread => thread.id !== 'new');
  expect(view.sorted(entries).map(entry => entry.project.id)).toEqual(['p-notes', 'p-boite']);
  const old = store.threads[0]!;
  store.threads = store.threads.filter(thread => thread.id !== 'old');
  expect(view.sorted(entries).map(entry => entry.project.id)).toEqual(['p-notes', 'p-boite']);
  store.threads.push(old);
  view.toggle(entries);
  store.threads.find(thread => thread.id === 'old')!.lastUserMessageAt = 3000;
  expect(view.sorted(entries).map(entry => entry.project.id)).toEqual(['p-notes', 'p-boite']);
});

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
