import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ThreadStatus } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

async function ready(): Promise<{ store: Store; client: FakeClient }> {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  return { store, client };
}

describe('Store', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('opens on the seeded core', async () => {
    const { store } = await ready();

    expect(store.connection).toBe('ready');
    expect(store.core?.version).toBe('2.0.0-beta.1');
    expect(store.projects.map((p) => p.id)).toEqual(['p-boite', 'p-brain']);
    expect(store.threads).toHaveLength(4);
    // Two seeded threads wait: one on a permission, one on a question.
    expect(store.threads.map((t) => t.status).sort()).toEqual([
      'idle',
      'idle',
      'waiting',
      'waiting'
    ]);
    expect(store.pendingPermissions.map((p) => p.id)).toEqual(['req-seed-1']);
    expect(store.pendingQuestions.map((q) => q.id)).toEqual(['qst-seed-1']);
    expect(store.unreadCount).toBe(1);
  });

  test('opening a thread clears its unread badge', async () => {
    const { store } = await ready();

    await store.open('t-descriptors');

    expect(store.openThread?.id).toBe('t-descriptors');
    expect(store.openThread?.unread).toBe(false);
    expect(store.threads.find((t) => t.id === 't-descriptors')?.unread).toBe(false);
    expect(store.unreadCount).toBe(0);
  });

  test('a pinned thread floats above the live ones of its project, and unpinning drops it back', async () => {
    const { store } = await ready();
    const project = store.threads.find((t) => t.id === 't-trace')?.projectId ?? '';
    const before = store.sortedThreadsOf(project).map((t) => t.id);
    expect(before[0]).not.toBe('t-trace');

    await store.pin('t-trace', true);
    expect(store.threads.find((t) => t.id === 't-trace')?.pinned).toBe(true);
    expect(store.sortedThreadsOf(project)[0]?.id).toBe('t-trace');

    await store.pin('t-trace', false);
    expect(store.sortedThreadsOf(project).map((t) => t.id)).toEqual(before);
  });

  test('a prompt streams into one text part and the thread goes running then idle', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');

    const seen: ThreadStatus[] = [];
    client.on('thread.updated', (summary) => {
      if (summary.id === 't-trace') seen.push(summary.status);
    });

    const before = store.openThread?.messages.length ?? 0;
    await store.send('read the trace note');
    await client.settled();

    expect(seen).toContain('running');
    expect(seen.at(-1)).toBe('idle');
    expect(store.openThread?.status).toBe('idle');

    const messages = store.openThread?.messages ?? [];
    expect(messages).toHaveLength(before + 2);

    const assistant = messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.state).toBe('complete');
    // The fake reasons before it answers, like a provider that streams thinking.
    expect(assistant?.parts).toEqual([
      { type: 'thinking', text: 'thinking about: read the trace note' },
      { type: 'text', text: 'read the trace note' }
    ]);
  });

  test('only the open thread streams, and the previous one is dropped', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');
    await store.open('t-descriptors');

    const deltas: string[] = [];
    client.on('message.delta', (delta) => deltas.push(delta.threadId));

    await client.call('turns.start', { threadId: 't-trace', prompt: 'nobody is watching' });
    await client.settled();

    expect(deltas).toEqual([]);
    expect(store.threads.find((t) => t.id === 't-trace')?.unread).toBe(true);
  });

  test('a tool part and a permission part land in the open thread', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');

    void store.send('[tool] and [permission] please');
    await Promise.resolve();

    // The seeded core already waits on one elsewhere, so pick this thread's.
    const pending = await waitFor(() => store.pendingPermissions.find((p) => p.threadId === 't-trace'));
    expect(pending.toolName).toBe('Write');

    await store.answer(pending.id, 'allow');
    await client.settled();

    const parts = store.openThread?.messages.at(-1)?.parts ?? [];
    expect(parts.map((p) => p.type)).toEqual(['thinking', 'text', 'permission', 'tool']);
    const permission = parts[2];
    expect(permission?.type === 'permission' && permission.decision).toBe('allow');
    const tool = parts[3];
    expect(tool?.type === 'tool' && tool.status).toBe('done');
  });

  test('a project removed elsewhere drops it, its threads and the open thread', async () => {
    const { store, client } = await ready();
    await store.open('t-trace');
    expect(store.openThread?.projectId).toBe('p-boite');

    // Straight through the client, the way another connection's removal arrives.
    await client.call('projects.remove', { projectId: 'p-boite' });

    expect(store.projects.map((p) => p.id)).toEqual(['p-brain']);
    expect(store.threads.every((t) => t.projectId !== 'p-boite')).toBe(true);
    const reopened = await waitFor(() => store.openThread ?? undefined);
    expect(reopened.projectId).toBe('p-brain');
  });

  test('a probe elsewhere fills the models of that instance, the descriptor until then', async () => {
    const { store, client } = await ready();
    expect(store.modelsOf('opencode', 'a-opencode').map((m) => m.id)).toEqual(['default']);
    expect(store.probedModels).toEqual({});

    // Straight through the client: what a second shell's probe looks like here.
    await client.call('providers.probe', { providerId: 'opencode', accountId: 'a-opencode' });

    expect(Object.keys(store.probedModels)).toEqual(['opencode::a-opencode']);
    const probed = store.modelsOf('opencode', 'a-opencode').map((m) => m.id);
    expect(probed.length).toBe(23);
    expect(probed.slice(0, 3)).toEqual(['default', 'anthropic/claude-sonnet-5', 'openai/gpt-5-codex']);
    // A provider that is not ACP keeps the descriptor's list either way.
    expect(store.modelsOf('echo', 'a-echo').map((m) => m.id)).toEqual(['echo-1']);
  });

  test('a long thread opens on its last page and loadOlder walks back in order', async () => {
    const client = new FakeClient({ delayMs: 0, long: true });
    const store = new Store();
    store.attach(client);
    await store.connect();

    await store.open('t-long');

    // The last page, not the four hundred messages.
    expect(store.openThread?.messages).toHaveLength(120);
    expect(store.openThread?.messages.at(0)?.id).toBe('m-long-280');
    expect(store.openThread?.messages.at(-1)?.id).toBe('m-long-399');
    expect(store.messagesBefore).toBe('m-long-280');

    expect(await store.loadOlder()).toBe(120);
    expect(store.openThread?.messages).toHaveLength(240);
    expect(store.messagesBefore).toBe('m-long-160');

    expect(await store.loadOlder()).toBe(120);
    const messages = store.openThread?.messages ?? [];
    expect(messages).toHaveLength(360);
    expect(messages.at(0)?.id).toBe('m-long-40');
    expect(messages.at(-1)?.id).toBe('m-long-399');
    expect(store.messagesBefore).toBe('m-long-40');
    expect(store.loadingOlder).toBe(false);

    // In order, no gap, no duplicate.
    const numbers = messages.map((message) => Number(message.id.replace('m-long-', '')));
    expect(new Set(numbers).size).toBe(360);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers[0]).toBe(40);
  });

  test('loadOlder stops at the first message and does nothing without a cursor', async () => {
    const client = new FakeClient({ delayMs: 0, long: true });
    const store = new Store();
    store.attach(client);
    await store.connect();
    await store.open('t-long');

    let rounds = 0;
    while (store.messagesBefore !== null) {
      await store.loadOlder();
      rounds += 1;
      if (rounds > 10) throw new Error('the cursor never reached the first message');
    }

    // 120 on open, then 120, 120 and the last 40.
    expect(rounds).toBe(3);
    expect(store.openThread?.messages).toHaveLength(400);
    expect(store.openThread?.messages.at(0)?.id).toBe('m-long-0');
    expect(await store.loadOlder()).toBe(0);
  });

  test('a short thread opens whole, with no cursor to walk', async () => {
    const { store } = await ready();
    await store.open('t-trace');

    expect(store.messagesBefore).toBeNull();
    expect(await store.loadOlder()).toBe(0);
  });

  test('settings changed elsewhere replace the ones the UI holds', async () => {
    const { store, client } = await ready();
    expect(store.settings?.maxConcurrentTurns).not.toBe(9);

    await client.call('settings.set', { maxConcurrentTurns: 9 });

    expect(store.settings?.maxConcurrentTurns).toBe(9);
  });
});

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition never became true');
}

