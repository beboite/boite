import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { Project } from '@boite/contracts';
import ProjectShelf from './ProjectShelf.svelte';
import { contextMenu } from '../lib/context-menu.svelte';
import { projectThreadView } from '../lib/project-threads.svelte';
import { undo } from '../lib/undo.svelte';
import { workspace } from '../lib/workspace.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  projectThreadView.shelfOpen = false;
  projectThreadView.archivedShelfOpen = false;
  contextMenu.close();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 4; i++) { await tick(); await Promise.resolve(); }
  flushSync();
}
/** The fold's rows load on their own at its first opening: once loaded here, the fold's own import resolves within a settle. */
async function unfold(toggle = document.querySelector<HTMLButtonElement>('[data-testid=project-shelf-toggle], [data-testid=archived-shelf-toggle]')!) {
  toggle.click();
  await import('./ProjectShelfRows.svelte');
  await settle();
}

const project = (extra: Partial<Project> = {}): Project => ({ id: 'p-1', name: 'boite', path: '/w/boite', createdAt: 0, ...extra });
const iconless = { projectIconUrl: () => null, loadProjectIcon: async () => {} };
const click = (selector: string, within: ParentNode = document) => within.querySelector<HTMLButtonElement>(selector)!.click();

test('the archived fold restores a project alone from its button, or restores it and starts a thread when the row is chosen', async () => {
  const select = vi.spyOn(workspace, 'select').mockResolvedValue();
  const archiveProject = vi.fn(async () => true);
  const onstart = vi.fn();
  const store = { ...iconless, archiveProject };
  running = mount(ProjectShelf, {
    target: document.body,
    props: { kind: 'archived', projects: [{ machine: { id: 'local', label: 'This machine', store } as never, project: project({ archived: true }) }], multi: false, now: 0, onopen: onstart }
  });
  flushSync();
  const toggle = document.querySelector<HTMLButtonElement>('[data-testid=archived-shelf-toggle]')!;
  expect(toggle.querySelector('.label')?.textContent).toBe('Archived projects');
  expect(toggle.querySelector('.fold-count')?.textContent).toBe('1');
  expect(document.querySelector('[data-testid=archived-project-restore]')).toBeNull();
  await unfold(toggle);
  // One machine: no machine header.
  expect(document.querySelector('[data-testid=project-shelf-machine]')).toBeNull();

  click('[data-testid=archived-project-restore]');
  await settle();
  expect(archiveProject).toHaveBeenCalledWith('p-1', false);
  expect(select).not.toHaveBeenCalled();

  click('[data-testid=archived-project-open]');
  await settle();
  expect(archiveProject).toHaveBeenCalledTimes(2);
  expect(select).toHaveBeenCalledWith(store, undefined, 'p-1');
  expect(onstart).toHaveBeenCalledOnce();
});

test('archived projects with matching ids show their machines and restore on the owning machine', async () => {
  const localRestore = vi.fn(async () => true);
  const remoteRestore = vi.fn(async () => true);
  running = mount(ProjectShelf, {
    target: document.body,
    props: {
      kind: 'archived',
      projects: [
        { machine: { id: 'local', label: 'Workstation', store: { ...iconless, archiveProject: localRestore } } as never, project: project({ archived: true }) },
        { machine: { id: 'remote', label: 'Build server', store: { ...iconless, archiveProject: remoteRestore } } as never, project: project({ archived: true }) }
      ],
      multi: true,
      now: 0
    }
  });
  flushSync();
  await unfold();
  const rows = document.querySelectorAll('[data-testid=archived-project]');
  expect([...document.querySelectorAll('[data-testid=project-shelf-machine]')].map(h => h.textContent?.trim())).toEqual(['Workstation', 'Build server']);
  expect([...rows].map(r => r.getAttribute('data-machine-id'))).toEqual(['local', 'remote']);
  click('[data-testid=archived-project-restore]', rows[1]!);
  await settle();
  expect(remoteRestore).toHaveBeenCalledWith('p-1', false);
  expect(localRestore).not.toHaveBeenCalled();
});

test('an archived row offers only its restore under the pointer; the owner removes it from the menu, after confirming', async () => {
  const { confirm } = await import('../lib/confirm.svelte');
  const removeProject = vi.fn(async () => {});
  const machine = { id: 'local', label: 'Workstation', store: { ...iconless, owner: true, projects: [], archiveProject: vi.fn(), removeProject } };
  running = mount(ProjectShelf, {
    target: document.body,
    props: { kind: 'archived', projects: [{ machine: machine as never, project: project({ archived: true }) }], multi: false, now: 0 }
  });
  flushSync();
  await unfold();

  // The hover shows the row's one quick action: a delete beside it would land under a pointer reaching for it.
  const row = document.querySelector<HTMLElement>('[data-testid=archived-project]')!;
  expect([...row.querySelectorAll<HTMLElement>('.actions button')].map(b => b.dataset.testid)).toEqual(['archived-project-restore']);

  const remove = async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    for (const id of ['manage', 'remove']) {
      expect(contextMenu.current?.items.some(item => 'id' in item && item.id === id)).toBe(true);
      contextMenu.current!.onpick(id);
      await settle();
    }
  };
  const refuse = vi.spyOn(confirm, 'ask').mockResolvedValueOnce(false);
  await remove();
  expect(refuse).toHaveBeenCalledWith(expect.objectContaining({ title: 'Remove boite from Boite?', danger: true }));
  expect(removeProject).not.toHaveBeenCalled();

  vi.spyOn(confirm, 'ask').mockResolvedValueOnce(true);
  await remove();
  expect(removeProject).toHaveBeenCalledWith('p-1');
});

