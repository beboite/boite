import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { WorktreeEntry } from '@boite/contracts';
import WorktreesCard from './WorktreesCard.svelte';
import { confirm } from '../lib/confirm.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  confirm.answer(false);
});

async function settle() {
  for (let i = 0; i < 6; i++) { await tick(); await Promise.resolve(); }
  flushSync();
}

const entry = (name: string, extra: Partial<WorktreeEntry> = {}): WorktreeEntry => ({
  path: `C:\\w\\${name}`, branch: `boite/${name}`, dirty: false, unmerged: false, missing: false,
  threadId: null, threadTitle: null, threadArchived: false, ...extra
});

function draw() {
  let listed: WorktreeEntry[] = [
    entry('clean'),
    entry('gone', { missing: true }),
    entry('dirty', { dirty: true }),
    entry('live', { threadId: 't-1', threadTitle: 'Port it' })
  ];
  const call = vi.fn(async (method: string, params: { path?: string }) => {
    if (method === 'worktrees.list') return listed;
    listed = listed.filter((e) => e.path !== params.path);
    return { ok: true, branchDeleted: true };
  });
  const store = {
    owner: true, connection: 'ready', error: null, settingsSection: { id: 'worktrees', request: 1 },
    client: { call }, projects: [{ id: 'p-1', name: 'boite', path: 'C:\\w\\boite', createdAt: 0, repository: true }]
  };
  running = mount(WorktreesCard, { target: document.body, props: { store: store as never } });
  flushSync();
  return { call };
}

const rows = () => [...document.querySelectorAll('[data-testid=worktrees-card] li')].map((li) => li.getAttribute('data-path'));

test('a jump to the card reads the list; the sweep takes only what has nothing to lose', async () => {
  const { call } = draw();
  await settle();
  expect(call).toHaveBeenCalledWith('worktrees.list', { projectId: 'p-1' });
  expect(rows()).toHaveLength(4);
  const live = document.querySelector<HTMLButtonElement>('[data-path="C:\\\\w\\\\live"] button')!;
  expect(live.disabled).toBe(true);

  const sweep = document.querySelector<HTMLButtonElement>('[data-testid=worktrees-sweep]')!;
  expect(sweep.textContent).toContain('(2)');
  sweep.click();
  await settle();
  const removed = call.mock.calls.filter(([m]) => m === 'worktrees.remove').map(([, p]) => p);
  expect(removed).toEqual([
    { projectId: 'p-1', path: 'C:\\w\\clean' },
    { projectId: 'p-1', path: 'C:\\w\\gone' }
  ]);
  expect(rows()).toEqual(['C:\\w\\dirty', 'C:\\w\\live']);
  expect(document.querySelector('[data-testid=worktrees-sweep]')).toBeNull();
});

test('a worktree holding changes asks first, then goes with force', async () => {
  const { call } = draw();
  await settle();
  document.querySelector<HTMLButtonElement>('[data-path="C:\\\\w\\\\dirty"] button')!.click();
  await settle();
  expect(confirm.current?.body).toContain('uncommitted changes');
  confirm.answer(true);
  await settle();
  expect(call).toHaveBeenCalledWith('worktrees.remove', { projectId: 'p-1', path: 'C:\\w\\dirty', force: true });
  expect(rows()).not.toContain('C:\\w\\dirty');
});
