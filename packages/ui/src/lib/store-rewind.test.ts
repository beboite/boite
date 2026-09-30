import { expect, test, vi } from 'vitest';
import { RpcErrorCode } from '@boite/contracts';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';

async function ready(): Promise<{ store: Store; client: FakeClient }> {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store();
  store.attach(client);
  await store.connect();
  return { store, client };
}

/** Two finished turns on the open thread, and the ids of their user messages. */
async function twoTurns(client: FakeClient, threadId: string): Promise<[string, string]> {
  const first = await client.call('turns.start', { threadId, prompt: 'keep this' });
  await client.settled();
  const second = await client.call('turns.start', { threadId, prompt: 'edit this', attachments: [{ kind: 'image', mimeType: 'image/png', data: 'AAAA', name: 'shot.png' }] });
  await client.settled();
  const messages = (await client.call('threads.get', { threadId })).messages;
  const userOf = (turnId: string) => messages.find(message => message.turnId === turnId && message.role === 'user')?.id;
  const ids = [userOf(first.id), userOf(second.id)];
  if (!ids[0] || !ids[1]) throw new Error('missing user messages');
  return [ids[0], ids[1]];
}

test('the fake rewinds like the core: drops the rest, refuses the wrong message and a busy thread', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    await client.call('threads.subscribe', { threadId: 't-trace' });
    const [kept, edited] = await twoTurns(client, 't-trace');
    const truncated: unknown[] = [];
    client.on('message.truncated', event => truncated.push(event));
    const reply = (await client.call('threads.get', { threadId: 't-trace' })).messages.find(message => message.role === 'assistant');
    await expect(client.call('threads.rewind', { threadId: 't-trace', messageId: reply!.id })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'messageId', expected: 'user' } });
    await expect(client.call('threads.rewind', { threadId: 't-trace', messageId: 'm-none' })).rejects.toMatchObject({ data: { field: 'messageId', expected: 'a user message of this thread' } });

    const rewound = await client.call('threads.rewind', { threadId: 't-trace', messageId: edited });
    expect(rewound.prompt).toBe('edit this');
    expect(rewound.attachments).toEqual([{ kind: 'image', mimeType: 'image/png', data: 'AAAA', name: 'shot.png' }]);
    expect(rewound.session).toBe('seeded');
    expect(rewound.files).toEqual({ status: 'unchanged', count: 0 });
    expect(rewound.thread.sessionId).toBeNull();
    expect(rewound.thread.messages.some(message => message.id === edited)).toBe(false);
    expect(rewound.thread.messages.some(message => message.id === kept)).toBe(true);
    expect(truncated).toEqual([{ threadId: 't-trace', messageId: edited }]);

    await client.call('turns.start', { threadId: 't-trace', prompt: 'busy' });
    await expect(client.call('threads.rewind', { threadId: 't-trace', messageId: kept })).rejects.toMatchObject({ data: { reason: 'turn-in-flight' } });
    await client.settled();
  } finally { client.close(); }
});

test('a rewind without file backups visibly explains that the code could not be restored', async () => {
  const { store, client } = await ready();
  try {
    const [, edited] = await twoTurns(client, 't-trace');
    await store.open('t-trace');
    const call = client.call.bind(client);
    vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
      const result = await call(method, params);
      if (method === 'threads.rewind') return { ...result as object, files: { status: 'unavailable', count: 0 } } as typeof result;
      return result;
    });
    expect((await store.rewind(edited))?.files?.status).toBe('unavailable');
    expect(store.error).toContain('code');
  } finally { store.detach(); }
});

test('the fake forks a copy that leaves the source whole', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    const [kept] = await twoTurns(client, 't-trace');
    const before = await client.call('threads.get', { threadId: 't-trace' });
    const fork = await client.call('threads.fork', { threadId: 't-trace', messageId: kept, worktree: true });
    expect(fork.title).toBe(`${before.title} (fork)`);
    expect(fork.branch).toBeTruthy();
    expect(fork.sessionId).toBeNull();
    const copy = await client.call('threads.get', { threadId: fork.id });
    const upTo = before.messages.findIndex(message => message.id === kept) + 1;
    expect(copy.messages.map(message => message.role)).toEqual(before.messages.slice(0, upTo).map(message => message.role));
    expect(copy.messages.every(message => message.threadId === fork.id)).toBe(true);
    const after = await client.call('threads.get', { threadId: 't-trace' });
    expect(after.messages.map(message => message.id)).toEqual(before.messages.map(message => message.id));
  } finally { client.close(); }
});

test('store.rewind applies the new thread and hands the composer its content', async () => {
  const { store, client } = await ready();
  try {
    await store.open('t-trace');
    const [, edited] = await twoTurns(client, 't-trace');
    await vi.waitFor(() => expect(store.openThread?.messages.some(message => message.id === edited)).toBe(true));
    const rewound = await store.rewind(edited);
    expect(rewound?.prompt).toBe('edit this');
    expect(rewound?.attachments).toHaveLength(1);
    expect(store.openThread?.messages.some(message => message.id === edited)).toBe(false);
    expect(store.openThread?.sessionId).toBeNull();
    const row = store.threads.find(thread => thread.id === 't-trace');
    expect(row && 'messages' in row).toBe(false);
    expect(await store.rewind('m-none')).toBeNull();
  } finally { store.detach(); client.close(); }
});

test('a rewind asked elsewhere drops the messages from the open thread', async () => {
  const { store, client } = await ready();
  try {
    await store.open('t-trace');
    const [kept, edited] = await twoTurns(client, 't-trace');
    await vi.waitFor(() => expect(store.openThread?.messages.some(message => message.id === edited)).toBe(true));
    const editedTurn = store.openThread?.messages.find(message => message.id === edited)?.turnId;
    expect(store.openThread?.turns.some(turn => turn.id === editedTurn)).toBe(true);
    // Another client's rewind reaches this one as the event alone.
    await client.call('threads.rewind', { threadId: 't-trace', messageId: edited });
    await vi.waitFor(() => expect(store.openThread?.messages.some(message => message.id === edited)).toBe(false));
    expect(store.openThread?.messages.some(message => message.id === kept)).toBe(true);
    expect(store.openThread?.turns.some(turn => turn.id === editedTurn)).toBe(false);
  } finally { store.detach(); client.close(); }
});

test('store.fork opens the new thread', async () => {
  const { store, client } = await ready();
  try {
    await store.open('t-trace');
    const [kept] = await twoTurns(client, 't-trace');
    const fork = await store.fork(kept, { worktree: true });
    expect(fork).not.toBeNull();
    expect(store.openThread?.id).toBe(fork!.id);
    expect(store.threads.some(thread => thread.id === fork!.id)).toBe(true);
    expect(store.openThread?.messages.at(-1)?.role).toBe('user');
  } finally { store.detach(); client.close(); }
});
