import { afterEach, expect, test, vi } from 'vitest';
import type { ComposerRecord, ComposerValue } from '@boite/contracts';
import { FakeClient } from './fake-client';

const clients: FakeClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });

test.each(['inputs', 'drafts'] as const)('closing a private %s connection during delivery never publishes its composer to a peer', async section => {
  const owner = new FakeClient({ delayMs: 0 });
  clients.push(owner);
  await owner.connect();
  const project = await owner.call('projects.drafts', {});
  const account = (await owner.call('accounts.list', {})).find(row => row.providerId === 'echo')!;
  const choice = { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' as const };
  const thread = section === 'inputs' ? await owner.call('threads.create', { projectId: project.id, ...choice, model: undefined, incognito: true }) : null;
  const peer = owner.composerPeer({ delayMs: 0 });
  clients.push(peer);
  await peer.connect();
  const records: ComposerRecord[] = [];
  peer.on('composer.updated', record => records.push(record));
  let closed = false;
  owner.on('thread.updated', row => {
    if (closed || (thread ? row.id !== thread.id || row.status !== 'running' : row.title !== 'Private delivery')) return;
    closed = true;
    owner.close();
  });
  const value: ComposerValue = { input: { text: 'Private box', attachments: [], paused: false,
    queued: [{ id: 'private-detach-input', text: 'Private delivery', attachments: [], choice }] },
    ...(section === 'drafts' ? { draft: { projectId: project.id, worktree: false, incognito: true }, choice } : {}) };
  await owner.call('composer.put', { section, id: thread?.id ?? 'private-detach-draft', expectedRevision: 0, value }).catch(() => undefined);
  await vi.waitFor(() => expect(closed).toBe(true));
  await owner.settled();
  const listed = await peer.call('composer.list', {});
  expect(records).toEqual([]);
  expect(listed).toEqual([]);
});