test('account lifecycle reload preserves the running login snapshot', async () => {
  const { store, client } = await ready();
  await client.call('accounts.login', { accountId: 'a-claude-side' });
  await waitFor(() => store.logins['a-claude-side']?.url ?? undefined);
  const before = { ...store.logins['a-claude-side'] };
  await store.reload();
  expect(store.logins['a-claude-side']).toEqual(before);
});

test('account lifecycle refuses removal of an account referenced by an archived thread', async () => {
  const { client } = await ready();
  await client.call('threads.archive', { threadId: 't-trace', archived: true });
  await expect(client.call('accounts.remove', { accountId: 'a-echo' })).rejects.toThrow(/thread/i);
  expect((await client.call('accounts.list', {})).some((a) => a.id === 'a-echo')).toBe(true);
});

test('account lifecycle cancellation removes the login and permits retry', async () => {
  const { store, client } = await ready();
  await store.loginAccount('a-claude-side');
  await waitFor(() => store.logins['a-claude-side']?.url ?? undefined);
  expect(await client.call('accounts.logins', {})).toHaveLength(1);
  await store.cancelLogin('a-claude-side');
  expect(store.logins['a-claude-side']).toBeUndefined();
  expect(await client.call('accounts.logins', {})).toEqual([]);
  await store.loginAccount('a-claude-side');
  expect(store.logins['a-claude-side']?.state).toBe('running');
  await store.removeAccount('a-claude-side');
  expect(store.accounts.some((a) => a.id === 'a-claude-side')).toBe(false);
  expect(await client.call('accounts.logins', {})).toEqual([]);
});

test('account lifecycle fake rejects unsupported login and enforces provider isolation', async () => {
  const { client } = await ready();
  await expect(client.call('accounts.login', { accountId: 'a-echo' })).rejects.toThrow(/login is not available/i);
  const account = await client.call('accounts.add', {
    providerId: 'antigravity', label: 'isolated only', useDefaultLocation: true
  });
  expect(account.isolationDir).toBeTruthy();
});

test('account lifecycle newer cancellation beats a stale reload snapshot', async () => {
  const { store, client } = await ready();
  await store.loginAccount('a-claude-side');
  await waitFor(() => store.logins['a-claude-side']?.url ?? undefined);
  const call = client.call.bind(client);
  let release!: () => void;
  let snapshotRead = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'accounts.logins') {
      snapshotRead = true;
      await gate;
    }
    return result;
  });
  try {
    const reload = store.reload();
    await waitFor(() => snapshotRead ? true : undefined);
    await store.cancelLogin('a-claude-side');
    release();
    await reload;
    expect(store.logins['a-claude-side']).toBeUndefined();
  } finally {
    release();
    spy.mockRestore();
  }
});