test('an idle project starts a thread on its own machine when chosen, and archives from its row with an undo', async () => {
  const select = vi.spyOn(workspace, 'select').mockResolvedValue();
  const offer = vi.spyOn(undo, 'offer').mockImplementation(() => {});
  const onstart = vi.fn();
  const local = { ...iconless, projects: [project()], archiveProject: vi.fn(async () => true) };
  const remote = { ...iconless, projects: [project()], archiveProject: vi.fn(async () => true) };
  running = mount(ProjectShelf, {
    target: document.body,
    props: {
      projects: [
        { machine: { id: 'local', label: 'Workstation', store: local } as never, project: project() },
        { machine: { id: 'remote', label: 'Build server', store: remote } as never, project: project() }
      ],
      multi: true,
      now: 0,
      onopen: onstart
    }
  });
  flushSync();
  const toggle = document.querySelector<HTMLButtonElement>('[data-testid=project-shelf-toggle]')!;
  expect(toggle.querySelector('.label')?.textContent).toBe('Idle projects');
  await unfold(toggle);
  expect(projectThreadView.shelfOpen).toBe(true);
  const rows = document.querySelectorAll('[data-testid=idle-project]');
  // An idle row takes a dragged thread like a project section does; an archived one never does.
  expect(rows[0]!.hasAttribute('data-thread-drop')).toBe(true);

  click('[data-testid=idle-project-open]', rows[1]!);
  await settle();
  expect(select).toHaveBeenCalledWith(remote, undefined, 'p-1');
  expect(onstart).toHaveBeenCalledOnce();

  click('[data-testid=idle-project-archive]', rows[0]!);
  await settle();
  expect(local.archiveProject).toHaveBeenCalledWith('p-1', true);
  expect(remote.archiveProject).not.toHaveBeenCalled();
  expect(offer).toHaveBeenCalledWith('Archived boite', expect.any(Function));
});

test('an idle project whose folder is gone opens its menu instead of starting a thread', async () => {
  const select = vi.spyOn(workspace, 'select').mockResolvedValue();
  const open = vi.spyOn(contextMenu, 'open').mockImplementation(() => {});
  running = mount(ProjectShelf, {
    target: document.body,
    props: { projects: [{ machine: { id: 'local', label: 'Workstation', store: { ...iconless, projects: [] } } as never, project: project({ missing: true }) }], multi: false, now: 0 }
  });
  flushSync();
  await unfold();
  click('[data-testid=idle-project-open]');
  await settle();
  expect(open).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
});

test('idle and archived projects sit in two folds, each by name, the archived one closed on its own', async () => {
  const store = { ...iconless, projects: [], owner: true, archiveProject: vi.fn(async () => true) };
  const machine = { id: 'local', label: 'Workstation', store } as never;
  const idle = mount(ProjectShelf, {
    target: document.body,
    props: { projects: [{ machine, project: project({ id: 'p-zeta', name: 'zeta' }) }, { machine, project: project({ id: 'p-alpha', name: 'alpha' }) }], multi: false, now: 0 }
  });
  running = mount(ProjectShelf, {
    target: document.body,
    props: { kind: 'archived', projects: [{ machine, project: project({ id: 'p-old', name: 'aardvark', archived: true }) }], multi: false, now: 0 }
  });
  try {
    flushSync();
    const toggles = [...document.querySelectorAll<HTMLButtonElement>('.fold-header')];
    expect(toggles.map(toggle => [toggle.dataset.testid, toggle.querySelector('.label')?.textContent, toggle.querySelector('.fold-count')?.textContent]))
      .toEqual([['project-shelf-toggle', 'Idle projects', '2'], ['archived-shelf-toggle', 'Archived projects', '1']]);
    // The idle fold says what it holds under the pointer: nothing to do there.
    expect(toggles[0]!.title).toContain('Nothing to do');
    await unfold(toggles[0]);
    expect(projectThreadView.archivedShelfOpen).toBe(false);
    expect([...document.querySelectorAll<HTMLElement>('[data-testid=project-shelf] li')].map(row => row.dataset.projectName)).toEqual(['alpha', 'zeta']);
    expect(document.querySelector('[data-testid=archived-shelf] li')).toBeNull();
    await unfold(toggles[1]);
    const archived = [...document.querySelectorAll<HTMLElement>('[data-testid=archived-shelf] li')];
    expect(archived.map(row => [row.dataset.projectName, row.dataset.testid])).toEqual([['aardvark', 'archived-project']]);
    // No menu button on a row: its menu is a right click or a long press away.
    expect(document.querySelector('[data-testid=idle-project-menu]')).toBeNull();
    const open = vi.spyOn(contextMenu, 'open').mockImplementation(() => {});
    archived[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledOnce();
  } finally { unmount(idle, { outro: false }); }
});
