import { expect, test, vi } from 'vitest';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from './client';

test('returning to a cached thread paints its history before the core replies', async () => {
  const client = new FakeClient({ delayMs: 0, long: true });
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-long');
  await store.loadOlder();
  const messages = store.openThread!.messages;
  await store.open('t-bench');
  const call = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    await gate;
    return call(method, params);
  });
  let opening: Promise<void> | undefined;
  try {
    opening = store.open('t-long');
    expect(store.openThread?.id).toBe('t-long');
    expect(store.openThread?.messages).toBe(messages);
    expect(store.messagesBefore).toBe('m-long-240');
    release(); await opening;
    expect(store.openThread?.messages).toHaveLength(160);
    expect(client.coreSubscribers).toEqual(['t-long']);
  } finally { release(); await opening; spy.mockRestore(); store.detach(); client.close(); }
});

test('a quiet revalidation retains message objects', async () => {
  const client = new FakeClient({ delayMs: 0, long: true });
  const store = new Store(); store.attach(client); await store.connect();
  try {
    await store.open('t-long');
    const thread = store.openThread!;
    const messages = thread.messages;
    await store.open('t-long', false);
    expect(store.openThread).toBe(thread);
    expect(store.openThread!.messages).toBe(messages);
  } finally { store.detach(); client.close(); }
});

test('revalidation refreshes JSON input when an array becomes an object with numeric keys', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client); await store.connect();
  await store.open('t-trace');
  const message = store.openThread!.messages.find(message => message.parts.some(part => part.type === 'tool'))!;
  const part = message.parts.find(part => part.type === 'tool')!;
  if (part.type !== 'tool') throw new Error('fixture needs a tool');
  part.input = ['file'];
  const call = client.call.bind(client);
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'threads.get') {
      const thread = result as import('@boite/contracts').Thread;
      const tool = thread.messages.find(row => row.id === message.id)?.parts.find(item => item.type === 'tool' && item.toolId === part.toolId);
      if (tool?.type === 'tool') tool.input = { 0: 'file' };
    }
    return result;
  });
  try {
    await store.open('t-trace', false);
    const tool = store.openThread!.messages.find(row => row.id === message.id)!.parts.find(item => item.type === 'tool' && item.toolId === part.toolId)!;
    if (tool.type !== 'tool') throw new Error('fixture needs a tool');
    expect(tool.input).toEqual({ 0: 'file' });
  } finally { spy.mockRestore(); store.detach(); client.close(); }
});

test('more than four small visits retain their history for an immediate return', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client); await store.connect();
  try {
    for (let index = 0; index < 2; index++) await client.call('threads.create', { projectId: store.projects[0]!.id, providerId: 'echo', accountId: 'a-echo' });
    const visits = store.threads.filter(thread => !thread.archived && !thread.parentThreadId).slice(0, 6);
    expect(visits.length).toBe(6);
    for (const thread of visits) await store.open(thread.id);
    const returning = store.open(visits[0]!.id);
    expect(store.openThread!.id).toBe(visits[0]!.id);
    await returning;
  } finally { store.detach(); client.close(); }
});

test('a disclosure retrieves the real fake transport output and clears its preview marker', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client); await store.connect();
  try {
    await store.open('t-trace');
    const message = store.openThread!.messages.find(message => message.parts.some(part => part.type === 'tool' && part.output))!;
    const part = message.parts.find(part => part.type === 'tool' && part.output)!;
    if (part.type !== 'tool') throw new Error('fixture needs a completed tool');
    const output = part.output;
    part.output = 'preview'; part.outputDeferred = true;
    await store.loadToolOutput('t-trace', message.id, part.toolId);
    expect(part.output).toBe(output);
    expect(part.outputDeferred).toBeUndefined();
  } finally { store.detach(); client.close(); }
});

test('a tool disclosure shares its fetch and an obsolete result cannot fill another visit', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client); await store.connect();
  const call = client.call.bind(client);
  let release!: (value: { output: string }) => void;
  const gate = new Promise<{ output: string }>(resolve => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'messages.toolOutput' ? gate as never : call(method, params));
  try {
    await store.open('t-bench');
    const message = store.openThread!.messages.at(-1)!;
    message.parts.push({ type: 'tool', toolId: 'large', name: 'Bash', input: {}, output: 'preview', outputDeferred: true, status: 'done' });
    const one = store.loadToolOutput('t-bench', message.id, 'large');
    expect(store.loadToolOutput('t-bench', message.id, 'large')).toBe(one);
    await store.open('t-scheduler');
    release({ output: 'full output from the previous visit' }); await one;
    const returning = store.open('t-bench');
    expect(store.openThread!.messages.at(-1)!.parts.at(-1)).toMatchObject({ output: 'preview', outputDeferred: true });
    await returning;
  } finally { release({ output: '' }); spy.mockRestore(); store.detach(); client.close(); }
});

