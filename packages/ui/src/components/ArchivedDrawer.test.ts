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
const iconless = { projectIconUrl: () => null, loadProjectIcon: async () => {} };
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
  expect(toggle.textContent).toContain('Archived conversations (2)');
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
  const machine = { id: 'local', label: 'This machine', store: { ...iconless, archiveProject } };
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
  // One machine: no machine header, and a paired device gets no remove button.
  expect(document.querySelector('[data-testid=archived-projects-machine]')).toBeNull();
  expect(document.querySelector('[data-testid=archived-project-remove]')).toBeNull();
  document.querySelector<HTMLButtonElement>('[data-testid=archived-project-restore]')!.click();
  expect(archiveProject).toHaveBeenCalledWith('p-1', false);
});

test('archived projects with matching ids show their machines and restore on the owning machine', () => {
  const localRestore = vi.fn(async () => true);
  const remoteRestore = vi.fn(async () => true);
  running = mount(ArchivedProjects, {
    target: document.body,
    props: {
      entries: [
        { machine: { id: 'local', label: 'Workstation', store: { ...iconless, archiveProject: localRestore } } as never, project: project({ archived: true }) },
        { machine: { id: 'remote', label: 'Build server', store: { ...iconless, archiveProject: remoteRestore } } as never, project: project({ archived: true }) }
      ],
      multi: true
    }
  });
  flushSync();
  document.querySelector<HTMLButtonElement>('[data-testid=archived-projects-toggle]')!.click();
  flushSync();
  const rows = document.querySelectorAll('[data-testid=archived-projects] li');
  expect(rows).toHaveLength(2);
  expect([...document.querySelectorAll('[data-testid=archived-projects-machine]')].map(h => h.textContent?.trim())).toEqual(['Workstation', 'Build server']);
  expect([...rows].map(r => r.getAttribute('data-machine-id'))).toEqual(['local', 'remote']);
  rows[1]!.querySelector<HTMLButtonElement>('button')!.click();
  expect(remoteRestore).toHaveBeenCalledWith('p-1', false);
  expect(localRestore).not.toHaveBeenCalled();
});

test('the owner removes an archived project only after confirming, on the owning machine', async () => {
  const { confirm } = await import('../lib/confirm.svelte');
  const removeProject = vi.fn(async () => {});
  const machine = { id: 'local', label: 'Workstation', store: { ...iconless, owner: true, archiveProject: vi.fn(), removeProject } };
  running = mount(ArchivedProjects, {
    target: document.body,
    props: { entries: [{ machine: machine as never, project: project({ archived: true }) }], multi: false }
  });
  flushSync();
  document.querySelector<HTMLButtonElement>('[data-testid=archived-projects-toggle]')!.click();
  flushSync();
  const remove = document.querySelector<HTMLButtonElement>('[data-testid=archived-project-remove]')!;

  const refuse = vi.spyOn(confirm, 'ask').mockResolvedValueOnce(false);
  remove.click();
  await settle();
  expect(refuse).toHaveBeenCalledWith(expect.objectContaining({ title: 'Remove boite from Boite?', danger: true }));
  expect(removeProject).not.toHaveBeenCalled();

  vi.spyOn(confirm, 'ask').mockResolvedValueOnce(true);
  remove.click();
  await settle();
  expect(removeProject).toHaveBeenCalledWith('p-1');
});
