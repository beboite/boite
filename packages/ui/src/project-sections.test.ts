import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import type { Project, ThreadSummary } from '@boite/contracts';
import App from './App.svelte';
import { store } from './lib/store.svelte';
import { workspace } from './lib/workspace.svelte';
import { writeExperiments } from './lib/experiments';
import { closeTour } from './lib/onboarding.svelte';
import { work } from './lib/work-prefs.svelte';
import { projectThreadView, projectSections } from './lib/project-threads.svelte';
import { recentPreferences } from './lib/recent.svelte';
import type { ProjectEntry } from './lib/project-view.svelte';

/*
 * The Projects view in sections, over the in-memory fake: projects whose every
 * conversation is at work on top once working grouping is on, the open ones, the ones whose work was set
 * aside, then the idle fold. A project moves between them as its threads do.
 */

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

let running: Record<string, unknown> | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  writeExperiments([]);
  window.localStorage.clear();
  recentPreferences.groupWorking = false;
  work.load();
  workspace.view = 'projects';
  projectThreadView.shelfOpen = false;
  projectThreadView.workingOpen = true;
  projectThreadView.laterOpen = true;
});

async function waitFor(check: () => boolean, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`gave up waiting, body was:\n${document.body.textContent ?? ''}`);
}

async function mountOnFake(): Promise<void> {
  window.history.replaceState(null, '', '/?fake=1&open=recent');
  const target = document.createElement('div');
  document.body.appendChild(target);
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.page = 'chat';
  store.composerStates = {};
  store.projectPickerOpen = false;
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && (store.openThread !== null || store.draft !== null));
  workspace.view = 'projects';
  await waitFor(() => document.querySelectorAll('section[data-testid=project]').length === 2);
}

async function project(name: string): Promise<Project> {
  return store.client!.call('projects.add', { path: `/workspace/${name}`, name });
}
async function thread(projectId: string, title: string): Promise<ThreadSummary> {
  const created = await store.client!.call('threads.create', { projectId, providerId: 'echo', accountId: 'a-echo', title });
  await waitFor(() => store.threads.some((t) => t.id === created.id));
  return created;
}
function setThread(id: string, change: Partial<ThreadSummary>): void {
  store.threads = store.threads.map((t) => (t.id === id ? { ...t, ...change } : t));
}
const card = (within: string, projectId: string) => document.querySelector<HTMLElement>(`${within} section[data-testid=project][data-project-id="${projectId}"]`);
const cards = () => [...document.querySelectorAll<HTMLElement>('[data-testid=sidebar] section[data-testid=project]')].map((s) => s.dataset['projectId']);

test('with working grouping on, a project whose every conversation is at work sits on top, and moves down once one needs the user', async () => {
  await mountOnFake();
  const busy = await project('busy');
  const build = await thread(busy.id, 'Long build');
  const tests = await thread(busy.id, 'Test sweep');
  setThread(build.id, { status: 'running' });
  setThread(tests.id, { status: 'running' });
  // Off by default: the project at work stays among the open cards, with no section above them.
  await waitFor(() => card('[data-testid=sidebar]', busy.id) !== null);
  expect(document.querySelector('[data-testid=working-projects]')).toBeNull();
  recentPreferences.setGroupWorking(true);
  await waitFor(() => card('[data-testid=working-projects]', busy.id) !== null);
  // On top of every open project, under the section's own header.
  expect(cards()[0]).toBe(busy.id);
  expect(document.querySelector('[data-testid=working-projects-toggle]')?.textContent).toContain('Working');
  expect(card('[data-testid=working-projects]', 'p-boite')).toBeNull();

  // A pin is the user's: the project with it stays among the open ones, at work or not.
  setThread(tests.id, { pinned: true });
  await waitFor(() => document.querySelector('[data-testid=working-projects]') === null);
  setThread(tests.id, { pinned: false });
  await waitFor(() => card('[data-testid=working-projects]', busy.id) !== null);

  // One turn ends and waits to be read: the project leaves the section, which goes with its last project.
  setThread(build.id, { status: 'idle', unread: true });
  await waitFor(() => document.querySelector('[data-testid=working-projects]') === null);
  expect(cards()).toContain(busy.id);

  // Folded, the section keeps its header and count, and its fold closes.
  setThread(build.id, { status: 'running', unread: false });
  await waitFor(() => card('[data-testid=working-projects]', busy.id) !== null);
  document.querySelector<HTMLButtonElement>('[data-testid=working-projects-toggle]')!.click();
  await waitFor(() => document.querySelector('[data-testid=working-projects] .disclosure-fold')?.classList.contains('open') === false);
  const toggle = document.querySelector<HTMLElement>('[data-testid=working-projects-toggle]')!;
  expect([toggle.getAttribute('aria-expanded'), toggle.querySelector('.fold-count')?.textContent]).toEqual(['false', '1']);
});

