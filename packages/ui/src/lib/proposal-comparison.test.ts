import { afterEach, expect, test, vi } from 'vitest';
import type { RpcMethodName, RpcParams, Thread } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { ProposalComparison, proposalResponse, savedComparison } from './proposal-comparison.svelte';

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.detach(); vi.restoreAllMocks(); });

async function fixture() {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  stores.push(store);
  store.attach(client);
  await store.connect();
  const project = store.projects[0]!;
  const choice = store.defaultChoice()!;
  // A provider probe is separate from creating comparison threads.
  vi.spyOn(store, 'prepareDraftChoice').mockImplementation(async value => value);
  return { client, store, project, choice, comparison: new ProposalComparison(store) };
}

test('runs the same prompt in two isolated threads on the owning store, without changing the open thread', async () => {
  const { client, store, project, choice, comparison } = await fixture();
  const call = vi.spyOn(client, 'call');
  const before = store.openThread;
  const second = { ...choice, model: 'other-model' };
  await comparison.start(project, 'Compare the parser', [choice, second]);
  expect(call.mock.calls.filter(([method]) => method === 'threads.create').map(([, params]) => params)).toEqual([
    expect.objectContaining({ projectId: project.id, accountId: choice.accountId, worktree: {}, permissionMode: 'default' }),
    expect.objectContaining({ projectId: project.id, model: 'other-model', worktree: {}, permissionMode: 'default' })
  ]);
  const starts = call.mock.calls.filter(([method]) => method === 'turns.start');
  expect(starts).toHaveLength(2);
  expect(starts.map(([, params]) => (params as RpcParams<'turns.start'>).prompt)).toEqual(['Compare the parser', 'Compare the parser']);
  expect(new Set(comparison.proposals.map(proposal => proposal.thread!.id)).size).toBe(2);
  expect(starts.map(([, params]) => (params as RpcParams<'turns.start'>).clientRequestId).every(Boolean)).toBe(true);
  expect(store.openThread).toBe(before);
  expect(call.mock.calls.some(([method]) => method === 'threads.subscribe' || method === 'threads.unsubscribe')).toBe(false);
});

test('double submission and submitting a finished comparison cannot create more threads', async () => {
  const { client, project, choice, comparison } = await fixture();
  const call = vi.spyOn(client, 'call');
  await Promise.all([comparison.start(project, 'One prompt', [choice, choice]), comparison.start(project, 'One prompt', [choice, choice])]);
  await comparison.start(project, 'Another prompt', [choice, choice]);
  expect(call.mock.calls.filter(([method]) => method === 'threads.create')).toHaveLength(2);
  expect(call.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(2);
});

test('a failed second worktree preserves the first result and reports the failure', async () => {
  const { client, project, choice, comparison } = await fixture();
  const original = client.call.bind(client);
  let creates = 0;
  vi.spyOn(client, 'call').mockImplementation((async (method: RpcMethodName, params: RpcParams<RpcMethodName>) => {
    if (method === 'threads.create' && ++creates === 2) throw new Error('git worktree add refused branch');
    return original(method, params);
  }) as typeof client.call);
  await comparison.start(project, 'One prompt', [choice, choice]);
  expect(comparison.proposals[0]!.phase).toBe('started');
  expect(comparison.proposals[0]!.snapshot).not.toBeNull();
  expect(comparison.proposals[1]!.thread).toBeNull();
  expect(comparison.proposals[1]!.error).toBe('git worktree add refused branch');
  expect(comparison.pending).toBe(false);
});

test('a start failure keeps its created thread available and never retries automatically', async () => {
  const { client, project, choice, comparison } = await fixture();
  const original = client.call.bind(client);
  const call = vi.spyOn(client, 'call').mockImplementation((async (method: RpcMethodName, params: RpcParams<RpcMethodName>) => {
    if (method === 'turns.start') throw new Error('provider unavailable');
    return original(method, params);
  }) as typeof client.call);
  await comparison.start(project, 'One prompt', [choice, choice]);
  expect(comparison.proposals.every(proposal => proposal.thread && proposal.phase === 'failed' && proposal.error === 'provider unavailable')).toBe(true);
  await comparison.refresh();
  expect(call.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(2);
});

test('changing machines after a create never starts the returned id on either machine', async () => {
  const { client, store, project, choice, comparison } = await fixture();
  const original = client.call.bind(client);
  const remote = new FakeClient({ delayMs: 0 });
  const remoteCall = vi.spyOn(remote, 'call');
  const call = vi.spyOn(client, 'call').mockImplementation((async (method: RpcMethodName, params: RpcParams<RpcMethodName>) => {
    const result = await original(method, params);
    if (method === 'threads.create') store.attach(remote);
    return result;
  }) as typeof client.call);
  await comparison.start(project, 'One prompt', [choice, choice]);
  expect(comparison.sameMachine).toBe(false);
  expect(call.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(0);
  expect(remoteCall.mock.calls.filter(([method]) => method === 'turns.start' || method === 'threads.get')).toHaveLength(0);
  expect(comparison.proposals.every(proposal => proposal.phase === 'failed')).toBe(true);
  client.close();
});

test('device and unavailable targets cannot launch, and reads surface errors', async () => {
  const { client, store, project, choice, comparison } = await fixture();
  const call = vi.spyOn(client, 'call');
  store.principal = 'session';
  await comparison.start(project, 'One prompt', [choice, choice]);
  expect(comparison.error).toContain('owner connection');
  expect(call).not.toHaveBeenCalled();
  store.principal = 'owner';
  await comparison.start(project, 'One prompt', [choice, { ...choice, accountId: 'missing' }]);
  expect(comparison.error).toContain('available provider');
  expect(call).not.toHaveBeenCalled();
  await comparison.start(project, 'One prompt', [choice, choice]);
  call.mockRejectedValue(new Error('snapshot unavailable'));
  await comparison.refresh();
  expect(comparison.proposals.every(proposal => proposal.readError === 'snapshot unavailable')).toBe(true);
});

test('comparison renders assistant text only and leaves tool output to its thread', () => {
  const thread = { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'request' }] },
    { role: 'assistant', parts: [{ type: 'thinking', text: 'private reasoning' }, { type: 'text', text: 'First response' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'Second response' }] }
  ] } as unknown as Thread;
  expect(proposalResponse(thread)).toBe('First response\n\nSecond response');
  expect(proposalResponse(null)).toBe('');
});

test('the pair survives view unmounts and is scoped to its owning machine and project', async () => {
  const { store, project, choice, comparison } = await fixture();
  await comparison.start(project, 'Keep both proposals', [choice, choice]);
  expect(savedComparison(store, project.id)).toBe(comparison);
  expect(savedComparison(store, 'another-project')).toBeNull();
  const other = await fixture();
  expect(savedComparison(other.store, project.id)).toBeNull();
  store.machineId = 'another-machine';
  expect(savedComparison(store, project.id)).toBeNull();
});

test('each proposal reads changes and a selected diff from its own worktree', async () => {
  const { client, project, choice, comparison } = await fixture();
  const call = vi.spyOn(client, 'call');
  await comparison.start(project, 'Compare changes', [choice, choice]);
  for (const proposal of comparison.proposals) {
    expect(call).toHaveBeenCalledWith('git.status', { threadId: proposal.thread!.id });
    const path = proposal.changes!.changes[0]!.path;
    await comparison.selectDiff(proposal.id, path);
    expect(call).toHaveBeenCalledWith('git.diff', { threadId: proposal.thread!.id, path });
    expect(proposal.diff?.path).toBe(path);
  }
});
