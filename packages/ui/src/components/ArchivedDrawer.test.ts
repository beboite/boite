import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { Project, ThreadSummary } from '@boite/contracts';
import ArchivedDrawer from './ArchivedDrawer.svelte';
import ArchivedProjects from './ArchivedProjects.svelte';
import ArchivedThreads from './ArchivedThreads.svelte';
import ContextMenu from './ContextMenu.svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { projectMenu } from '../lib/project-menu';
import { contextMenu } from '../lib/context-menu.svelte';

let running: Record<string, unknown> | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  contextMenu.close();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function ready() {
  const store = new Store(), client = new FakeClient({ delayMs: 0 });
  store.attach(client); await store.connect();
  cleanups.push(() => { store.detach(); client.close(); });
  return { store, client };
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test.each(['drawer', 'settings'] as const)('the mounted %s shows merged PR identity/time, reloads reason and restores the retained conversation', async surface => {
  const { store, client } = await ready();
  const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: account.id, title: 'Merged conversation', worktree: { branch: 'merged-ui-fixture' } });
  client.setMergedPrFixture(thread.id, { repository: 'github.com/example/repo', branch: thread.branch!, tip: 'a'.repeat(40), clean: true, candidates: [{ repository: 'github.com/example/repo', branch: thread.branch!, sha: 'a'.repeat(40), number: 7, url: 'https://github.com/example/repo/pull/7', mergedAt: '2026-10-01T12:00:00Z' }] });
  const draw = async () => {
    running = surface === 'drawer'
      ? mount(ArchivedDrawer, { target: document.body, props: { store, project: store.projects.find(project => project.id === 'p-boite')! } })
      : mount(ArchivedThreads, { target: document.body, props: { store, eager: true } });
    await settle();
    if (surface === 'drawer') { document.querySelector<HTMLButtonElement>('[data-testid=archived-drawer-toggle]')!.click(); await settle(); }
  };
  if (surface === 'settings') {
    await client.call('threads.archive', { threadId: 't-parser', archived: false });
    const calls = vi.spyOn(client, 'call');
    await draw();
    expect(document.querySelector('[data-testid=archived-empty]')).not.toBeNull();
    const loaded = calls.mock.calls.length;
    expect(await client.sweepMergedPrArchives()).toBe(1);
    await settle();
    expect(calls.mock.calls.slice(loaded).some(([method]) => method === 'threads.list')).toBe(false);
  } else {
    expect(await client.sweepMergedPrArchives()).toBe(1);
    await draw();
  }
  const row = () => document.querySelector<HTMLElement>(`[data-thread-id="${thread.id}"]`)!;
  expect(row()).not.toBeNull();
  const reason = row().querySelector<HTMLElement>('[data-testid=archive-merged-reason]')!;
  expect(reason.textContent).toContain('Archived after PR #7 merged');
  expect(reason.querySelector('a')?.getAttribute('href')).toBe('https://github.com/example/repo/pull/7');
  expect(reason.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
  expect(reason.querySelector('time')?.getAttribute('datetime')).toBe(new Date((await client.call('threads.get', { threadId: thread.id })).archiveReason!.archivedAt).toISOString());
  await unmount(running!, { outro: false }); running = null; document.body.innerHTML = '';
  await draw();
  expect(row().querySelector('[data-testid=archive-merged-reason]')).not.toBeNull();
  row().querySelector<HTMLButtonElement>(surface === 'drawer' ? '[data-testid=archived-drawer-restore]' : '[data-testid=archived-restore]')!.click();
  await settle();
  const restored = await client.call('threads.get', { threadId: thread.id });
  expect(restored.archived).toBe(false); expect(restored.archiveReason).toBeUndefined(); expect(restored.cwd).toBe(thread.cwd);
  expect(await client.sweepMergedPrArchives()).toBe(0);
  if (surface === 'drawer') expect(row()).toBeNull();
  else {
    expect(row().querySelector('[data-testid=archive-merged-reason]')).toBeNull();
    row().querySelector<HTMLButtonElement>('[data-testid=archived-open]')!.click(); await settle();
    expect(store.openThread?.id).toBe(thread.id);
    expect(store.openThread?.cwd).toBe(thread.cwd);
    await client.call('threads.archive', { threadId: thread.id, archived: true }); await settle();
    expect(row().querySelector('[data-testid=archived-restore]')).not.toBeNull();
    await client.call('threads.archive', { threadId: thread.id, archived: false }); await settle();
    expect(row()).toBeNull();
  }
});

test('a mounted settings archive reconciles a late sweep and removal ahead of its initial list response', async () => {
  const { store, client } = await ready();
  const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: account.id, title: 'Late merged conversation', worktree: { branch: 'late-archive-fixture' } });
  client.setMergedPrFixture(thread.id, { repository: 'github.com/example/repo', branch: thread.branch!, tip: 'b'.repeat(40), clean: true, candidates: [{ repository: 'github.com/example/repo', branch: thread.branch!, sha: 'b'.repeat(40), number: 8, url: 'https://github.com/example/repo/pull/8', mergedAt: '2026-10-01T13:00:00Z' }] });
  const started = deferred(), released = deferred(), call = client.call.bind(client);
  const calls = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const answer = await call(method, params);
    if (method === 'threads.list' && 'includeArchived' in params && params.includeArchived) { started.resolve(); await released.promise; }
    return answer;
  });
  running = mount(ArchivedThreads, { target: document.body, props: { store, eager: true } });
  flushSync(); await started.promise;
  try {
    expect(await client.sweepMergedPrArchives()).toBe(1);
    await client.call('threads.remove', { threadId: 't-parser' });
  } finally { released.resolve(); }
  await settle();
  expect([...document.querySelectorAll('[data-testid=archived-list] li')].map(row => row.getAttribute('data-thread-id'))).toEqual([thread.id]);
  expect(document.querySelector('[data-testid=archived-list] [data-testid=archive-merged-reason]')?.textContent).toContain('Archived after PR #8 merged');
  expect(calls.mock.calls.filter(([method, params]) => method === 'threads.list' && 'includeArchived' in params && params.includeArchived)).toHaveLength(1);
});

