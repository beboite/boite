import { afterEach, expect, test } from 'vitest';
import { RpcErrorCode } from '@boite/contracts';
import { FakeClient } from './fake-client';

/* The worktree list and its removal, with the core's refusals (`packages/core/src/worktree-sweep.ts`). */

const clients: FakeClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function fake(options: ConstructorParameters<typeof FakeClient>[0] = {}): Promise<FakeClient> {
  const client = new FakeClient({ delayMs: 0, ...options });
  clients.push(client);
  await client.connect();
  return client;
}

const ROOT = 'C:\\src\\.boite-worktrees\\boite';

test('new worktrees follow storage settings while existing ones keep their paths', async () => {
  const client = await fake();
  const create = (projectId: string, title: string) => client.call('threads.create', { projectId, title, providerId: 'echo', accountId: 'a-echo', worktree: {} });
  const before = await create('p-boite', 'Before');
  expect(before.branch).toMatch(/^boite\/wt-[a-z0-9]{8}$/);
  expect(before.cwd).toBe(`C:\\src\\boite\\.boite\\worktrees\\${before.branch!.slice(6)}`);
  await client.call('settings.set', { worktreeStorage: { mode: 'shared', directory: 'D:\\Worktrees' } });
  const after = await create('p-boite', 'After');
  expect(after.cwd).toBe(`D:\\Worktrees\\boite-p-boite\\${after.branch!.slice(6)}`);
  expect((await client.call('threads.list', {})).find(t => t.id === before.id)?.cwd).toBe(before.cwd);
  await client.call('settings.set', { worktreeStorage: { mode: 'project', directory: 'D:\\Worktrees' } });
  const back = await create('p-notes', 'Back');
  expect(back.cwd).toBe(`C:\\src\\notes\\.boite\\worktrees\\${back.branch!.slice(6)}`);
  await client.call('turns.start', { threadId: before.id, prompt: 'Fix worktree names' });
  await client.settled();
  const named = await client.call('threads.retitle', { threadId: before.id });
  expect(named).toMatchObject({ branch: 'boite/fix-worktree-names', cwd: before.cwd, branchNamingPending: false });
  expect((await client.call('worktrees.list', { projectId: 'p-boite' })).find(entry => entry.path === before.cwd)?.branch).toBe(named.branch);
});

test('the seeded repository lists every kind of worktree, main checkout left out', async () => {
  const client = await fake();
  const entries = await client.call('worktrees.list', { projectId: 'p-boite' });
  const at = (slug: string) => entries.find((entry) => entry.path === `${ROOT}\\${slug}`);
  expect(entries.some((entry) => entry.path === 'C:\\src\\boite')).toBe(false);
  expect(at('fix-the-login')).toMatchObject({ dirty: false, unmerged: false, missing: false, threadId: null });
  expect(at('try-a-bigger-cache')).toMatchObject({ dirty: true, threadId: null });
  expect(at('spike-the-tray')).toMatchObject({ unmerged: true, threadId: null });
  expect(at('old-bench')).toMatchObject({ missing: true, dirty: false });
  expect(at('port-the-scheduler')).toMatchObject({ threadId: 't-scheduler', threadTitle: 'Port the scheduler', threadArchived: false });
  expect(at('rework-the-parser')).toMatchObject({ threadId: 't-parser', threadArchived: true, unmerged: true });
  expect(entries.find((entry) => entry.branch === 'release/2.0')?.path).toBe('C:\\src\\boite-release');
  // The archived holder stays out of the sidebar's list.
  expect((await client.call('threads.list', {})).some((thread) => thread.id === 't-parser')).toBe(false);
});

test('removal refuses as the core does, and force takes what would be lost', async () => {
  const client = await fake();
  const remove = (path: string, force?: boolean) =>
    client.call('worktrees.remove', { projectId: 'p-boite', path, ...(force === undefined ? {} : { force }) });
  await expect(remove('C:\\src\\elsewhere')).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'path', expected: 'a worktree of this project' } });
  await expect(remove('C:\\src\\boite')).rejects.toMatchObject({ data: { field: 'path', expected: 'a linked worktree, not the main checkout' } });
  await expect(remove(`${ROOT}\\port-the-scheduler`, true)).rejects.toMatchObject({ data: { threadId: 't-scheduler', expected: 'a worktree no live thread uses' } });
  await expect(remove(`${ROOT}\\try-a-bigger-cache`)).rejects.toThrow('This worktree has uncommitted changes.');
  await expect(remove(`${ROOT}\\spike-the-tray`)).rejects.toThrow('This worktree has commits on no other branch.');

  expect(await remove(`${ROOT}\\fix-the-login`)).toEqual({ ok: true, branchDeleted: true });
  expect(await remove('C:\\src\\boite-release')).toEqual({ ok: true, branchDeleted: false });
  expect(await remove(`${ROOT}\\spike-the-tray`, true)).toEqual({ ok: true, branchDeleted: true });
  expect(await remove(`${ROOT}\\old-bench`)).toEqual({ ok: true, branchDeleted: true });
  const left = (await client.call('worktrees.list', { projectId: 'p-boite' })).map((entry) => entry.path);
  expect(left).not.toContain(`${ROOT}\\fix-the-login`);
  expect(left).not.toContain(`${ROOT}\\old-bench`);
});

test('a thread restored after its worktree was removed is refused a turn by its folder', async () => {
  const client = await fake();
  expect(await client.call('worktrees.remove', { projectId: 'p-boite', path: `${ROOT}\\rework-the-parser`, force: true })).toEqual({ ok: true, branchDeleted: true });
  await client.call('threads.archive', { threadId: 't-parser', archived: false });
  await expect(client.call('turns.start', { threadId: 't-parser', prompt: 'still there?' })).rejects.toMatchObject({
    code: RpcErrorCode.Refused,
    data: { threadId: 't-parser', field: 'cwd', cwd: `${ROOT}\\rework-the-parser` }
  });
});

test('a thread started in a worktree adds it to the list, and both methods are for the owner only', async () => {
  const client = await fake();
  const thread = await client.call('threads.create', { projectId: 'p-notes', providerId: 'echo', accountId: 'a-echo', title: 'Tidy the index', worktree: {} });
  expect(await client.call('worktrees.list', { projectId: 'p-notes' })).toContainEqual(expect.objectContaining({ path: thread.cwd, threadId: thread.id, dirty: false }));

  const phone = await fake({ principal: 'session' });
  await expect(phone.call('worktrees.list', { projectId: 'p-boite' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(phone.call('worktrees.remove', { projectId: 'p-boite', path: `${ROOT}\\fix-the-login` })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
});