test('a return starts its own tool fetch while the previous visit is still loading', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client); await store.connect();
  const call = client.call.bind(client);
  let release!: (value: { output: string }) => void;
  const gate = new Promise<{ output: string }>(resolve => { release = resolve; });
  let asked = 0;
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'messages.toolOutput' ? (++asked === 1 ? gate : Promise.resolve({ output: 'current output' })) as never : call(method, params));
  let previous: Promise<void> | undefined;
  try {
    await store.open('t-trace');
    const id = store.openThread!.messages.find(message => message.parts.some(part => part.type === 'tool'))!.id;
    const preview = () => {
      const part = store.openThread!.messages.find(message => message.id === id)!.parts.find(part => part.type === 'tool')!;
      if (part.type !== 'tool') throw new Error('fixture needs a tool');
      part.output = 'preview'; part.outputDeferred = true;
      return part;
    };
    const old = preview();
    previous = store.loadToolOutput('t-trace', id, old.toolId);
    await store.open('t-bench');
    await store.open('t-trace');
    const current = preview();
    const loading = store.loadToolOutput('t-trace', id, current.toolId);
    expect(asked).toBe(2);
    await loading;
    release({ output: 'obsolete output' }); await previous;
    expect(current.output).toBe('current output');
  } finally { release({ output: '' }); await previous; spy.mockRestore(); store.detach(); client.close(); }
});

test('a same-thread refresh releases older paging and discards the previous response', async () => {
  const client = new FakeClient({ delayMs: 0, long: true });
  const store = new Store(); store.attach(client); await store.connect();
  const call = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'messages.list') await gate;
    return result;
  });
  let previous: Promise<number> | undefined;
  try {
    await store.open('t-long');
    previous = store.loadOlder();
    expect(store.loadingOlder).toBe(true);
    await store.open('t-long', false);
    expect(store.loadingOlder).toBe(false);
    release();
    expect(await previous).toBe(0);
    expect(store.openThread!.messages).toHaveLength(40);
    expect(await store.loadOlder()).toBe(120);
  } finally { release(); await previous; spy.mockRestore(); store.detach(); client.close(); }
});

test('a background refresh of the same visit preserves an in-flight tool disclosure', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client); await store.connect();
  await store.open('t-trace');
  const message = store.openThread!.messages.find(message => message.parts.some(part => part.type === 'tool' && part.output))!;
  const part = message.parts.find(part => part.type === 'tool' && part.output)!;
  if (part.type !== 'tool') throw new Error('fixture needs a completed tool');
  part.output = 'preview'; part.outputDeferred = true;
  const call = client.call.bind(client);
  let release!: (value: { output: string }) => void;
  const gate = new Promise<{ output: string }>(resolve => { release = resolve; });
  const spy = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'messages.toolOutput') return gate as never;
    const result = await call(method, params);
    if (method === 'threads.get') {
      const thread = result as import('@boite/contracts').Thread;
      const tool = thread.messages.find(row => row.id === message.id)?.parts.find(item => item.type === 'tool' && item.toolId === part.toolId);
      if (tool?.type === 'tool') { tool.output = 'preview'; tool.outputDeferred = true; }
    }
    return result;
  });
  let loading: Promise<void> | undefined;
  try {
    loading = store.loadToolOutput('t-trace', message.id, part.toolId);
    await store.open('t-trace', false);
    release({ output: 'complete disclosure' }); await loading;
    const tool = store.openThread!.messages.find(row => row.id === message.id)!.parts.find(item => item.type === 'tool' && item.toolId === part.toolId)!;
    expect(tool).toMatchObject({ output: 'complete disclosure' });
    expect(tool).not.toHaveProperty('outputDeferred');
  } finally { release({ output: '' }); await loading; spy.mockRestore(); store.detach(); client.close(); }
});

test('a cached disclosure can read its output from a core without the new tool method', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client); await store.connect();
  const call = client.call.bind(client);
  const spy = vi.spyOn(client, 'call').mockImplementation((method, params) => method === 'messages.toolOutput'
    ? Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'old core' })) : call(method, params));
  try {
    await store.open('t-trace');
    const message = store.openThread!.messages.find(message => message.parts.some(part => part.type === 'tool' && part.output))!;
    const part = message.parts.find(part => part.type === 'tool' && part.output)!;
    if (part.type !== 'tool') throw new Error('fixture needs a completed tool');
    const output = part.output;
    part.output = 'preview'; part.outputDeferred = true;
    await store.loadToolOutput('t-trace', message.id, part.toolId);
    expect(part.output).toBe(output);
    expect(part).not.toHaveProperty('outputDeferred');
    expect(spy.mock.calls.some(([method]) => method === 'messages.list' || method === 'threads.get')).toBe(true);
  } finally { spy.mockRestore(); store.detach(); client.close(); }
});
