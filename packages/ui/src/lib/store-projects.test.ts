import { afterEach, expect, test, vi } from 'vitest';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

afterEach(() => {
  vi.restoreAllMocks();
});

test('the draft the boot lands on reuses the project list of the boot, and a draft the user opens asks again', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  const asked = vi.spyOn(client, 'call');
  store.attach(client);
  try {
    await store.connect();
    const lists = () => asked.mock.calls.filter(([method]) => method === 'projects.list').length;
    expect(lists()).toBe(1);

    await store.openLanding();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.draft).not.toBeNull();
    expect(lists()).toBe(1);

    // New thread pressed right away still asks, so a `git init` done meanwhile shows.
    store.startDraft();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lists()).toBe(2);
  } finally {
    store.detach();
    client.close();
  }
});

test('archiving the open project lands elsewhere, and another client hears the flag', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  const other = new Store();
  store.attach(client);
  other.attach(client);
  try {
    await store.connect();
    await other.connect();
    await store.open('t-trace');
    expect(store.openThread?.projectId).toBe('p-boite');

    expect(await store.archiveProject('p-boite', true)).toBe(true);
    expect(store.projects.find((p) => p.id === 'p-boite')?.archived).toBe(true);
    // The screen leaves the archived project for a thread of one still listed.
    expect(store.openThread?.projectId).not.toBe('p-boite');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(other.projects.find((p) => p.id === 'p-boite')?.archived).toBe(true);

    expect(await store.archiveProject('p-boite', false)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(other.projects.find((p) => p.id === 'p-boite')?.archived).toBeUndefined();
  } finally {
    store.detach();
    other.detach();
    client.close();
  }
});

test('worktree defaults follow the project on both clients and saved or explicit draft choices survive', async () => {
  window.localStorage.clear();
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  const other = new Store();
  store.attach(client);
  other.attach(client);
  try {
    await store.connect();
    await other.connect();
    await store.setProjectWorktreeDefault('p-boite', true);
    await new Promise(resolve => setTimeout(resolve, 0));
    other.startDraft('p-boite');
    expect(other.draft?.worktree).toBe(true);
    store.startDraft('p-notes');
    expect(store.draft?.worktree).toBe(false);
    store.setDraftProject('p-boite');
    expect(store.draft?.worktree).toBe(true);
    store.setDraftWorktree(false);
    store.setDraftProject('p-notes');
    expect(store.draft?.worktree).toBe(false);
    store.setDraftProject('p-boite');
    expect(store.draft?.worktree).toBe(false);
    store.composerStates.draft!.text = 'Keep this draft';
    store.startDraft('p-notes');
    store.startDraft('p-boite');
    expect(store.draft?.worktree).toBe(false);
    await store.setProjectWorktreeDefault('p-boite', false);
    await new Promise(resolve => setTimeout(resolve, 0));
    // The other client's already open draft keeps its choice.
    expect(other.draft?.worktree).toBe(true);
    other.startDraft('p-notes');
    other.startDraft('p-boite');
    expect(other.draft?.worktree).toBe(false);
  } finally {
    store.detach(); other.detach(); client.close();
  }
});