test('a project whose only conversations were archived by hand shows them under Set aside; one with only done history goes to the idle fold', async () => {
  await mountOnFake();
  const paused = await project('paused');
  const finished = await project('finished');
  const later = await thread(paused.id, 'Pick this up');
  const shipped = await thread(finished.id, 'Shipped');
  await store.archive(later.id);
  await store.archive(shipped.id, true);

  // The set-aside conversation is the card's body, drawn without a click, and reads like an open row.
  const row = `[data-testid=later-projects] section[data-project-id="${paused.id}"] [data-testid=done-thread][data-thread-id="${later.id}"]`;
  await waitFor(() => document.querySelector(row) !== null);
  expect(document.querySelector(row)!.classList.contains('pending')).toBe(true);
  // Its rows say the count, so no pill repeats it while the card is open.
  const pill = `[data-testid=later-projects] section[data-project-id="${paused.id}"] [data-testid=project-archived-toggle]`;
  expect(document.querySelector(pill)).toBeNull();
  // Folded, the pill stands in for the rows and opens the card again.
  document.querySelector<HTMLButtonElement>(`[data-testid=later-projects] section[data-project-id="${paused.id}"] [data-testid=project-row]`)!.click();
  await waitFor(() => document.querySelector(pill) !== null);
  expect(document.querySelector(pill)!.getAttribute('data-count')).toBe('1');
  document.querySelector<HTMLButtonElement>(pill)!.click();
  await waitFor(() => document.querySelector(pill) === null && document.querySelector(row) !== null);

  // Nothing left to do there: the idle fold, never a card.
  expect(card('[data-testid=sidebar]', finished.id)).toBeNull();
  projectThreadView.shelfOpen = true;
  await waitFor(() => document.querySelector(`[data-testid=project-shelf] [data-testid=idle-project][data-project-id="${finished.id}"]`) !== null);
  expect(document.querySelector(`[data-testid=project-shelf] [data-project-id="${paused.id}"]`)).toBeNull();

  // Restored, the conversation is open again: the project joins the open cards and Set aside empties.
  await store.client!.call('threads.archive', { threadId: later.id, archived: false });
  await waitFor(() => document.querySelector('[data-testid=later-projects]') === null && card('[data-testid=sidebar]', paused.id) !== null);
});

test('an unsent new draft keeps its project among the open ones; without a grouping, its projects stay open cards', () => {
  const entry = (id: string, threads: Partial<ThreadSummary>[], counts: Partial<Project> = {}, drafts: { projectId: string; text: string }[] = []): ProjectEntry => ({
    machine: {
      id: 'local', label: 'local',
      store: {
        threadsOf: () => threads.map((t, i) => ({ id: `${id}-${i}`, status: 'idle', pinned: false, ...t })),
        subagents: () => null, composerStates: {}, draft: null, draftEntries: drafts
      }
    } as never,
    project: { id, name: id, path: `/${id}`, createdAt: 0, ...counts }
  });
  const entries = [
    entry('busy', [{ status: 'running' }]),
    // A prompt typed for a new conversation waits on the user: a folded Working section must not hide it.
    entry('drafting', [{ status: 'running' }], {}, [{ projectId: 'drafting', text: 'Unsent new conversation' }]),
    entry('open', [{}]), entry('paused', [], { archivedThreads: 2 }), entry('quiet', [], { archivedThreads: 1, doneThreads: 1 })
  ];
  const ids = (sections: Record<string, ProjectEntry[]>) => Object.fromEntries(Object.entries(sections).map(([key, list]) => [key, list.map((e) => e.project.id)]));
  expect(ids(projectSections(entries, true, true))).toEqual({ working: ['busy'], open: ['drafting', 'open'], later: ['paused'], idle: ['quiet'] });
  expect(ids(projectSections(entries, false, true))).toEqual({ working: ['busy'], open: ['drafting', 'open', 'paused', 'quiet'], later: [], idle: [] });
  expect(ids(projectSections(entries, true, false))).toEqual({ working: [], open: ['busy', 'drafting', 'open'], later: ['paused'], idle: ['quiet'] });
});