test('mounted policy menu keeps its owner during an awaited write and ignores a menu from a replaced client', async () => {
  const { store, client } = await ready();
  const replacement = new FakeClient({ delayMs: 0, coreId: 'replacement' });
  cleanups.push(() => replacement.close());
  running = mount(ContextMenu, { target: document.body }); await settle();
  const open = async () => {
    projectMenu(new MouseEvent('click'), store, store.projects.find(project => project.id === 'p-boite')!);
    await settle(); document.querySelector<HTMLButtonElement>('[data-value=manage]')!.click(); await settle();
  };
  store.projects = store.projects.map(project => project.id === 'p-boite' ? { ...project, autoArchiveMergedPr: undefined } : project);
  await open();
  expect(document.querySelector('[data-value=auto-archive-merged-pr]')).toBeNull();
  store.projects = await client.call('projects.list', {});
  const started = deferred(), released = deferred();
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const answer = await call(method, params);
    if (method === 'projects.setAutoArchiveMergedPr') { started.resolve(); await released.promise; }
    return answer;
  });
  await open();
  document.querySelector<HTMLButtonElement>('[data-value=auto-archive-merged-pr]')!.click(); await started.promise;
  store.attach(replacement); await store.connect();
  released.resolve(); await settle();
  expect(store.projects.find(project => project.id === 'p-boite')?.autoArchiveMergedPr).toBe(true);
  expect((await client.call('projects.list', {})).find(project => project.id === 'p-boite')?.autoArchiveMergedPr).toBe(false);
  await open();
  const stalePick = document.querySelector<HTMLButtonElement>('[data-value=auto-archive-merged-pr]')!;
  const restored = new FakeClient({ delayMs: 0, coreId: 'third-core' }); cleanups.push(() => restored.close());
  store.attach(restored); await store.connect();
  const spy = vi.spyOn(restored, 'call');
  stalePick.click(); await settle();
  expect(spy.mock.calls.some(([method]) => method === 'projects.setAutoArchiveMergedPr')).toBe(false);
  expect(store.error).toBeNull();
});

test.each(['drawer', 'settings'] as const)('an awaited mounted %s Restore never inserts its old conversation into a replacement machine', async surface => {
  const { store, client } = await ready();
  running = surface === 'drawer'
    ? mount(ArchivedDrawer, { target: document.body, props: { store, project: store.projects.find(project => project.id === 'p-boite')! } })
    : mount(ArchivedThreads, { target: document.body, props: { store, eager: true } });
  await settle();
  if (surface === 'drawer') { document.querySelector<HTMLButtonElement>('[data-testid=archived-drawer-toggle]')!.click(); await settle(); }
  const started = deferred(), released = deferred(), call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const answer = await call(method, params);
    if (method === 'threads.archive') { started.resolve(); await released.promise; }
    return answer;
  });
  document.querySelector<HTMLButtonElement>(`[data-thread-id=t-parser] [data-testid=${surface === 'drawer' ? 'archived-drawer-restore' : 'archived-restore'}]`)!.click(); await started.promise;
  const replacement = new FakeClient({ delayMs: 0, coreId: 'replacement' }); cleanups.push(() => replacement.close());
  store.attach(replacement); await store.connect();
  released.resolve(); await settle();
  expect(store.threads.some(thread => thread.id === 't-parser')).toBe(false);
  expect((await replacement.call('threads.get', { threadId: 't-parser' })).archived).toBe(true);
  if (surface === 'settings') {
    const title = document.querySelector('[data-testid=archived-list] [data-thread-id=t-parser] .title')!.textContent;
    await client.call('threads.archive', { threadId: 't-parser', archived: true });
    await client.call('threads.update', { threadId: 't-parser', title: 'Old machine archive' });
    await settle();
    expect(document.querySelector('[data-testid=archived-list] [data-thread-id=t-parser] .title')!.textContent).toBe(title);
  }
  expect(store.error).toBeNull();
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
  expect(document.querySelector('[data-testid=archived-projects] li')!.textContent).toContain('This machine');
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
        { machine: { id: 'local', label: 'Workstation', store: { archiveProject: localRestore } } as never, project: project({ archived: true }) },
        { machine: { id: 'remote', label: 'Build server', store: { archiveProject: remoteRestore } } as never, project: project({ archived: true }) }
      ],
      multi: true
    }
  });
  flushSync();
  document.querySelector<HTMLButtonElement>('[data-testid=archived-projects-toggle]')!.click();
  flushSync();
  const rows = document.querySelectorAll('[data-testid=archived-projects] li');
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain('Workstation');
  expect(rows[1]!.textContent).toContain('Build server');
  rows[1]!.querySelector<HTMLButtonElement>('button')!.click();
  expect(remoteRestore).toHaveBeenCalledWith('p-1', false);
  expect(localRestore).not.toHaveBeenCalled();
});
