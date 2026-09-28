import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { Project, ThreadSummary } from '@boite/contracts';
import ArchivedDrawer from './ArchivedDrawer.svelte';
import ArchivedProjects from './ArchivedProjects.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 4; i++) { await tick(); await Promise.resolve(); }
  flushSync();
}

const project = (extra: Partial<Project> = {}): Project => ({ id: 'p-1', name: 'boite', path: '/w/boite', createdAt: 0, ...extra });
const archived = (id: string, title: string) => ({ id, title, projectId: 'p-1', archived: true, updatedAt: 0 }) as ThreadSummary;

test('a project with no archived thread has no drawer', () => {
  running = mount(ArchivedDrawer, { target: document.body, props: { store: { connection: 'ready' } as never, project: project() } });
  flushSync();
  expect(document.querySelector('[data-testid=archived-drawer]')).toBeNull();
});

test('the drawer reads the project\'s archived threads on opening, and a restore takes the row out', async () => {
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'threads.list') return [archived('t-1', 'Parser'), archived('t-2', 'Old spike'), { ...archived('t-3', 'Child'), parentThreadId: 't-1' }];
    return { ...archived(String(params.threadId), 'Parser'), archived: false };
  });
  const store = { connection: 'ready', error: null, client: { call }, threads: [] as ThreadSummary[] };
  running = mount(ArchivedDrawer, { target: document.body, props: { store: store as never, project: project({ archivedThreads: 2 }) } });
  flushSync();
  const toggle = document.querySelector<HTMLButtonElement>('[data-testid=archived-drawer-toggle]')!;
  expect(toggle.textContent).toContain('2 archived');
  // Folded, nothing is read.
  expect(call).not.toHaveBeenCalled();

  toggle.click();
  await settle();
  expect(call).toHaveBeenCalledWith('threads.list', { projectId: 'p-1', includeArchived: true });
  expect([...document.querySelectorAll('[data-testid=archived-drawer] li')].map((li) => li.getAttribute('data-thread-id'))).toEqual(['t-1', 't-2']);

  document.querySelector<HTMLButtonElement>('[data-thread-id=t-1] button')!.click();
  await settle();
  expect(call).toHaveBeenCalledWith('threads.archive', { threadId: 't-1', archived: false });
  expect(store.threads.map((t) => t.id)).toEqual(['t-1']);
  expect(document.querySelector('[data-thread-id=t-1]')).toBeNull();
});

test('the archived projects fold lists them and restores one in one click', () => {
  const archiveProject = vi.fn(async () => true);
  const machine = { id: 'local', label: 'This machine', store: { archiveProject } };
  running = mount(ArchivedProjects, {
    target: document.body,
    props: { entries: [{ machine: machine as never, project: project({ archived: true }) }], multi: false }
  });
  flushSync();
  const toggle = document.querySelector<HTMLButtonElement>('[data-testid=archived-projects-toggle]')!;
  expect(toggle.textContent).toContain('Archived projects (1)');
  expect(document.querySelector('[data-testid=archived-project-restore]')).toBeNull();
  toggle.click();
  flushSync();
  document.querySelector<HTMLButtonElement>('[data-testid=archived-project-restore]')!.click();
  expect(archiveProject).toHaveBeenCalledWith('p-1', false);
});
