import { expect } from 'vitest';
import { RpcErrorCode, STEWARD_DEFAULT_CAPABILITIES, type RpcEvents, type StewardCapability } from '@boite/contracts';
import { test } from '../../test/fake-client';

const grant = { threadId: 't-trace', projectIds: ['p-boite'], allProjects: false, capabilities: [...STEWARD_DEFAULT_CAPABILITIES], notify: true };

test('stewards.set refuses what the core refuses, naming the field', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, delegationDemo: true });
  const threads = await client.call('threads.list', { includeArchived: true });
  const child = threads.find(thread => thread.parentThreadId)!;
  await client.call('threads.archive', { threadId: 't-bench', archived: true });
  const refusals: [Partial<typeof grant>, number, string][] = [
    [{ threadId: 'nowhere' }, RpcErrorCode.NotFound, 'no such thread'],
    [{ threadId: child.id }, RpcErrorCode.Refused, 'grant.threadId'],
    [{ threadId: 't-bench' }, RpcErrorCode.Refused, 'grant.threadId'],
    [{ projectIds: ['p-gone'] }, RpcErrorCode.Refused, 'grant.projectIds'],
    [{ projectIds: [] }, RpcErrorCode.InvalidParams, 'grant.projectIds'],
    [{ capabilities: ['message', 'fly' as StewardCapability] }, RpcErrorCode.InvalidParams, 'grant.capabilities'],
  ];
  for (const [patch, code, field] of refusals) {
    await expect.soft(client.call('stewards.set', { grant: { ...grant, ...patch } })).rejects.toMatchObject({ code, message: expect.stringContaining(field) });
  }
  expect(await client.call('stewards.list', {})).toEqual([]);
});

test('stewards.set keeps the first grant time, normalizes the grant and announces each change', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const changed: RpcEvents['stewards.changed'][] = [];
  client.on('stewards.changed', event => changed.push(event));
  const first = await client.call('stewards.set', { grant: { ...grant, capabilities: ['answer', 'message', 'answer'] } });
  expect(first.capabilities).toEqual(['message', 'answer']);
  const second = await client.call('stewards.set', { grant: { ...grant, allProjects: true } });
  expect(second).toMatchObject({ allProjects: true, projectIds: [], grantedAt: first.grantedAt });
  expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  expect(await client.call('stewards.list', {})).toEqual([second]);
  expect(await client.call('steward.get', { threadId: 't-trace' })).toMatchObject({ grant: second, projects: [{ id: 'p-boite' }, { id: 'p-notes' }] });
  await client.call('stewards.revoke', { threadId: 't-trace' });
  expect(await client.call('stewards.list', {})).toEqual([]);
  await expect(client.call('steward.threads', { threadId: 't-trace' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'threadId' } });
  expect(changed).toEqual([{ threadId: 't-trace' }, { threadId: 't-trace' }, { threadId: 't-trace' }]);
});

test('a steward acts only on threads of its projects and within its capabilities', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await client.call('stewards.set', { grant });
  const rows = await client.call('steward.threads', { threadId: 't-trace' });
  expect(rows.every(row => row.projectId === 'p-boite')).toBe(true);
  expect(rows.find(row => row.id === 't-trace')?.self).toBe(true);
  await expect.soft(client.call('steward.act', { threadId: 't-trace', target: 't-descriptors', action: 'archive' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'target' } });
  await expect.soft(client.call('steward.act', { threadId: 't-trace', target: 't-trace', action: 'archive' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'target' } });
  await expect.soft(client.call('steward.act', { threadId: 't-trace', target: 't-bench', action: 'remove' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'capability', expected: 'remove' } });
  const archived = await client.call('steward.act', { threadId: 't-trace', target: 't-bench', action: 'archive' });
  expect(archived.thread).toMatchObject({ id: 't-bench', archived: true });
  const opened = await client.call('threads.get', { threadId: 't-bench' });
  expect(opened.messages.at(-1)?.parts[0]).toMatchObject({ text: expect.stringContaining('Archived by the steward') });
});
