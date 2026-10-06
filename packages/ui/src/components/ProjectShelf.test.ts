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
  projectThreadView.shelf = { idle: false, archived: false };
  contextMenu.close();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 4; i++) { await tick(); await Promise.resolve(); }
  flushSync();
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
    props: { kind: 'archived', entries: [{ machine: { id: 'local', label: 'This machine', store } as never, project: project({ archived: true }) }], multi: false, now: 0, onopen: onstart }
  });
  flushSync();
  const toggle = document.querySelector<HTMLButtonElement>('[data-testid=archived-projects-toggle]')!;
  expect(toggle.querySelector('.label')?.textContent).toBe('Archived projects');
  expect(toggle.querySelector('.fold-count')?.textContent).toBe('1');
  expect(document.querySelector('[data-testid=archived-project-restore]')).toBeNull();
  toggle.click();
  flushSync();
  expect(document.querySelector('[data-testid=archived-projects] .hint')?.textContent).toBe('Choose one to bring it back.');
  // One machine: no machine header, and a paired device gets no remove button.
  expect(document.querySelector('[data-testid=archived-projects-machine]')).toBeNull();
  expect(document.querySelector('[data-testid=archived-project-remove]')).toBeNull();

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
      entries: [
        { machine: { id: 'local', label: 'Workstation', store: { ...iconless, archiveProject: localRestore } } as never, project: project({ archived: true }) },
        { machine: { id: 'remote', label: 'Build server', store: { ...iconless, archiveProject: remoteRestore } } as never, project: project({ archived: true }) }
      ],
      multi: true,
      now: 0
    }
  });
  flushSync();
  click('[data-testid=archived-projects-toggle]');
  flushSync();
  const rows = document.querySelectorAll('[data-testid=archived-project]');
  expect([...document.querySelectorAll('[data-testid=archived-projects-machine]')].map(h => h.textContent?.trim())).toEqual(['Workstation', 'Build server']);
  expect([...rows].map(r => r.getAttribute('data-machine-id'))).toEqual(['local', 'remote']);
  click('[data-testid=archived-project-restore]', rows[1]!);
  await settle();
  expect(remoteRestore).toHaveBeenCalledWith('p-1', false);
  expect(localRestore).not.toHaveBeenCalled();
});

test('the owner removes an archived project only after confirming, on the owning machine', async () => {
  const { confirm } = await import('../lib/confirm.svelte');
  const removeProject = vi.fn(async () => {});
  const machine = { id: 'local', label: 'Workstation', store: { ...iconless, owner: true, archiveProject: vi.fn(), removeProject } };
  running = mount(ProjectShelf, {
    target: document.body,
    props: { kind: 'archived', entries: [{ machine: machine as never, project: project({ archived: true }) }], multi: false, now: 0 }
  });
  flushSync();
  click('[data-testid=archived-projects-toggle]');
  flushSync();

  const refuse = vi.spyOn(confirm, 'ask').mockResolvedValueOnce(false);
  click('[data-testid=archived-project-remove]');
  await settle();
  expect(refuse).toHaveBeenCalledWith(expect.objectContaining({ title: 'Remove boite from Boite?', danger: true }));
  expect(removeProject).not.toHaveBeenCalled();

  vi.spyOn(confirm, 'ask').mockResolvedValueOnce(true);
  click('[data-testid=archived-project-remove]');
  await settle();
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
      kind: 'idle',
      entries: [
        { machine: { id: 'local', label: 'Workstation', store: local } as never, project: project() },
        { machine: { id: 'remote', label: 'Build server', store: remote } as never, project: project() }
      ],
      multi: true,
      now: 0,
      onopen: onstart
    }
  });
  flushSync();
  const toggle = document.querySelector<HTMLButtonElement>('[data-testid=idle-projects-toggle]')!;
  expect(toggle.querySelector('.label')?.textContent).toBe('Idle projects');
  toggle.click();
  flushSync();
  expect(projectThreadView.shelf.idle).toBe(true);
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
    props: { kind: 'idle', entries: [{ machine: { id: 'local', label: 'Workstation', store: { ...iconless, projects: [] } } as never, project: project({ missing: true }) }], multi: false, now: 0 }
  });
  flushSync();
  click('[data-testid=idle-projects-toggle]');
  flushSync();
  click('[data-testid=idle-project-open]');
  await settle();
  expect(open).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
});
