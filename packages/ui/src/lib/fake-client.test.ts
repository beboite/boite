import { expect, vi } from 'vitest';
import { test } from '../test/fake-client';
import type { FakeClient } from './fake-client';
import { ATTACHMENT_MAX_BYTES, DEFAULT_DELEGATION_CONFIG, matchSpeed, speedName, speedRefusal, MESSAGE_PAGE_MAX_BYTES, MESSAGE_SENT_MAX_BYTES, RPC_MAX_FRAME_BYTES, RpcErrorCode, SPEECH_DEFAULT_MODEL, TODO_TEXT_MAX, type RpcEvents, type RpcMethodName, type Turn } from '@boite/contracts';
import { FAKE_AUTO_COMPACT_SETTLE_MS } from './fake-client/turns';
import { FakeContext } from './fake-client/context';
import { seed } from './fake-client/seed';
import { threadMethods } from './fake-client/threads';

test('done expiry mirrors the core while manual archives and restored history remain recoverable', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  expect((await client.call('settings.get', {})).threadDoneRetentionDays).toBe(3);
  const source = await client.call('threads.get', { threadId: 't-parser' });
  const thread = await client.call('threads.create', { projectId: source.projectId!, providerId: source.providerId, accountId: source.accountId, model: source.model ?? undefined });
  const done = await client.call('threads.archive', { threadId: thread.id, onlyIfIdle: true });
  expect(done.doneAt).toBeTypeOf('number');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(done.doneAt! + 4 * 86_400_000);
  try {
    await client.call('settings.set', { threadDoneRetentionDays: 0 });
    await client.sweepDoneThreads();
    expect((await client.call('threads.list', { includeArchived: true })).some(row => row.id === thread.id)).toBe(true);
    await client.call('settings.set', { threadDoneRetentionDays: 3 });
    await client.sweepDoneThreads();
    expect((await client.call('threads.list', { includeArchived: true })).some(row => row.id === thread.id)).toBe(false);
    expect((await client.call('threads.get', { threadId: 't-parser' })).archived).toBe(true);
    expect((await client.call('threads.deleted', {})).map(row => row.id)).toContain(thread.id);
    expect((await client.call('threads.restore', { threadId: thread.id })).doneAt).toBeNull();
    await client.sweepDoneThreads();
    expect((await client.call('threads.get', { threadId: thread.id })).archived).toBe(true);
  } finally { clock.mockRestore(); }
  for (const value of [-1, 0.5, 3651, null, '3']) {
    await expect(client.call('settings.set', { threadDoneRetentionDays: value as number }))
      .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field: 'threadDoneRetentionDays' } });
  }
});

test('banked resets refuse agent and paired transports before changing a supported account', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, quotaExtras: true });
  const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'codex' && account.status === 'ok')!;
  expect(account).toBeDefined();
  const updated: unknown[] = [];
  client.on('quotas.updated', event => updated.push(event));
  for (const principal of ['agent', 'session'] as const) {
    client.becomes(principal);
    await expect(client.call('quotas.reset', { accountId: account.id, confirmed: true })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  }
  client.becomes('owner');
  expect(updated).toEqual([]);
});

test('fake Claude creation discovers its native catalog before refusing an unlisted model', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'claude' && account.status === 'ok');
  expect(account).toBeDefined();
  const before = await client.call('threads.list', {});
  const discovered: RpcEvents['providers.probed'][] = [];
  client.on('providers.probed', event => discovered.push(event));
  await expect(client.call('threads.create', {
    projectId: 'p-boite', providerId: 'claude', accountId: account!.id, model: 'unlisted-native-model',
  })).rejects.toMatchObject({
    code: RpcErrorCode.Refused,
    message: 'the provider does not offer this model',
    data: { providerId: 'claude', accountId: account!.id, model: 'unlisted-native-model', expected: expect.any(Array) },
  });
  expect(discovered).toHaveLength(1);
  expect(discovered[0]).toMatchObject({ providerId: 'claude', accountId: account!.id });
  expect(discovered[0]!.models.length).toBeGreaterThan(0);
  expect(discovered[0]!.models.some(model => model.id === 'unlisted-native-model')).toBe(false);
  expect(await client.call('threads.list', {})).toEqual(before);
});

test('fake thread creation discovers a native model without a picker and still refuses an unlisted model', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'codex', accountId: 'a-codex',
    model: 'codex-demo', effort: 'high', speed: 'fast' });
  expect(thread).toMatchObject({ model: 'codex-demo', effort: 'high', speed: 'fast' });
  await expect(client.call('threads.update', { threadId: thread.id, model: 'missing-model' }))
    .rejects.toMatchObject({ code: RpcErrorCode.Refused, message: 'the provider does not offer this model', data: { model: 'missing-model' } });
  expect(await client.call('threads.get', { threadId: thread.id })).toMatchObject({ model: 'codex-demo', effort: 'high', speed: 'fast' });
});

test('fake thread updates discover native metadata for the selected account', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
  expect(await client.call('threads.update', { threadId: thread.id, accountId: 'a-codex', model: 'codex-demo', effort: 'high', speed: 'fast' }))
    .toMatchObject({ providerId: 'codex', accountId: 'a-codex', model: 'codex-demo', effort: 'high', speed: 'fast' });
});

test('fake byte-bounded pages walk complete escaped UTF-8 messages and fall back from a large reconnect tail', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', title: 'Byte pages' });
  await client.call('threads.subscribe', { threadId: thread.id });
  const expected: string[] = [];
  client.on('message.started', message => { if (message.threadId === thread.id) expected.push(message.id); });
  const prompt = '\u{1f600}\n"\\'.repeat(384 * 1024);
  for (let i = 0; i < 4; i++) {
    await client.call('turns.start', { threadId: thread.id, prompt });
    await client.settled();
  }
  const first = await client.call('threads.get', { threadId: thread.id, after: expected[0] });
  expect(new TextEncoder().encode(JSON.stringify(first.messages)).byteLength).toBeLessThanOrEqual(MESSAGE_PAGE_MAX_BYTES);
  expect(first.messagesFrom).toBeUndefined();
  const tail = await client.call('threads.get', { threadId: thread.id, after: expected.at(-1) });
  expect(tail.messagesFrom).toBe(expected.at(-1));
  expect(tail.messages).toHaveLength(1);
  const walked = first.messages.map(message => message.id);
  let before = first.messagesBefore;
  let pages = 1;
  while (before !== null) {
    const page = await client.call('messages.list', { threadId: thread.id, before });
    expect(new TextEncoder().encode(JSON.stringify(page.messages)).byteLength).toBeLessThanOrEqual(MESSAGE_PAGE_MAX_BYTES);
    expect(page.messages.length).toBeGreaterThan(0);
    for (const message of page.messages.filter(message => message.role === 'user')) {
      expect(message.parts[0]?.type === 'text' && message.parts[0].text === prompt).toBe(true);
    }
    walked.unshift(...page.messages.map(message => message.id));
    before = page.before;
    expect(++pages).toBeLessThan(10);
  }
  expect(walked).toEqual(expected);
  expect(pages).toBeGreaterThan(1);

  // A saved position combines two independently bounded halves. The result
  // must share their budget, and loading its newer cursor must do the same.
  expect(expected).toHaveLength(8);
  const around = await client.call('threads.get', { threadId: thread.id, around: expected[3], limit: 4 });
  expect(around.messages.map(message => message.id)).toContain(expected[3]);
  expect(new TextEncoder().encode(JSON.stringify(around.messages)).byteLength).toBeLessThanOrEqual(MESSAGE_PAGE_MAX_BYTES);
  const window = around.messages.map(message => message.id);
  pages = 0;
  for (let before = around.messagesBefore; before;) {
    const page = await client.call('messages.list', { threadId: thread.id, before, limit: 4 });
    expect(page.messages.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(page.messages)).byteLength).toBeLessThanOrEqual(MESSAGE_PAGE_MAX_BYTES);
    expect(page.before).not.toBe(before);
    expect(++pages).toBeLessThan(10);
    window.unshift(...page.messages.map(message => message.id));
    before = page.before;
  }
  for (let after = around.messagesAfter; after;) {
    const page = await client.call('messages.list', { threadId: thread.id, after, limit: 4 });
    expect(page.messages.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(page.messages)).byteLength).toBeLessThanOrEqual(MESSAGE_PAGE_MAX_BYTES);
    expect(page.after).not.toBe(after);
    expect(++pages).toBeLessThan(10);
    window.push(...page.messages.map(message => message.id));
    after = page.after ?? undefined;
  }
  expect(window).toEqual(expected);
  const single = await client.call('threads.get', { threadId: thread.id, around: expected[3], limit: 1 });
  expect(single.messages.map(message => message.id)).toEqual([expected[3]]);
  expect(single.messagesBefore).toBe(expected[3]);
  expect(single.messagesAfter).toBe(expected[3]);
});

test('fake history refuses an oversized next message before the page byte boundary, like the core', async () => {
  const ctx = new FakeContext({ delayMs: 0 });
  seed(ctx);
  const thread = ctx.thread('t-parser');
  const base = thread.messages[0]!;
  thread.turns = [];
  const part = (id: string, text: string) => ({ ...base, id, parts: [{ type: 'text' as const, text }] });
  const cursor = part('cursor', 'cursor');
  const small = part('small', 'x'.repeat(7 * 1024 * 1024));
  const oversized = part('oversized', 'x'.repeat(RPC_MAX_FRAME_BYTES));
  const methods = threadMethods(ctx);
  thread.messages = [cursor, small, oversized];
  await expect(methods['messages.list']({ threadId: thread.id, after: cursor.id, limit: 2 }).then(() => null, error => error))
    .resolves.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'messages', messageId: oversized.id } });
  thread.messages = [oversized, small, cursor];
  await expect(methods['messages.list']({ threadId: thread.id, before: cursor.id, limit: 2 }).then(() => null, error => error))
    .resolves.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'messages', messageId: oversized.id } });
});

test('fake pages keep a complete legal attachment bundle above the byte budget and refuse an oversized message', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', title: 'Single message' });
  await client.call('turns.start', { threadId: thread.id, prompt: 'Before the bundle' });
  await client.settled();
  const prefix = await client.call('threads.get', { threadId: thread.id });
  const data = 'A'.repeat(Math.ceil(5 * 1024 * 1024 / 3) * 4 - 1) + '=';
  await client.call('turns.start', { threadId: thread.id, prompt: 'Review the bundle', attachments: ['first.bin', 'second.bin'].map(name => ({ kind: 'file', name, mimeType: 'application/octet-stream', data })) });
  await client.settled();
  const newest = await client.call('threads.get', { threadId: thread.id });
  expect(newest.messagesBefore).not.toBeNull();
  const page = await client.call('messages.list', { threadId: thread.id, before: newest.messagesBefore! });
  expect(page.messages).toHaveLength(1);
  const bytes = new TextEncoder().encode(JSON.stringify(page.messages)).byteLength;
  expect(bytes).toBeGreaterThan(MESSAGE_PAGE_MAX_BYTES);
  expect(bytes).toBeLessThan(RPC_MAX_FRAME_BYTES);
  expect(page.before).toBe(page.messages[0]!.id);
  const older = await client.call('messages.list', { threadId: thread.id, before: page.before! });
  expect(older.messages.map(message => message.id)).toEqual(prefix.messages.map(message => message.id));
  expect(older.before).toBeNull();
  expect(page.messages[0]?.parts.filter(part => part.type === 'file').every(part => part.data === data)).toBe(true);
  for (let index = 0; index < 4; index++) {
    await client.call('turns.start', { threadId: thread.id, prompt: `After the bundle ${index}` });
    await client.settled();
  }
  const anchor = page.messages[0]!.id;
  const centred = await client.call('threads.get', { threadId: thread.id, around: anchor, limit: 4 });
  expect(centred.messages.map(message => message.id)).toEqual([anchor]);
  expect(centred.messages[0]!.parts).toEqual(page.messages[0]!.parts);
  expect(centred.messagesBefore).toBe(anchor);
  expect(centred.messagesAfter).toBe(anchor);
  await client.call('turns.start', { threadId: thread.id, prompt: 'x'.repeat(RPC_MAX_FRAME_BYTES) });
  await client.settled();
  await expect(client.call('threads.get', { threadId: thread.id })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'messages', expected: `a complete message below ${RPC_MAX_FRAME_BYTES} serialized UTF-8 bytes` } });
  // A client that sends `compactToolParts` reads the same thread, the prompt cut and saying so.
  const latest = await client.call('threads.get', { threadId: thread.id, compactToolParts: true, limit: 1 });
  const light = await client.call('messages.list', { threadId: thread.id, before: latest.messagesBefore!, limit: 1, compactToolParts: true });
  const prompt = light.messages.find(message => message.role === 'user' && message.parts.some(part => part.type === 'text' && part.omitted))!;
  const text = prompt.parts.find(part => part.type === 'text')!;
  expect(text.type === 'text' && text.text.length + text.omitted! === RPC_MAX_FRAME_BYTES).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(prompt)).byteLength).toBeLessThan(MESSAGE_SENT_MAX_BYTES);
});

test('fake paging refuses oversized response metadata even when its messages fit the page budget', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', title: 'Metadata guard' });
  client.emitMemory({ threadId: thread.id, at: 1, state: 'ok', kind: 'budget', exe: 'x'.repeat(RPC_MAX_FRAME_BYTES) });
  let failure: unknown;
  try { await client.call('threads.get', { threadId: thread.id }); } catch (error) { failure = error; }
  expect((failure as { code?: number } | undefined)?.code).toBe(RpcErrorCode.Refused);
  expect(failure).toMatchObject({ data: { field: 'response', max: RPC_MAX_FRAME_BYTES,
    expected: `a complete RPC response at most ${RPC_MAX_FRAME_BYTES} serialized UTF-8 bytes` } });
});

test('moving a fake thread drops PR metadata from its previous branch', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  expect((await client.call('threads.pullRequest', { threadId: 't-trace' }))?.number).toBe(84);
  const moved = await client.call('threads.move', { threadId: 't-trace', projectId: 'p-notes' });
  expect(moved.branch).not.toBeNull();
  expect(await client.call('threads.pullRequest', { threadId: moved.id })).toBeNull();
  const drafts = await client.call('projects.drafts', {});
  expect((await client.call('threads.move', { threadId: moved.id, projectId: drafts.id })).branch).toBeNull();
  expect(await client.call('threads.pullRequest', { threadId: moved.id })).toBeNull();
});

test('rewinding a live follow-up keeps the turn belonging to earlier messages', async ({ createClient }) => {
  const client = await createClient({ delayMs: 5 });
  const original = { threadId: 't-trace', prompt: '[tools] Keep reading', clientRequestId: 'rewind_original' };
  const turn = await client.call('turns.start', original);
  const kept = { threadId: 't-trace', turnId: turn.id, prompt: 'Keep this instruction', clientRequestId: 'rewind_kept_input' };
  expect(await client.call('turns.steer', kept)).toEqual({ accepted: true });
  const params = { threadId: 't-trace', turnId: turn.id, prompt: 'Change direction', clientRequestId: 'rewind_follow_up' };
  expect(await client.call('turns.steer', params)).toEqual({ accepted: true });
  await client.settled();
  const target = (await client.call('threads.get', { threadId: 't-trace' })).messages.at(-1)!;
  const rewound = await client.call('threads.rewind', { threadId: 't-trace', messageId: target.id });
  expect(rewound.thread.turns.some(item => item.id === turn.id)).toBe(true);
  expect(rewound.thread.messages.filter(message => message.role === 'user' && message.turnId === turn.id)).toHaveLength(2);
  expect((await client.call('turns.start', original)).id).toBe(turn.id);
  expect(await client.call('turns.steer', kept)).toEqual({ accepted: true });
  await expect(client.call('turns.start', { ...original, prompt: 'Different input' })).rejects.toThrow('different content');
  const retained = await client.call('threads.get', { threadId: 't-trace' });
  expect(retained.turns.filter(item => item.id === turn.id)).toHaveLength(1);
  expect(retained.messages.filter(message => message.role === 'user' && message.turnId === turn.id)).toHaveLength(2);
  // As on the core, the receipt for the removed input no longer acknowledges it.
  expect(await client.call('turns.steer', params)).toEqual({ accepted: false });
  const prompt = retained.messages.find(message => message.role === 'user' && message.turnId === turn.id)!;
  await client.call('threads.rewind', { threadId: 't-trace', messageId: prompt.id });
  expect((await client.call('turns.start', original)).id).not.toBe(turn.id);
  await client.settled();
});

test('fake agent receives selected element context while the visible prompt stays compact', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const prompt = 'Change @Save';
  const reference = { id: 'save', url: 'https://example.test/settings', selector: '#save', text: 'Save', bounds: { x: 0, y: 0, width: 30, height: 20 }, mention: { start: 7, end: 12 } };
  const turn = await client.call('turns.start', { threadId: 't-trace', prompt, previewReferences: [reference] });
  await client.settled();
  const messages = (await client.call('threads.get', { threadId: 't-trace' })).messages.filter(message => message.turnId === turn.id);
  expect(messages.find(message => message.role === 'user')?.parts[0]).toMatchObject({ displayText: prompt, previewReferences: [reference] });
  const reply = messages.filter(message => message.role === 'assistant').flatMap(message => message.parts).filter(part => part.type === 'text').map(part => part.text).join('');
  expect(reply).toContain(reference.url);
  expect(reply).toContain(reference.selector);
  expect(reply).toContain('untrusted page data');
});

test.for(['question', '[permission]', '[tool]', '[tool-stream]', '[diff]', '[doc]', '[image]', '[spawn:fixture]'])('selected page data cannot activate the fake control marker %s', async (marker, { createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await client.call('threads.subscribe', { threadId: 't-trace' });
  const requested: unknown[] = [];
  client.on('question.asked', event => requested.push(event));
  client.on('permission.requested', event => requested.push(event));
  client.on('process.started', event => requested.push(event));
  const reference = { id: 'page', url: 'https://example.test', selector: '#page', text: marker, bounds: { x: 0, y: 0, width: 30, height: 20 } };
  const turn = await client.call('turns.start', { threadId: 't-trace', prompt: 'Review this element', previewReferences: [reference] });
  await vi.waitFor(async () => {
    expect((await client.call('threads.get', { threadId: 't-trace' })).turns.find(entry => entry.id === turn.id)?.status).toBe('done');
  }, { timeout: 500 });
  const parts = (await client.call('threads.get', { threadId: 't-trace' })).messages.filter(message => message.turnId === turn.id && message.role === 'assistant').flatMap(message => message.parts);
  expect(parts.filter(part => part.type !== 'text' && part.type !== 'thinking')).toEqual([]);
  expect(parts.filter(part => part.type === 'text').map(part => part.text).join('')).toContain(marker);
  expect(requested).toEqual([]);
});

test('fake process events reach a client subscribed to that thread only, like the core', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const seen: string[] = [];
  client.on('process.started', event => seen.push(`started ${event.threadId}`));
  client.on('process.exited', event => seen.push(`exited ${event.threadId}`));
  const run = async () => {
    const turn = await client.call('turns.start', { threadId: 't-trace', prompt: '[spawn:fixture]' });
    await vi.waitFor(async () => {
      expect((await client.call('threads.get', { threadId: 't-trace' })).turns.find(entry => entry.id === turn.id)?.status).toBe('done');
    }, { timeout: 500 });
  };
  await run();
  expect(seen).toEqual([]);
  await client.call('threads.subscribe', { threadId: 't-trace' });
  await run();
  expect(seen).toEqual(['started t-trace', 'exited t-trace']);
});

test('fake resources.list carries only threads running something now, like the core', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const resources = await client.call('resources.list', {});
  // t-trace only ran processes that exited: its history is in trace.get, not here.
  expect((await client.call('trace.get', { threadId: 't-trace' })).length).toBeGreaterThan(0);
  expect(resources.map(entry => entry.threadId)).not.toContain('t-trace');
  for (const entry of resources) {
    expect(entry.live.length).toBeGreaterThan(0);
    expect(entry.live.every(record => record.exitedAt === null)).toBe(true);
    expect(entry.load.processes).toBeGreaterThan(0);
  }
  // A turn can settle while its API-started processes keep running.
  const [question] = await client.call('questions.list', { threadId: 't-scheduler' });
  await client.call('questions.skip', { threadId: 't-scheduler', questionId: question!.id });
  expect((await client.call('threads.get', { threadId: 't-scheduler' })).status).toBe('idle');
  const live = (await client.call('trace.get', { threadId: 't-scheduler' })).filter(record => record.exitedAt === null);
  expect(live).toHaveLength(2);
  const unrelatedHistory = await client.call('trace.get', { threadId: 't-trace' });
  await client.call('threads.subscribe', { threadId: 't-scheduler' });
  const exits: number[] = [];
  client.on('process.exited', record => exits.push(record.pid));
  await client.call('delegation.configure', { threadId: 't-scheduler', config: {
    ...DEFAULT_DELEGATION_CONFIG, enabled: true,
    profiles: [{ id: 'echo', name: 'Echo', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null }]
  } });
  const child = await client.call('delegation.spawn', { threadId: 't-scheduler', profileId: 'echo', task: '[permission]', requestId: 'archive-child' });
  const unrelated = await client.call('turns.start', { threadId: 't-descriptors', prompt: '[permission]' });
  await vi.waitFor(async () => {
    expect((await client.call('threads.get', { threadId: child.thread.id })).status).toBe('waiting');
    expect((await client.call('threads.get', { threadId: unrelated.threadId })).status).toBe('waiting');
  });
  await client.call('threads.archive', { threadId: 't-scheduler' });
  expect((await client.call('resources.list', {})).some(entry => entry.threadId === 't-scheduler')).toBe(false);
  expect((await client.call('trace.get', { threadId: 't-scheduler' })).every(record => record.exitedAt !== null)).toBe(true);
  expect(exits.sort()).toEqual(live.map(record => record.pid).sort());
  expect((await client.call('threads.get', { threadId: child.thread.id })).turns.at(-1)?.status).toBe('stopped');
  expect((await client.call('threads.get', { threadId: unrelated.threadId })).turns.at(-1)?.status).toBe('running');
  expect(await client.call('trace.get', { threadId: 't-trace' })).toEqual(unrelatedHistory);
  await client.call('threads.archive', { threadId: 't-scheduler', archived: false });
  expect(exits).toHaveLength(2);
  expect((await client.call('trace.get', { threadId: 't-scheduler' })).every(record => record.exitedAt !== null)).toBe(true);
});

test('fake artifacts refuse publication if the thread is archived during the media read', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  let finish!: (bytes: ArrayBuffer) => void;
  const response = new Response();
  const read = vi.spyOn(response, 'arrayBuffer').mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const fetchMedia = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  try {
    await client.call('threads.subscribe', { threadId: 't-trace' });
    const before = await client.call('threads.get', { threadId: 't-trace' });
    const messages: unknown[] = [];
    client.on('message.started', message => messages.push(message));
    client.on('message.completed', message => messages.push(message));
    const pending = client.call('artifacts.publish', { threadId: 't-trace', path: 'assets/handbook.pdf' });
    const refused = expect(pending).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await client.call('threads.archive', { threadId: 't-trace' });
    finish(new ArrayBuffer(4));
    await refused;
    expect((await client.call('threads.get', { threadId: 't-trace' })).messages).toEqual(before.messages);
    expect(messages).toEqual([]);
  } finally { fetchMedia.mockRestore(); read.mockRestore(); }
});

test('fake HTML artifacts open through the same RPC and owner events as real previews', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await client.call('threads.subscribe', { threadId: 't-trace' });
  await client.call('files.write', { threadId: 't-trace', path: 'demo.html', text: '<h1>Preview</h1>' });
  const seen: unknown[] = [];
  client.on('panel.requested', value => seen.push(value));
  const result = await client.call('artifacts.preview', { threadId: 't-trace', path: 'demo.html' });
  expect(result.shown).toBe(true);
  expect(seen).toContainEqual(expect.objectContaining({ threadId: 't-trace', surface: { kind: 'browser', url: result.url } }));
  await expect(client.call('artifacts.preview', { threadId: 't-trace', path: '../outside.html' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  expect(await client.call('artifacts.previewClose', { threadId: 't-trace', path: 'demo.html' })).toEqual({ ok: true });
});

test('fake streamed artifacts keep immutable message-scoped snapshots and release their object URLs on close', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const OriginalURL = URL;
  const createObjectURL = vi.fn((_object: Blob | MediaSource) => 'blob:fake-streamed-artifact');
  const revokeObjectURL = vi.fn((_url: string) => {});
  vi.stubGlobal('URL', class extends OriginalURL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
  try {
    const path = 'large-artifact.txt';
    const bytes = ATTACHMENT_MAX_BYTES + 1;
    await client.call('files.write', { threadId: 't-trace', path, text: 'x'.repeat(bytes) });
    const message = await client.call('artifacts.publish', { threadId: 't-trace', path });
    const artifact = message.parts[0]!;
    expect(artifact).toMatchObject({ type: 'artifact', name: path, bytes });
    if (artifact.type !== 'artifact') throw new Error('expected a streamed artifact above the attachment limit');
    expect(artifact).not.toHaveProperty('data');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0]![0]).toMatchObject({ size: bytes });
    const params = { threadId: 't-trace', messageId: message.id, artifactId: artifact.id };
    const original = await client.call('artifacts.read', params);
    expect(original).toMatchObject({ name: path, bytes, url: 'blob:fake-streamed-artifact' });
    await client.call('files.write', { threadId: 't-trace', path, text: 'replacement' });
    expect(await client.call('artifacts.read', params)).toEqual(original);
    await expect(client.call('artifacts.read', { ...params, threadId: 't-descriptors' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(client.call('artifacts.read', { ...params, messageId: 'missing-message' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    client.close();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(original.url);
  } finally {
    client.close();
    vi.stubGlobal('URL', OriginalURL);
  }
});

test('fake inline views store the page with its bootstrap and open only for a view read', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const OriginalURL = URL;
  const createObjectURL = vi.fn((_object: Blob | MediaSource) => 'blob:fake-view');
  vi.stubGlobal('URL', class extends OriginalURL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = () => {};
  });
  try {
    await client.call('files.write', { threadId: 't-trace', path: 'orbit.html', text: '<title>Orbit</title><svg viewBox="0 0 10 10"></svg>' });
    const { message, checked } = await client.call('artifacts.view', { threadId: 't-trace', path: 'orbit.html' });
    expect(checked).toBe(false);
    const part = message.parts[0]!;
    if (part.type !== 'artifact') throw new Error('expected an artifact part');
    expect(part).toMatchObject({ name: 'orbit.html', mimeType: 'text/html', view: { title: 'Orbit', height: 320, source: 'orbit.html' } });
    const stored = await (createObjectURL.mock.calls[0]![0] as Blob).text();
    expect(stored).toContain('boite-view-theme');
    expect(stored).toContain('<svg viewBox="0 0 10 10">');
    const ids = { threadId: 't-trace', messageId: message.id, artifactId: part.id };
    expect(await client.call('artifacts.read', { ...ids, view: true })).toMatchObject({ url: 'blob:fake-view', name: 'orbit.html' });

    await client.call('files.write', { threadId: 't-trace', path: 'remote.html', text: '<script src="https://cdn.example.com/chart.js"></script>' });
    await expect(client.call('artifacts.view', { threadId: 't-trace', path: 'remote.html' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, message: expect.stringContaining('https://cdn.example.com/chart.js is remote') });
    await client.call('files.write', { threadId: 't-trace', path: 'notes.md', text: '# no' });
    await expect(client.call('artifacts.view', { threadId: 't-trace', path: 'notes.md' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    const path = 'large-plain.txt';
    await client.call('files.write', { threadId: 't-trace', path, text: 'x'.repeat(ATTACHMENT_MAX_BYTES + 1) });
    const file = await client.call('artifacts.publish', { threadId: 't-trace', path });
    const plain = file.parts[0]!;
    if (plain.type !== 'artifact') throw new Error('expected a streamed artifact');
    await expect(client.call('artifacts.read', { threadId: 't-trace', messageId: file.id, artifactId: plain.id, view: true })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  } finally {
    client.close();
    vi.stubGlobal('URL', OriginalURL);
  }
});

test('fake delegation enforces family access and keeps request IDs idempotent', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const config = {
    ...DEFAULT_DELEGATION_CONFIG,
    enabled: true,
    profiles: [{ id: 'echo', name: 'Echo reviewer', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null }]
  };
  await client.call('delegation.configure', { threadId: 't-trace', config });
  const params = { threadId: 't-trace', profileId: 'echo', task: 'Review the boundary', requestId: 'spawn-1' };
  const first = await client.call('delegation.spawn', params);
  const repeated = await client.call('delegation.spawn', params);
  // Execution can advance between idempotent reads; every durable field still agrees.
  const { progress: _firstProgress, ...firstThread } = first.thread;
  const { progress: _repeatedProgress, ...repeatedThread } = repeated.thread;
  expect({ ...repeated, thread: repeatedThread }).toEqual({ ...first, thread: firstThread });
  expect(first.thread.parentThreadId).toBe('t-trace');
  await expect(client.call('delegation.spawn', { ...params, task: 'Different work' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });


  const sent = await client.call('delegation.send', { threadId: 't-trace', toThreadId: first.thread.id, text: 'Report file names', requestId: 'send-1' });
  expect(sent.origin).toBe('user');
  expect(await client.call('delegation.send', { threadId: 't-trace', toThreadId: first.thread.id, text: 'Report file names', requestId: 'send-1' })).toEqual(sent);
  const childView = await client.call('delegation.get', { threadId: first.thread.id });
  expect(childView.agents.map(agent => agent.thread.id)).toEqual([first.thread.id]);
  expect(childView.messages.every(letter => letter.from.threadId === first.thread.id || letter.to.threadId === first.thread.id)).toBe(true);
  await expect(client.call('delegation.spawn', { ...params, threadId: first.thread.id, requestId: 'nested' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
});

test('fake delegation gives a child a speed only when asked, by id or label, with the core\'s refusals', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  // The parent runs fast on a model the agent listed; reading it is what fills the catalog.
  const parent = await client.call('threads.create', { projectId: 'p-boite', providerId: 'codex', accountId: 'a-codex', model: 'codex-demo', effort: 'high', speed: 'fast' });
  expect(parent.speed).toBe('fast');
  const threadId = parent.id;
  const models = await client.call('delegation.models', { threadId });
  expect(models.choices.find(choice => choice.model === 'codex-demo')?.speeds).toEqual([{ id: 'fast', label: 'Fast' }, { id: 'ultrafast', label: 'Ultrafast' }]);
  expect(models.choices.find(choice => choice.providerId === 'echo')?.speeds).toEqual([]);
  const speedOf = async (params: { model?: string; speed?: string }, requestId: string) =>
    (await client.call('delegation.spawn', { threadId, task: `Play ${requestId}`, requestId, ...params })).thread.speed ?? null;
  expect(await speedOf({ model: 'codex/codex-demo', speed: 'ULTRAFAST' }, 'label')).toBe('ultrafast');
  expect(await speedOf({ model: 'codex/codex-demo', speed: 'fast' }, 'id')).toBe('fast');
  expect(await speedOf({ speed: 'Fast' }, 'own')).toBe('fast');
  expect(await speedOf({}, 'own-none')).toBeNull();
  expect(await speedOf({ model: 'codex/codex-demo' }, 'none')).toBeNull();
  const echo = models.choices.find(choice => choice.providerId === 'echo')!;
  await expect(client.call('delegation.spawn', { threadId, model: `echo/${echo.model}`, speed: 'fast', task: 'No tier', requestId: 'no-tier' }))
    .rejects.toMatchObject({ code: RpcErrorCode.Refused, message: `speed: echo/${echo.model} offers no speed tier; leave speed out` });
  await expect(client.call('delegation.spawn', { threadId, model: 'codex/codex-demo', speed: ' turbo ', task: 'Bad tier', requestId: 'bad-tier' }))
    .rejects.toMatchObject({ code: RpcErrorCode.Refused, message: 'speed: codex/codex-demo has no "turbo" tier; expected fast, ultrafast' });
  // The core bounds a speed before it reads any model: the same code and words here.
  for (const [speed, requestId] of [[' ', 'blank'], ['f'.repeat(65), 'long']] as const) {
    await expect(client.call('delegation.spawn', { threadId, model: 'codex/codex-demo', speed, task: 'Bad text', requestId }))
      .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'speed: expected 1 to 64 characters' });
  }
  await expect(client.call('delegation.spawn', { threadId, model: 'codex/codex-demo', task: 'Play id', requestId: 'id' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
});

test('fake delegation reads an agent\'s speed tiers before it checks one, and a workflow step keeps its tier', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  // Nothing read Codex's own list yet: its demo model and tiers exist only once a probe ran.
  const before = await client.call('delegation.models', { threadId: 't-trace' });
  expect(before.choices.some(choice => choice.model === 'codex-demo')).toBe(false);
  const child = await client.call('delegation.spawn', { threadId: 't-trace', model: 'codex/codex-demo', speed: 'Ultrafast', task: 'Play unread', requestId: 'unread' });
  expect([child.thread.providerId, child.thread.model, child.thread.speed]).toEqual(['codex', 'codex-demo', 'ultrafast']);

  const bad = { name: 'Bad', steps: [{ id: 'play', model: 'codex/codex-demo', speed: 'turbo', task: 'Play.' }] };
  await expect(client.call('workflows.check', { threadId: 't-trace', plan: bad }))
    .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'steps[0] (play): speed: codex/codex-demo has no "turbo" tier; expected fast, ultrafast' });
  await expect(client.call('workflows.start', { threadId: 't-trace', requestId: 'bad-speed', plan: bad })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
  const run = await client.call('workflows.start', { threadId: 't-trace', requestId: 'speeds', plan: { name: 'Speeds', steps: [
    { id: 'quick', model: 'codex/codex-demo', speed: ' Ultrafast ', task: 'Play quickly.' },
    { id: 'plain', task: 'Play again.' },
  ] } });
  // The run stores the tier id, as the core does.
  expect(run.plan.steps.map(step => step.speed ?? null)).toEqual(['ultrafast', null]);
  const [quick, plain] = run.nodes.map(node => node.instances[0]!);
  expect([quick!.providerId, quick!.model, quick!.speed]).toEqual(['codex', 'codex-demo', 'ultrafast']);
  expect((await client.call('threads.get', { threadId: quick!.threadId! })).speed).toBe('ultrafast');
  expect((await client.call('threads.get', { threadId: plain!.threadId! })).speed ?? null).toBeNull();
});

test('a speed is matched by id or label in any case, and a refusal names what the model offers', () => {
  const codex = [{ id: 'priority', label: 'Fast' }];
  expect(matchSpeed(codex, 'fast')).toBe('priority');
  expect(matchSpeed(codex, ' Priority ')).toBe('priority');
  expect(matchSpeed([{ id: 'fast', label: 'Fast' }], 'FAST')).toBe('fast');
  // An id wins over another tier's label.
  expect(matchSpeed([{ id: 'priority', label: 'Fast' }, { id: 'fast', label: 'Faster' }], 'fast')).toBe('fast');
  expect(matchSpeed(codex, 'turbo')).toBeNull();
  // Whatever a transport or an older core hands over is no match, never a throw.
  for (const wanted of ['', '   ', 123, null, undefined, { id: 'priority' }]) expect(matchSpeed(codex, wanted)).toBeNull();
  for (const speeds of [undefined, null, []]) expect(matchSpeed(speeds, 'fast')).toBeNull();
  expect(speedName({ id: 'priority', label: 'Fast' })).toBe('Fast (priority)');
  expect(speedName({ id: 'fast', label: 'Fast' })).toBe('fast');
  expect(speedRefusal('codex/gpt-6-luna', codex, ' turbo ')).toBe('speed: codex/gpt-6-luna has no "turbo" tier; expected Fast (priority)');
  for (const speeds of [[], undefined, null]) expect(speedRefusal('claude/haiku', speeds, 'fast')).toBe('speed: claude/haiku offers no speed tier; leave speed out');
});

test('fake agent.spawn starts a real thread marked at both ends and keeps retries idempotent', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const caller = await client.call('threads.get', { threadId: 't-descriptors' });
  const target = (await client.call('agent.projects', { threadId: caller.id })).find(p => !p.current)!;
  const params = { threadId: caller.id, project: target.name.toUpperCase(), prompt: 'Check the build\nthen report', requestId: 'spawn-1' };
  const spawned = await client.call('agent.spawn', params);
  expect(await client.call('agent.spawn', params)).toEqual(spawned);
  expect(spawned.thread).toMatchObject({ projectId: target.id, title: 'Check the build', providerId: caller.providerId, permissionMode: caller.permissionMode });
  expect(spawned.thread.parentThreadId ?? null).toBeNull();
  const opened = await client.call('threads.get', { threadId: spawned.thread.id });
  expect(opened.messages.find(m => m.role === 'user')?.parts[0]).toMatchObject({ displayText: 'Check the build\nthen report', startedBy: { threadId: caller.id } });
  const back = await client.call('threads.get', { threadId: caller.id });
  expect(back.messages.at(-1)?.parts[0]).toMatchObject({ started: { threadId: spawned.thread.id, project: target.name } });
  await expect(client.call('agent.spawn', { ...params, requestId: 'spawn-2', project: 'nowhere' })).rejects.toMatchObject({ code: RpcErrorCode.NotFound, data: { field: 'project' } });
  await client.call('threads.archive', { threadId: caller.id });
  await expect.soft(client.call('agent.spawn', { ...params, requestId: 'archived-spawn' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, message: 'an archived thread cannot start threads', data: { field: 'threadId' } });
  await client.call('threads.archive', { threadId: caller.id, archived: false });
  const concurrent = { ...params, requestId: 'concurrent-spawn' };
  const [one, repeated] = await Promise.all([client.call('agent.spawn', concurrent), client.call('agent.spawn', concurrent)]);
  expect.soft(repeated.thread.id).toBe(one.thread.id);
  expect.soft(repeated.turnId).toBe(one.turnId);
  await expect.soft(client.call('agent.spawn', { ...params, prompt: 'Changed retry content' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'requestId' } });
  for (let index = 0; index < 4; index++) {
    await expect.soft(client.call('agent.spawn', { ...params, requestId: `unlimited-${index}`, prompt: `Brief ${index}` })).resolves.toMatchObject({ thread: { projectId: target.id } });
  }
  const beforeArchive = (await client.call('threads.list', { includeArchived: true })).length;
  const refused = client.call('agent.spawn', { ...params, requestId: 'archive-before-create' }).catch((error: unknown) => error);
  await client.call('threads.archive', { threadId: caller.id });
  expect(await refused).toMatchObject({ code: RpcErrorCode.Refused, message: 'an archived thread cannot start threads' });
  expect(await client.call('threads.list', { includeArchived: true })).toHaveLength(beforeArchive);
});

test('fake agent.addProject registers a folder once, with a line in the caller, and refuses a relative one', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const threadId = 't-descriptors';
  const seen: string[] = [];
  client.on('project.added', project => { seen.push(project.path); });
  const added = await client.call('agent.addProject', { threadId, path: '/workspace/site', name: 'Website' });
  expect(added).toMatchObject({ name: 'Website', path: '/workspace/site', current: false, added: true });
  expect(await client.call('agent.addProject', { threadId, path: '/workspace/site' })).toMatchObject({ id: added.id, name: 'Website', added: false });
  expect(seen).toEqual(['/workspace/site']);
  expect((await client.call('agent.projects', { threadId })).map(p => p.id)).toContain(added.id);
  const back = await client.call('threads.get', { threadId });
  expect(back.messages.at(-1)).toMatchObject({ role: 'system', parts: [{ text: 'The agent added the project Website (/workspace/site).' }] });
  await expect(client.call('agent.addProject', { threadId, path: 'site' })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
});

test('paired fake clients can inspect, message and stop delegation but cannot configure or spawn', async ({ createClient }) => {
  const phone = await createClient({ delayMs: 0, principal: 'session', delegationDemo: true });
  const view = await phone.call('delegation.get', { threadId: 't-trace' });
  expect(view.agents).toHaveLength(2);
  await expect(phone.call('delegation.configure', { threadId: 't-trace', config: view.config })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(phone.call('delegation.spawn', { threadId: 't-trace', profileId: 'reviewer', task: 'No', requestId: 'phone-spawn' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(phone.call('delegation.send', { threadId: 't-trace', toThreadId: view.agents[0]!.thread.id, text: 'Status?', requestId: 'phone-send' })).resolves.toMatchObject({ origin: 'user' });
  await expect(phone.call('delegation.stop', { threadId: 't-trace', agentId: view.agents[0]!.thread.id })).resolves.toMatchObject({ stopped: 1 });
});

test('fake delegation starts independent children together and returns current idempotent state', async ({ createClient }) => {
  const client = await createClient({ delayMs: 2 });
  const config = {
    ...DEFAULT_DELEGATION_CONFIG, enabled: true, maxAgents: 3, maxConcurrent: 1, maxTurns: 4,
    profiles: [{ id: 'echo', name: 'Echo reviewer', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null }]
  };
  await client.call('delegation.configure', { threadId: 't-trace', config });
  const firstParams = { threadId: 't-trace', profileId: 'echo', task: `First ${'a'.repeat(240)}`, requestId: 'spawn-first' };
  const first = await client.call('delegation.spawn', firstParams);
  const second = await client.call('delegation.spawn', { threadId: 't-trace', profileId: 'echo', task: 'Second parallel task', requestId: 'spawn-second' });
  expect(first.lastTurn?.status).toBe('running');
  expect(second.lastTurn?.status).toBe('running');
  const secondTurnId = second.lastTurn!.id;

  await vi.waitFor(async () => {
    const view = await client.call('delegation.get', { threadId: 't-trace' });
    expect(view.agents.find(agent => agent.thread.id === second.thread.id)?.lastTurn?.status).toBe('done');
  }, { timeout: 3000 });
  const view = await client.call('delegation.get', { threadId: 't-trace' });
  expect(view.agents.find(agent => agent.thread.id === second.thread.id)?.lastTurn?.id).toBe(secondTurnId);
  expect(view.turnsUsed).toBe(2);
  const retried = await client.call('delegation.spawn', firstParams);
  expect(retried.thread.status).toBe('idle');
  expect(retried.result).toContain('First');
  const results = view.messages.filter(letter => letter.origin === 'result');
  expect(results).toHaveLength(2);
  expect(results.every(letter => letter.expiresAt === Number.MAX_SAFE_INTEGER)).toBe(true);

  const childView = await client.call('delegation.get', { threadId: first.thread.id });
  expect(childView.agents).toHaveLength(2);
  expect(childView.usage).toEqual(view.usage);
  expect(childView.messages.every(letter => letter.from.threadId === first.thread.id || letter.to.threadId === first.thread.id)).toBe(true);
});

test('child manual turns update usage without a turn budget or duplicate retry', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const config = {
    ...DEFAULT_DELEGATION_CONFIG, enabled: true, maxTurns: 2,
    profiles: [{ id: 'echo', name: 'Echo reviewer', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null }]
  };
  await client.call('delegation.configure', { threadId: 't-trace', config });
  const child = await client.call('delegation.spawn', { threadId: 't-trace', profileId: 'echo', task: 'Initial turn', requestId: 'spawn-budget' });
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId: child.thread.id })).status).toBe('idle'));
  const manual = { threadId: child.thread.id, prompt: 'Manual follow-up', clientRequestId: 'manual_01' };
  await client.call('turns.start', manual);
  expect((await client.call('delegation.get', { threadId: child.thread.id })).turnsUsed).toBe(2);
  await expect(client.call('turns.start', manual)).resolves.toMatchObject({ threadId: child.thread.id });
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId: child.thread.id })).status).toBe('idle'));
  await client.call('turns.start', { threadId: child.thread.id, prompt: 'Another follow-up', clientRequestId: 'manual_02' });
  expect((await client.call('delegation.get', { threadId: child.thread.id })).turnsUsed).toBe(3);
});

test('fake delegation launches thirty children despite legacy quotas from an older client', async ({ createClient }) => {
  const client = await createClient({ delayMs: 2 });
  const config = { ...DEFAULT_DELEGATION_CONFIG, enabled: true, maxAgents: 1, maxConcurrent: 1, maxTurns: 1, maxMinutes: 1,
    profiles: [{ id: 'echo', name: 'Echo', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null }] };
  await client.call('delegation.configure', { threadId: 't-trace', config });
  for (let index = 0; index < 30; index++) await client.call('delegation.spawn', {
    threadId: 't-trace', profileId: 'echo', task: 'Independent work', requestId: `parallel-${index}`
  });
  const view = await client.call('delegation.get', { threadId: 't-trace' });
  expect(view.agents).toHaveLength(30);
  expect(view.agents.every(agent => agent.thread.status === 'running')).toBe(true);
  expect(view.turnsUsed).toBe(30);
  for (const field of ['maxAgents', 'maxConcurrent', 'maxTurns', 'maxMinutes']) expect(view.config).not.toHaveProperty(field);
});

test('a child stop targets itself, preserves its sibling and cannot target that sibling', async ({ createClient }) => {
  const client = await createClient({ delayMs: 4 });
  const config = {
    ...DEFAULT_DELEGATION_CONFIG, enabled: true, maxConcurrent: 2,
    profiles: [{ id: 'echo', name: 'Echo reviewer', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null }]
  };
  await client.call('delegation.configure', { threadId: 't-trace', config });
  const first = await client.call('delegation.spawn', { threadId: 't-trace', profileId: 'echo', task: `First ${'a'.repeat(240)}`, requestId: 'stop-first' });
  const second = await client.call('delegation.spawn', { threadId: 't-trace', profileId: 'echo', task: `Second ${'b'.repeat(240)}`, requestId: 'stop-second' });
  await expect(client.call('delegation.stop', { threadId: first.thread.id, agentId: second.thread.id })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('delegation.stop', { threadId: first.thread.id })).resolves.toEqual({ stopped: 1 });
  const view = await client.call('delegation.get', { threadId: 't-trace' });
  expect(view.config.paused).toBe(false);
  expect(view.agents.find(agent => agent.thread.id === first.thread.id)?.lastTurn?.status).toBe('stopped');
  expect(view.agents.find(agent => agent.thread.id === second.thread.id)?.lastTurn?.status).not.toBe('stopped');
});

test('fake delegation reserves result request IDs and emits no result when pausing a running team', async ({ createClient }) => {
  const client = await createClient({ delayMs: 3 });
  const config = {
    ...DEFAULT_DELEGATION_CONFIG, enabled: true,
    profiles: [{ id: 'echo', name: 'Echo reviewer', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null }]
  };
  await client.call('delegation.configure', { threadId: 't-trace', config });
  const child = await client.call('delegation.spawn', { threadId: 't-trace', profileId: 'echo', task: `Long ${'a'.repeat(240)}`, requestId: 'pause-child' });
  await expect(client.call('delegation.send', { threadId: 't-trace', toThreadId: child.thread.id, text: 'No', requestId: 'result:spoof' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await client.call('delegation.configure', { threadId: 't-trace', config: { ...config, paused: true } });
  const view = await client.call('delegation.get', { threadId: 't-trace' });
  expect(view.messages.filter(letter => letter.origin === 'result')).toEqual([]);
});

test('regular Stop cancels queued children separately and pauses the team when stopping its parent', async ({ createClient }) => {
  const client = await createClient({ delayMs: 4 });
  await client.call('turns.stop', { threadId: 't-trace' });
  expect((await client.call('delegation.get', { threadId: 't-trace' })).config.paused).toBe(false);
  const config = {
    ...DEFAULT_DELEGATION_CONFIG, enabled: true, maxConcurrent: 1,
    profiles: [{ id: 'echo', name: 'Echo reviewer', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null }]
  };
  await client.call('delegation.configure', { threadId: 't-trace', config });
  const first = await client.call('delegation.spawn', { threadId: 't-trace', profileId: 'echo', task: `First ${'a'.repeat(240)}`, requestId: 'regular-first' });
  const queued = await client.call('delegation.spawn', { threadId: 't-trace', profileId: 'echo', task: 'Queued', requestId: 'regular-queued' });
  await expect(client.call('turns.stop', { threadId: queued.thread.id })).resolves.toEqual({ stopped: true });
  expect((await client.call('delegation.get', { threadId: 't-trace' })).config.paused).toBe(false);
  await expect(client.call('turns.stop', { threadId: 't-trace' })).resolves.toEqual({ stopped: true });
  const view = await client.call('delegation.get', { threadId: 't-trace' });
  expect(view.config.paused).toBe(true);
  expect(view.agents.find(agent => agent.thread.id === first.thread.id)?.lastTurn?.status).toBe('stopped');
  expect(view.agents.find(agent => agent.thread.id === queued.thread.id)?.lastTurn?.status).toBe('stopped');
});

test('telemetry handlers retain export and deletion state through the typed dispatcher', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  expect(await client.call('telemetry.state', {})).toEqual({ mode: 'basic', configured: true, pendingDeletion: false });
  await expect(client.call('telemetry.export', {})).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
  await client.call('telemetry.configure', { mode: 'enhanced' });
  expect(await client.call('telemetry.export', {})).toEqual({ events: [], truncated: false });
  expect(await client.call('telemetry.configure', { mode: 'off' })).toMatchObject({ mode: 'off', pendingDeletion: true });
  expect(await client.call('telemetry.retryForget', {})).toMatchObject({ mode: 'off', pendingDeletion: false });
});

test.for(['toString', 'constructor', '__proto__', 'missing.method'])('unknown RPC method %s is refused', async (method, { createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await expect(client.call(method as RpcMethodName, {})).rejects.toMatchObject({ code: RpcErrorCode.MethodNotFound });
});

test('coordination stays scoped to its core and paired devices can only inspect it', async ({ createClient }) => {
  const [first, second, phone] = await Promise.all([
    createClient({ delayMs: 0, coreId: 'core-first', coreName: 'First', publicUrl: 'https://first.test' }),
    createClient({ delayMs: 0, coreId: 'core-second', coreName: 'Second', publicUrl: 'https://second.test' }),
    createClient({ delayMs: 0, principal: 'session', coreId: 'core-phone' })
  ]);

  expect((await first.call('collaboration.get', { threadId: 't-trace' })).config.mode).toBe('brief');
  await first.call('collaboration.configure', { threadId: 't-trace', config: { mode: 'team', resources: 'UI', remote: true, paused: false } });
  expect((await first.call('collaboration.get', { threadId: 't-trace' })).config.resources).toBe('UI');
  await first.call('collaboration.configure', { threadId: 't-descriptors', config: { mode: 'brief', resources: 'Descriptors', remote: false, paused: false } });
  expect((await first.call('collaboration.directory', { threadId: 't-trace' })).agents.map(agent => agent.threadId)).not.toContain('t-descriptors');
  await first.call('collaboration.configure', { threadId: 't-descriptors', config: { mode: 'brief', resources: 'Descriptors', remote: true, paused: false } });
  expect((await first.call('collaboration.directory', { threadId: 't-trace' })).agents.map(agent => agent.threadId)).toContain('t-descriptors');
  expect((await second.call('collaboration.get', { threadId: 't-trace' })).config.mode).toBe('brief');
  expect((await phone.call('collaboration.get', { threadId: 't-trace' })).config.mode).toBe('brief');
  await expect(phone.call('collaboration.configure', { threadId: 't-trace', config: { mode: 'brief', resources: '', remote: false, paused: false } })).rejects.toMatchObject({ code: RpcErrorCode.Refused });

  const [a, b] = await Promise.all([first.call('collaboration.identity', {}), second.call('collaboration.identity', {})]);
  await Promise.all([first.call('collaboration.trust', { peer: b }), second.call('collaboration.trust', { peer: a })]);
  expect(await first.call('collaboration.peers', {})).toEqual([{ ...b, readThreads: false, viaClient: false }]);
  await second.call('collaboration.configure', { threadId: 't-trace', config: { mode: 'brief', resources: 'Build VM', remote: true, paused: false } });
  await expect(first.call('collaboration.check', { coreId: b.coreId })).resolves.toEqual({ ok: true });
  expect((await first.call('collaboration.directory', { threadId: 't-trace' })).agents).toContainEqual(expect.objectContaining({ coreId: b.coreId, threadId: 't-trace' }));
  await expect(first.call('collaboration.read', { threadId: 't-trace', target: { coreId: b.coreId, threadId: 't-trace' } })).rejects.toThrow('not allowed to read');
  await second.call('collaboration.trust', { peer: { ...a, readThreads: true } });
  await first.call('group.create', { name: 'Home' });
  await second.call('group.join', { invite: (await first.call('group.invite', {})).invite });
  expect(await first.call('collaboration.peers', {})).toEqual([]);
  expect(await second.call('collaboration.peers', {})).toEqual([]);
  expect((await first.call('collaboration.directory', { threadId: 't-trace' })).agents).toContainEqual(expect.objectContaining({ coreId: b.coreId, threadId: 't-trace' }));
  expect((await first.call('collaboration.read', { threadId: 't-trace', target: { coreId: b.coreId, threadId: 't-trace' } })).entries.length).toBeGreaterThan(0);
  await expect(phone.call('collaboration.bridge.register', { coreId: a.coreId, enabled: true })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await second.call('projects.archive', { projectId: 'p-boite', archived: true });
  const remoteContact = (await first.call('collaboration.directory', { threadId: 't-trace' })).agents.find(contact => contact.coreId === b.coreId && contact.threadId === 't-trace')!;
  expect(remoteContact).toMatchObject({ projectArchived: true, paused: false });
  const remoteThread = await second.call('threads.get', { threadId: 't-trace' });
  expect(remoteContact.lastCompletedAt).toBe(remoteThread.turns.findLast(turn => turn.status === 'done')?.finishedAt ?? null);
  const letter = await first.call('collaboration.send', { threadId: 't-trace', to: { coreId: b.coreId, threadId: 't-trace' }, text: 'Wait for the build', requestId: 'remote' });
  expect((await second.call('projects.list', {})).find(project => project.id === 'p-boite')?.archived).not.toBe(true);
  const project = (await first.call('projects.list', {})).find(project => project.id === 'p-boite')!;
  expect(letter.from.project).toBe(project.name);
  expect(letter.toProject).toBe(project.name);
  expect(letter.toMachine).toBe('Second');
  expect((await second.call('collaboration.get', { threadId: 't-trace' })).messages).toEqual([letter]);
  expect((await second.call('collaboration.get', { threadId: 't-trace' })).sent).toBe(0);
  await second.call('collaboration.configure', { threadId: 't-trace', config: { mode: 'brief', resources: '', remote: true, paused: true } });
  await second.call('projects.archive', { projectId: 'p-boite', archived: true });
  const pausedLetter = await first.call('collaboration.send', { threadId: 't-trace', to: { coreId: b.coreId, threadId: 't-trace' }, text: 'Follow up later', requestId: 'paused-remote' });
  expect(pausedLetter.status).toBe('received');
  expect((await second.call('projects.list', {})).find(project => project.id === 'p-boite')?.archived).toBe(true);
  await second.call('collaboration.configure', { threadId: 't-trace', config: { mode: 'brief', resources: '', remote: true, paused: false } });
  expect((await second.call('projects.list', {})).find(project => project.id === 'p-boite')?.archived).not.toBe(true);
  expect((await first.call('collaboration.get', { threadId: 't-trace' })).messages.find(message => message.id === pausedLetter.id)?.status).toBe('delivered');
  await first.call('collaboration.untrust', { coreId: b.coreId });
  expect(await first.call('collaboration.peers', {})).toEqual([]);
  await first.call('group.remove', { coreId: b.coreId });
  expect((await first.call('collaboration.directory', { threadId: 't-trace' })).agents.some(agent => agent.coreId === b.coreId)).toBe(false);
  await expect(first.call('collaboration.send', { threadId: 't-trace', to: { coreId: b.coreId, threadId: 't-trace' }, text: 'Removed', requestId: 'removed' })).rejects.toThrow('not trusted');
  await first.call('threads.archive', { threadId: 't-trace', archived: true });
  expect((await first.call('collaboration.directory', { threadId: 't-trace' })).agents).toEqual([]);
  await expect(first.call('collaboration.send', { threadId: 't-trace', to: { coreId: a.coreId, threadId: 't-descriptors' }, text: 'Archived sender', requestId: 'archived' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(first.call('collaboration.configure', { threadId: 't-trace', config: { mode: 'brief', resources: '', remote: true, paused: false } })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
});

test('fake threads reject unknown providers even when speed is omitted', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const before = await client.call('threads.list', {});
  await expect(client.call('threads.create', { projectId: 'p-boite', providerId: 'unknown', accountId: 'a-echo' })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  expect(await client.call('threads.list', {})).toEqual(before);
});

test.for([{ data: '?' }, { mimeType: '' }, { name: 42 }, { kind: 'unknown' }, { data: 'A'.repeat(7 * 1048576) }])('fake uploads refuse malformed attachment fields before creating a turn: %#', async (change, { createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const before = await client.call('threads.get', { threadId: 't-trace' });
  await expect(client.call('turns.start', { threadId: 't-trace', prompt: 'Read', attachments: [{ kind: 'file', mimeType: 'text/plain', data: 'YWJj', name: 'notes.txt', ...change }] as never })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  expect((await client.call('threads.get', { threadId: 't-trace' })).turns).toEqual(before.turns);
});

test('fake speech refuses overlapping request IDs and accepts a retry after completion', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const { revision } = await client.call('speech.status', {});
  const first = client.call('speech.transcribe', { requestId: 'first', revision, audio: '' });
  try {
    await expect(client.call('speech.transcribe', { requestId: 'second', revision, audio: '' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await first;
    expect((await client.call('speech.transcribe', { requestId: 'second', revision, audio: '' })).text).toBeTruthy();
  } finally { await first.catch(() => {}); }
});

test('fake speech downloads a model from a link, uses it, and removing it hands back the default', async ({ createClient }) => {
  vi.useFakeTimers();
  const client = await createClient({ delayMs: 0 });
  await expect(client.call('speech.install', { url: 'http://models.example/ggml-tiny.bin' })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
  const started = await client.call('speech.install', { url: 'https://models.example/ggml-tiny.bin' });
  expect(started.downloading).toMatch(/^custom-[a-f0-9]{12}$/);
  expect(started.models.at(-1)).toMatchObject({ kind: 'custom', name: 'ggml-tiny.bin', host: 'models.example', installed: false });
  await vi.advanceTimersByTimeAsync(20_000);
  const done = await client.call('speech.status', {});
  expect(done.installing).toBe(false);
  expect((await client.call('speech.config', {})).model).toBe(started.downloading);
  await client.call('speech.uninstall', { model: started.downloading! });
  expect((await client.call('speech.config', {})).model).toBe(SPEECH_DEFAULT_MODEL);
  expect((await client.call('speech.status', {})).models.some(model => model.kind === 'custom')).toBe(false);
});

test('fake speech refuses a recording made before configuration changed', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const { revision } = await client.call('speech.status', {});
  const config = await client.call('speech.config', {});
  await client.call('speech.configure', { ...config, language: 'fr' });
  await expect(client.call('speech.transcribe', { requestId: 'old', revision, audio: '' }))
    .rejects.toMatchObject({ code: RpcErrorCode.Refused, message: expect.stringContaining('settings changed') });
});

test.for(['goal', 'loop'] as const)('changing the other activity keeps the running %s completion', async (kind, { createClient }) => {
  vi.useFakeTimers();
  const client = await createClient({ delayMs: 1 });
  const { id: threadId } = await newThread(client);
  await client.call('threads.activity.set', { threadId, [kind]: kind === 'goal' ? { objective: 'finish' } : { prompt: 'pong', intervalMs: 0, maxIterations: 1 } });
  await vi.advanceTimersByTimeAsync(1);
  const other = kind === 'goal' ? 'loop' : 'goal';
  await client.call('threads.activity.set', { threadId, [other]: null });
  await vi.runAllTimersAsync();
  const activity = (await client.call('threads.get', { threadId })).activity!;
  expect(activity[kind]?.status).toBe('complete');
  expect(activity[kind]?.iterations).toBe(1);
  if (kind === 'loop') expect(activity.loop?.history?.[0]?.status).toBe('done');
});

test('a fake blocked goal waits for the reply, then runs again', async ({ createClient }) => {
  vi.useFakeTimers();
  const client = await createClient({ delayMs: 1 });
  const { id: threadId } = await newThread(client);
  await client.call('threads.activity.set', { threadId, goal: { objective: 'Which database should the billing tables use?' } });
  await vi.runAllTimersAsync();
  expect((await client.call('threads.get', { threadId })).activity?.goal).toMatchObject({ status: 'paused', blocked: true, iterations: 1 });
  await client.call('turns.start', { threadId, prompt: 'Postgres' });
  expect((await client.call('threads.get', { threadId })).activity?.goal).toMatchObject({ status: 'active', error: null });
  await vi.runAllTimersAsync();
  // The objective still asks, so the next goal turn blocks again.
  expect((await client.call('threads.get', { threadId })).activity?.goal).toMatchObject({ status: 'paused', blocked: true, iterations: 2 });
});

async function newThread(client: FakeClient, projectId = 'p-boite') {
  return client.call('threads.create', { projectId, providerId: 'echo', accountId: 'a-echo' });
}

test.for(['remove', 'complete'] as const)('fake %s invalidates a goal before its delayed stop completes', async (action, { createClient }) => {
  vi.useFakeTimers();
  const client = await createClient({ delayMs: 10 });
  const { id: threadId } = await newThread(client);
  await client.call('threads.activity.set', { threadId, goal: { objective: 'old work' } });
  await vi.advanceTimersByTimeAsync(1);
  await client.call('threads.activity.set', { threadId, loop: { prompt: 'other work', intervalMs: 0, maxIterations: 1 } });
  await client.call('threads.activity.control', { threadId, kind: 'goal', action });
  const stopping = client.call('turns.stop', { threadId });
  await client.call('threads.activity.control', { threadId, kind: 'loop', action: 'resume' });
  await vi.runAllTimersAsync();
  await stopping;
  expect((await client.call('threads.get', { threadId })).activity?.loop?.status).toBe('complete');
});

test('fake settings ignore retired launch limits from older clients', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const legacy = { maxConcurrentTurns: 1, perAccountConcurrency: 1, warmProcessMinutes: 3 };
  const settings = await client.call('settings.set', legacy);
  expect(settings.warmProcessMinutes).toBe(3);
  expect(settings).not.toHaveProperty('maxConcurrentTurns');
  expect(settings).not.toHaveProperty('perAccountConcurrency');
  const scheduler = await client.call('scheduler.get', {});
  expect(scheduler).not.toHaveProperty('maxConcurrentTurns');
  expect(scheduler).not.toHaveProperty('perAccountConcurrency');
});

test('fake settings store a pasted address as its origin and refuse what the core refuses', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  expect((await client.call('settings.get', {})).warmProcessMinutes).toBe(0);
  const saved = await client.call('settings.set', {
    publicUrl: 'https://boite.example.com/',
    browserOrigins: ['http://192.168.1.20:8777/app', 'http://192.168.1.20:8777/']
  });
  expect(saved.publicUrl).toBe('https://boite.example.com');
  expect(saved.browserOrigins).toEqual(['http://192.168.1.20:8777']);
  for (const patch of [{ publicUrl: 'https://boite.example.com/app' }, { warmProcessMinutes: -3 }, { threadDeletionRetentionDays: 0.5 }, { threadDeletionRetentionDays: 3651 }, { agentCpuCapPercent: 120 }, { focusGuard: 'yes' as unknown as boolean }]) {
    await expect(client.call('settings.set', patch)).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
  }
});

test('fake refuses a second active turn and archived threads without adding messages', async ({ createClient }) => {
  vi.useFakeTimers();
  const client = await createClient({ delayMs: 1 });
  const thread = await newThread(client);
  await client.call('turns.start', { threadId: thread.id, prompt: '[permission]' });
  const before = await client.call('threads.get', { threadId: thread.id });
  await expect(client.call('turns.start', { threadId: thread.id, prompt: 'second' }))
    .rejects.toMatchObject({ code: RpcErrorCode.Refused, message: 'this thread already has an in-flight turn',
      data: { threadId: thread.id, reason: 'turn-in-flight', thread: { id: thread.id, status: 'running' } } });
  expect((await client.call('threads.get', { threadId: thread.id })).messages).toEqual(before.messages);
  await vi.runAllTimersAsync();
  await expect(client.call('turns.start', { threadId: thread.id, prompt: 'while waiting' })).rejects.toThrow(/in-flight/);
  await client.call('threads.archive', { threadId: thread.id });
  await expect(client.call('turns.start', { threadId: thread.id, prompt: 'archived' })).rejects.toThrow(/archived/);
  await client.call('threads.archive', { threadId: thread.id, archived: false });
  await client.call('turns.start', { threadId: thread.id, prompt: 'again' });
  await vi.runAllTimersAsync();
  await client.settled();
});

test.for([
  ['stop', '[permission] question'], ['archive', '[permission] question'], ['remove', '[permission] question'],
  ['stop', 'question'], ['archive', 'question'], ['remove', 'question']
] as const)('fake %s drains its own %s turn and leaves other requests pending', async ([action, prompt], { createClient }) => {
  vi.useFakeTimers();
  const client = await createClient({ delayMs: 1 });
  const project = await client.call('projects.add', { path: 'D:/demo/remove' });
  const a = await newThread(client, project.id);
  const b = await newThread(client);
  const c = await newThread(client);
  await client.call('turns.start', { threadId: a.id, prompt });
  await client.call('turns.start', { threadId: b.id, prompt: '[permission]' });
  await client.call('turns.start', { threadId: c.id, prompt: 'question' });
  await vi.runAllTimersAsync();
  const permissions = await client.call('permissions.list', {});
  const questions = await client.call('questions.list', {});
  const events: string[] = [];
  client.on('turn.finished', (turn) => { if (turn.threadId === a.id) events.push(`finished:${turn.status}`); });
  client.on('thread.removed', ({ threadId }) => { if (threadId === a.id) events.push('removed'); });
  if (action === 'stop') await client.call('turns.stop', { threadId: a.id });
  if (action === 'archive') await client.call('threads.archive', { threadId: a.id });
  if (action === 'remove') await client.call('projects.remove', { projectId: project.id });
  expect(events).toEqual(action === 'remove' ? ['finished:stopped', 'removed'] : ['finished:stopped']);
  expect(await client.call('permissions.list', {})).toEqual(permissions.filter((request) => request.threadId !== a.id));
  expect(await client.call('questions.list', {})).toEqual(questions.filter((request) => request.threadId !== a.id));
  if (action !== 'remove') expect((await client.call('threads.get', { threadId: a.id })).status).toBe('idle');
  await client.call('turns.stop', { threadId: b.id });
  await client.call('turns.stop', { threadId: c.id });
  await client.settled();
});

test('fake probes expose distinct OpenCode, Codex, pi, Grok, Muse and Antigravity catalogs', async ({ createClient }) => {
  vi.useFakeTimers();
  const client = await createClient({ delayMs: 0 });
  await client.call('providers.install', { providerId: 'antigravity' });
  await vi.runAllTimersAsync();
  const catalogs = new Map<string, string[]>();
  for (const providerId of ['opencode', 'codex', 'pi', 'grok', 'muse', 'antigravity']) {
    const pending = client.call('providers.probe', { providerId, accountId: `a-${providerId}` });
    const [result] = await Promise.all([pending, vi.runAllTimersAsync()]);
    catalogs.set(providerId, result.models.map((model) => model.id));
    if (providerId === 'muse') {
      // Like the real probe, each Muse model carries its own effort scale.
      const demo = result.models.find((model) => model.id === 'muse-demo');
      expect(demo?.effort?.levels.map((level) => level.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(demo?.effort?.default).toBe('high');
    }
  }
  expect(catalogs.get('opencode')).toContain('anthropic/claude-sonnet-5');
  for (const providerId of ['codex', 'pi', 'grok', 'muse', 'antigravity']) {
    expect(catalogs.get(providerId)).toContain(`${providerId}-demo`);
    expect(catalogs.get(providerId)).not.toContain('anthropic/claude-sonnet-5');
  }
  expect(new Set([...catalogs.values()].map((models) => JSON.stringify(models))).size).toBe(6);
});

test('fake probes use descriptor models for protocols without probing', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const { loaded } = await client.call('providers.list', {});
  for (const [providerId, accountId] of [['echo', 'a-echo']] as const) {
    expect((await client.call('providers.probe', { providerId, accountId })).models)
      .toEqual(loaded.find((provider) => provider.id === providerId)?.models);
  }
});

test('fake keeps forced isolation when a provider forbids default accounts', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const account = await client.call('accounts.add', { providerId: 'antigravity', label: 'Isolated', useDefaultLocation: true });
  expect(account.isolationDir).not.toBeNull();
});

test('fake does not readopt a removed default on reload and allows an explicit replacement', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  try {
    await client.call('accounts.remove', { accountId: 'a-pi' });
    for (let i = 0; i < 2; i++) await client.call('providers.reload', {});
    expect((await client.call('accounts.list', {})).filter(account => account.providerId === 'pi')).toEqual([]);
    expect((await client.call('accounts.list', {})).some(account => account.id === 'a-codex')).toBe(true);
    const restored = await client.call('accounts.add', { providerId: 'pi', label: 'My CLI', useDefaultLocation: true });
    await client.call('providers.reload', {});
    expect((await client.call('accounts.list', {})).filter(account => account.providerId === 'pi')).toEqual([restored]);
  } finally { client.close(); }
});

test('fake probes reject invalid provider/account pairs and unavailable agents', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await expect(client.call('providers.probe', { providerId: 'missing', accountId: 'a-echo' })).rejects.toThrow(/provider/);
  await expect(client.call('providers.probe', { providerId: 'opencode', accountId: 'missing' })).rejects.toThrow(/account/);
  await expect(client.call('providers.probe', { providerId: 'opencode', accountId: 'a-echo' })).rejects.toThrow(/another provider/);
  await expect(client.call('providers.probe', { providerId: 'antigravity', accountId: 'a-antigravity' })).rejects.toThrow(/not available/);
});


test.for(['drop', 'close'] as const)('fake speech releases abandoned requests on %s, even when the retry reuses its ID', async (action, { createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const { revision } = await client.call('speech.status', {});
  const first = client.call('speech.transcribe', { requestId: 'same', revision, audio: '' });
  const abandoned = expect(first).rejects.toThrow();
  await expect(client.call('speech.transcribe', { requestId: 'overlap', revision, audio: '' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  client[action]();
  await abandoned;
  await client.restore();
  expect((await client.call('speech.transcribe', { requestId: 'same', revision, audio: '' })).text).toBeTruthy();
});

test('fake panel.open refuses what the core refuses and names the file by its relative path', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await client.call('threads.subscribe', { threadId: 't-trace' });
  const heard: unknown[] = [];
  client.on('panel.requested', (event) => heard.push(event.surface));
  const refusals = [
    { kind: 'file', path: 'src/missing.ts' },
    { kind: 'file', path: '../outside.ts' },
    { kind: 'file', path: 'docs' },
    { kind: 'file', path: 'README.md', line: 0 },
    { kind: 'files', path: 'README.md' },
    { kind: 'diff', path: '../../etc/passwd' },
    { kind: 'browser', url: 'file:///C:/secret.txt' },
    { kind: 'nope' }
  ];
  for (const surface of refusals) {
    await expect(client.call('panel.open', { threadId: 't-trace', surface: surface as never })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  }
  expect(heard).toEqual([]);
  await client.call('panel.open', { threadId: 't-trace', surface: { kind: 'file', path: 'C:\\src\\boite\\docs\\.\\panel.md', line: 3 } });
  expect(heard).toEqual([{ kind: 'file', path: 'docs/panel.md', line: 3 }]);
});

test('fake todos hold the core limits: a known status and at most TODO_TEXT_MAX characters', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await expect(client.call('todos.add', { threadId: 't-trace', text: 'x'.repeat(TODO_TEXT_MAX + 1) })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  const card = await client.call('todos.add', { threadId: 't-trace', text: 'Write the fake guards' });
  await expect(client.call('todos.update', { threadId: 't-trace', todoId: card.id, status: 'finished' as never, text: 'moved anyway' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('todos.update', { threadId: 't-trace', todoId: card.id, text: 'x'.repeat(TODO_TEXT_MAX + 1) })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  const list = await client.call('todos.list', { threadId: 't-trace' });
  expect(list.find((todo) => todo.id === card.id)).toMatchObject({ text: 'Write the fake guards', status: 'open' });
});

test('fake files and diffs stay inside the thread directory like the core', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await expect(client.call('files.read', { threadId: 't-trace', path: '../boite-legacy/README.md' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('files.read', { threadId: 't-trace', path: 'src/missing.ts' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('files.list', { threadId: 't-trace', path: '..' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('files.list', { threadId: 't-trace', path: 'nowhere' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('files.write', { threadId: 't-trace', path: '../escape.txt', text: 'x' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('files.write', { threadId: 't-trace', path: 'nowhere/new.txt', text: 'x' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(client.call('git.diff', { threadId: 't-trace', path: '../outside.ts' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  expect((await client.call('files.read', { threadId: 't-trace', path: './docs//guide/editor.md' })).path).toBe('docs/guide/editor.md');
  expect((await client.call('files.list', { threadId: 't-trace', path: 'docs/' })).map((entry) => entry.path)).toContain('docs/guide');
});

test('fake [ask] leaves a card nobody waits on, and its answer opens the next turn', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const { id: threadId } = await newThread(client);
  await client.call('turns.start', { threadId, prompt: '[ask] [background] serve it' });
  await client.settled();
  const thread = await client.call('threads.get', { threadId });
  // The turn ended with the question still open and the shell still listed.
  expect(thread.status).toBe('idle');
  expect(thread.background?.map((task) => task.kind)).toEqual(['shell']);
  expect(thread.backgroundHistory).toMatchObject([{ state: 'running', parentTurnId: thread.turns[0]!.id, finishedAt: null }]);
  expect((await client.call('threads.list', {})).find(row => row.id === threadId)).not.toHaveProperty('backgroundHistory');
  const [question] = await client.call('questions.list', { threadId });
  expect(question).toMatchObject({ async: true, text: 'Which port should the dev server take?' });
  const tool = thread.messages.flatMap((message) => message.parts).find((part) => part.type === 'tool');
  expect(tool).toMatchObject({ name: 'Bash', status: 'done', startedAt: expect.any(Number), finishedAt: expect.any(Number) });

  await client.call('questions.answer', { threadId, questionId: question!.id, optionIds: ['2'] });
  await client.settled();
  const after = await client.call('threads.get', { threadId });
  expect(after.turns).toHaveLength(2);
  const prompts = after.messages.filter((message) => message.role === 'user').map((message) => message.parts[0]?.type === 'text' ? message.parts[0].text : '');
  expect(prompts.at(-1)).toBe('> Which port should the dev server take?\n\n4173');

  // Stop on the idle thread ends the background work.
  expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true });
  const stopped = await client.call('threads.get', { threadId });
  expect(stopped.background).toEqual([]);
  expect(stopped.backgroundHistory).toMatchObject([{ state: 'cancelled', reason: 'session-ended', parentTurnId: thread.turns[0]!.id, finishedAt: expect.any(Number) }]);
});

test('fake async answers given while a turn runs start one turn together after it', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const { id: threadId } = await newThread(client);
  for (const prompt of ['[ask] one', '[ask] two']) {
    await client.call('turns.start', { threadId, prompt });
    await client.settled();
  }
  const questions = await client.call('questions.list', { threadId });
  expect(questions).toHaveLength(2);
  await client.call('turns.start', { threadId, prompt: 'hello [permission]' });
  await vi.waitFor(async () => expect(await client.call('permissions.list', { threadId })).toHaveLength(1));
  for (const [index, question] of questions.entries()) {
    await client.call('questions.answer', { threadId, questionId: question.id, optionIds: [String(index + 1)] });
  }
  expect((await client.call('threads.get', { threadId })).pendingAnswers).toEqual([
    '> Which port should the dev server take?\n\n5173', '> Which port should the dev server take?\n\n4173'
  ]);
  const [permission] = await client.call('permissions.list', { threadId });
  await client.call('permissions.answer', { requestId: permission!.id, decision: 'allow' });
  await client.settled();
  const after = await client.call('threads.get', { threadId });
  expect(after.turns).toHaveLength(4);
  expect(after.pendingAnswers).toEqual([]);
  const prompts = after.messages.filter((message) => message.role === 'user').map((message) => message.parts[0]?.type === 'text' ? message.parts[0].text : '');
  expect(prompts.at(-1)).toBe('> Which port should the dev server take?\n\n5173\n\n> Which port should the dev server take?\n\n4173');
});

test('an account check or provider reload that changes nothing stays silent, as on the core', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const heard: string[] = [];
  client.on('accounts.updated', account => heard.push(`account:${account.id}:${account.status}`));
  client.on('providers.updated', () => heard.push('providers'));
  // As the core's `add`, which returns its own check: the new account is read and announced once.
  const account = await client.call('accounts.add', { providerId: 'opencode', label: 'Checked', useDefaultLocation: true });
  expect(account.status).toBe('ok');
  expect(heard).toEqual([`account:${account.id}:ok`]);
  heard.length = 0;
  expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('ok');
  await client.call('providers.reload', {});
  expect(heard).toEqual([]);
});

test('fake hook counters move the way the core ledger moves them', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const before = (await client.call('hooks.status', {})).providers.find(provider => provider.providerId === 'claude')!;
  const run = { at: Date.now(), providerId: 'claude', accountId: null, threadId: null, event: 'Stop', name: 'Stop', message: null } as const;
  client.recordHookRun({ ...run, outcome: 'stopped' });
  client.recordHookRun({ ...run, outcome: 'skipped' });
  const after = (await client.call('hooks.status', {})).providers.find(provider => provider.providerId === 'claude')!;
  // A stop counts as a blocked run; a skipped hook never ran.
  expect(after.runs - before.runs).toBe(1);
  expect(after.blocked - before.blocked).toBe(1);
  expect(after.skipped - before.skipped).toBe(1);
  expect(after.failed).toBe(before.failed);
});

test('deleted fake conversations survive closing and reconnecting with their history and archive flags', async ({ createClient }) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const client = await createClient({ delayMs: 0 });
  const history = (await client.call('threads.get', { threadId: 't-trace' })).messages;
  await client.call('threads.archive', { threadId: 't-trace' });
  await client.call('threads.remove', { threadId: 't-trace' });
  const deletion = (await client.call('threads.deleted', {}))[0]!;
  expect(deletion.deletedAt).toBe(Date.now());
  client.close();
  vi.setSystemTime(Date.now() + 5 * 86_400_000);
  await client.connect();
  expect((await client.call('threads.deleted', {}))[0]?.id).toBe('t-trace');
  expect((await client.call('threads.restore', { threadId: 't-trace' })).archived).toBe(true);
  expect((await client.call('threads.get', { threadId: 't-trace' })).messages).toEqual(history);
});

test('fake retention keeps indefinite deletions and applies a shorter saved delay to existing deletions', async ({ createClient }) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const client = await createClient({ delayMs: 0 });
  await client.call('settings.set', { threadDeletionRetentionDays: 0 });
  await client.call('threads.remove', { threadId: 't-trace' });
  vi.setSystemTime(Date.now() + 40 * 86_400_000);
  expect((await client.call('threads.deleted', {})).map(t => t.id)).toEqual(['t-trace']);
  let notifications = 0;
  client.on('thread.deletionsUpdated', () => { notifications++; });
  await client.call('settings.set', { threadDeletionRetentionDays: 7 });
  expect(await client.call('threads.deleted', {})).toEqual([]);
  expect(notifications).toBe(1);
  await expect(client.call('threads.restore', { threadId: 't-trace' })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
});

test('the fake core compacts by itself at the end of a turn once the threshold is reached', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const threadId = 't-trace';
  const finished = (operation?: string) => new Promise<Turn>(resolve => {
    const off = client.on('turn.finished', turn => { if (turn.threadId === threadId && turn.execution?.operation === operation) { off(); resolve(turn); } });
  });
  await client.call('settings.set', { autoCompact: { tokens: 10_000_000, moments: ['turn-end'] } });
  let done = finished();
  await client.call('turns.start', { threadId, prompt: 'first' });
  await done;
  await new Promise(resolve => setTimeout(resolve, FAKE_AUTO_COMPACT_SETTLE_MS + 100));
  expect((await client.call('threads.get', { threadId })).turns.some(turn => turn.execution?.operation === 'compact')).toBe(false);

  await client.call('settings.set', { autoCompact: { tokens: 1_000, moments: ['turn-end'] } });
  const compacted = finished('compact');
  done = finished();
  await client.call('turns.start', { threadId, prompt: 'second' });
  await done;
  expect((await compacted).execution?.automatic).toBe(true);
  const thread = await client.call('threads.get', { threadId });
  expect(thread.messages.findLast(message => message.role === 'system')?.parts[0]).toMatchObject({ displayText: 'Automatic compaction' });
  expect(thread.messages.at(-1)?.parts.at(-1)).toMatchObject({ type: 'compaction', trigger: 'auto' });

  // The timer checks again: a threshold raised, or a client closed, during the delay starts nothing.
  const count = async () => (await client.call('threads.get', { threadId })).turns.filter(turn => turn.execution?.operation === 'compact').length;
  done = finished();
  await client.call('turns.start', { threadId, prompt: 'third' });
  await done;
  await client.call('settings.set', { autoCompact: { tokens: 10_000_000, moments: ['turn-end'] } });
  await new Promise(resolve => setTimeout(resolve, FAKE_AUTO_COMPACT_SETTLE_MS + 100));
  expect(await count()).toBe(1);
  await client.call('settings.set', { autoCompact: { tokens: 1_000, moments: ['turn-end'] } });
  done = finished();
  await client.call('turns.start', { threadId, prompt: 'fourth' });
  await done;
  client.close();
  await new Promise(resolve => setTimeout(resolve, FAKE_AUTO_COMPACT_SETTLE_MS + 100));
  await client.connect();
  expect(await count()).toBe(1);
});

test('fake /btw admission, duplicate refusal and cancellation match the core without changing history', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await client.call('threads.subscribe', { threadId: 't-trace' });
  const before = await client.call('threads.get', { threadId: 't-trace' });
  vi.useFakeTimers();
  const answers: Array<{ requestId: string; answer: string | null; error: string | null }> = [];
  client.on('thread.btw', result => answers.push(result));
  const input = { threadId: 't-trace', question: 'Which file?', requestId: 'side_fake1' };
  expect(await client.call('threads.btw', input)).toEqual({ requestId: input.requestId });
  await expect(client.call('threads.btw', { ...input, requestId: 'side_fake2' })).rejects.toThrow('already being answered');
  await client.call('threads.btw.cancel', { threadId: input.threadId, requestId: 'side_wrong' });
  expect(answers).toEqual([]);
  await client.call('threads.btw.cancel', { threadId: input.threadId, requestId: input.requestId });
  expect(answers).toEqual([expect.objectContaining({ requestId: input.requestId, answer: null, error: 'side request cancelled' })]);
  await vi.runOnlyPendingTimersAsync();
  expect(answers).toHaveLength(1);
  expect(await client.call('threads.get', { threadId: 't-trace' })).toEqual(before);
  expect(await client.call('threads.btw', { ...input, question: 'Replacement question' })).toEqual({ requestId: input.requestId });
  await vi.advanceTimersByTimeAsync(0);
  expect(answers).toEqual([
    expect.objectContaining({ requestId: input.requestId, answer: null, error: 'side request cancelled' }),
    expect.objectContaining({ requestId: input.requestId, answer: 'Side answer: Replacement question', error: null }),
  ]);
  expect(await client.call('threads.get', { threadId: 't-trace' })).toEqual(before);
});

test('fake side forks consume only the matching completed result and expire dismissed answers', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const threadId = 't-trace', requestId = 'side_fork1';
  await client.call('threads.subscribe', { threadId });
  const before = await client.call('threads.get', { threadId });
  const answered = new Promise<void>(resolve => {
    const off = client.on('thread.btw', result => { if (result.requestId === requestId) { off(); resolve(); } });
  });
  await client.call('threads.btw', { threadId, requestId, question: 'Which file?' });
  await answered;
  await expect(client.call('threads.btw.fork', { threadId, requestId: 'side_wrong' })).rejects.toThrow('available completed');
  const fork = await client.call('threads.btw.fork', { threadId, requestId });
  const copied = await client.call('threads.get', { threadId: fork.id });
  expect(copied.messages.slice(-2).map(message => message.parts)).toEqual([
    [{ type: 'text', text: 'Which file?' }], [{ type: 'text', text: 'Side answer: Which file?' }],
  ]);
  expect(copied.turns.every(turn => !turn.usage && !turn.checkpoint)).toBe(true);
  expect(await client.call('threads.get', { threadId })).toEqual(before);
  await expect(client.call('threads.btw.fork', { threadId, requestId })).rejects.toThrow('available completed');
  const dismissed = new Promise<void>(resolve => {
    const off = client.on('thread.btw', result => { if (result.requestId === 'side_dismiss') { off(); resolve(); } });
  });
  await client.call('threads.btw', { threadId, requestId: 'side_dismiss', question: 'Discard this' });
  await dismissed;
  await client.call('threads.btw.cancel', { threadId, requestId: 'side_dismiss' });
  await expect(client.call('threads.btw.fork', { threadId, requestId: 'side_dismiss' })).rejects.toThrow('available completed');
});

test('fake close clears pending timers and retained side answers before reconnecting', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const threadId = 't-trace', requestId = 'side_reconnect';
  const before = await client.call('threads.get', { threadId });
  const answers: RpcEvents['thread.btw'][] = [];
  client.on('thread.btw', answer => answers.push(answer));
  vi.useFakeTimers();
  await client.call('threads.btw', { threadId, requestId, question: 'Retain this answer' });
  await vi.advanceTimersByTimeAsync(0);
  expect(answers).toEqual([{ threadId, requestId, answer: 'Side answer: Retain this answer', error: null }]);
  client.close();
  await client.connect();
  await expect(client.call('threads.btw.fork', { threadId, requestId })).rejects.toThrow('available completed');
  await client.call('threads.btw', { threadId, requestId, question: 'Pending at close' });
  client.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(answers).toHaveLength(1);
  await client.connect();
  expect(await client.call('threads.btw', { threadId, requestId, question: 'Fresh after reconnect' })).toEqual({ requestId });
  await client.call('threads.btw.cancel', { threadId, requestId });
  expect(answers).toHaveLength(2);
  expect(answers[1]).toEqual({ threadId, requestId, answer: null, error: 'side request cancelled' });
  expect(await client.call('threads.get', { threadId })).toEqual(before);
  const suspended = client.call('threads.btw', { threadId, requestId: 'side_close_race', question: 'Not admitted before close' });
  const rejected = expect(suspended).rejects.toMatchObject({ code: RpcErrorCode.Internal });
  client.close();
  await rejected;
  await vi.advanceTimersByTimeAsync(0);
  await client.connect();
  await expect(client.call('threads.btw.fork', { threadId, requestId: 'side_close_race' })).rejects.toThrow('available completed');
  expect(answers).toHaveLength(2);
  expect(await client.call('threads.get', { threadId })).toEqual(before);
});

test('fake close and reconnect fence calls waiting before dispatch even when the transport is ready again', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const threadId = 't-trace', requestId = 'side_close_aba';
  const before = await client.call('threads.get', { threadId });
  const answers: RpcEvents['thread.btw'][] = [];
  client.on('thread.btw', answer => answers.push(answer));
  vi.useFakeTimers();
  let release!: () => void;
  const tick = new Promise<void>(resolve => { release = resolve; });
  const held = vi.spyOn(FakeContext.prototype, 'tick').mockImplementationOnce(() => tick);
  try {
    const suspended = client.call('threads.btw', { threadId, requestId, question: 'Old transport request' });
    const rejected = expect(suspended).rejects.toMatchObject({ code: RpcErrorCode.Internal });
    client.close();
    await client.connect();
    expect(client.state).toBe('ready');
    release();
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    await expect(client.call('threads.btw.fork', { threadId, requestId })).rejects.toThrow('available completed');
    expect(answers).toEqual([]);
    expect(await client.call('threads.get', { threadId })).toEqual(before);
  } finally { release(); held.mockRestore(); }
});

test('fake merged PR proof follows the checkout branch and linked PRs like the core', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const project = await client.call('projects.add', { path: '/workspace/renamed-branch-fixture' });
  await client.call('threads.focus', { threadId: null, protectedThreadIds: [], protectAllThreads: false });
  const archiveWith = async (title: string, checkoutBranch: string, prHead: string, linked: boolean) => {
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: 'a-echo', worktree: { branch: title }, title });
    await client.call('threads.markRead', { threadId: thread.id });
    client.setMergedPrFixture(thread.id, { repository: 'github.com/example/repo', branch: checkoutBranch, tip: 'a'.repeat(40), clean: true,
      candidates: [{ repository: 'github.com/example/repo', branch: prHead, sha: 'a'.repeat(40), number: 7, url: 'https://github.com/example/repo/pull/7', mergedAt: '2026-10-01T12:00:00Z', linked }] });
    return client.sweepMergedPrArchives();
  };
  // The agent switched its worktree to the branch its PR came from.
  expect(await archiveWith('renamed', 'fix/renamed', 'fix/renamed', false)).toBe(1);
  // Pushed under another name: only a linked PR names it.
  expect(await archiveWith('pushed', 'pushed', 'fix/elsewhere', false)).toBe(0);
  expect(await archiveWith('linked', 'linked', 'fix/elsewhere', true)).toBe(1);
});

test.for([{ questionOn: 'parent', release: 'dismiss' }, { questionOn: 'child', release: 'expire' }] as const)(
  'fake side questions protect a merged conversation family until the answer is released: %#',
  async (scenario, { createClient }) => {
    const client = await createClient({ delayMs: 0 });
    const project = await client.call('projects.add', { path: '/workspace/side-archive-fixture' });
    const root = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: 'a-echo',
      worktree: { branch: 'side-archive-fixture' }, title: 'Side question archive fixture' });
    const run = await client.call('workflows.start', { threadId: root.id, requestId: 'side_archive_family',
      plan: { name: 'Completed family', steps: [{ id: 'review', task: 'Review the merged change.' }] } });
    await vi.waitFor(async () => expect((await client.call('workflows.get', { threadId: root.id, runId: run.id })).status).toBe('done'));
    const finished = await client.call('workflows.get', { threadId: root.id, runId: run.id });
    const childId = finished.nodes[0]!.instances[0]!.threadId!;
    await client.call('threads.markRead', { threadId: root.id });
    await client.call('threads.markRead', { threadId: childId });
    await client.call('threads.focus', { threadId: null, protectedThreadIds: [], protectAllThreads: false });
    client.setMergedPrFixture(root.id, { repository: 'github.com/example/repo', branch: root.branch!, tip: 'a'.repeat(40), clean: true,
      candidates: [{ repository: 'github.com/example/repo', branch: root.branch!, sha: 'a'.repeat(40), number: 7,
        url: 'https://github.com/example/repo/pull/7', mergedAt: '2026-10-01T12:00:00Z' }] });
    const threadId = scenario.questionOn === 'parent' ? root.id : childId;
    const before = await client.call('threads.get', { threadId });
    const answers: RpcEvents['thread.btw'][] = [];
    client.on('thread.btw', answer => answers.push(answer));
    vi.useFakeTimers();
    const requestId = 'side_archive_question';
    await client.call('threads.btw', { threadId, requestId, question: 'Which file?' });
    expect(await client.sweepMergedPrArchives()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toEqual([{ threadId, requestId, answer: 'Side answer: Which file?', error: null }]);
    expect(await client.sweepMergedPrArchives()).toBe(0);
    expect(await client.call('threads.get', { threadId })).toEqual(before);
    await client.call('threads.btw.cancel', { threadId, requestId: 'side_wrong_question' });
    expect(await client.sweepMergedPrArchives()).toBe(0);
    if (scenario.release === 'dismiss') await client.call('threads.btw.cancel', { threadId, requestId });
    else await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await client.sweepMergedPrArchives()).toBe(1);
    expect((await client.call('threads.get', { threadId: root.id })).archiveReason).toMatchObject({ type: 'pr-merged', number: 7 });
    expect((await client.call('threads.get', { threadId: childId })).archived).toBe(false);
    const parentRefusal = { code: RpcErrorCode.Refused, message: 'threads.btw.threadId: expected a conversation whose parent is not archived or being deleted' };
    await expect(client.call('threads.btw', { threadId: childId, requestId: 'side_late_question', question: 'Late question' })).rejects.toMatchObject(parentRefusal);
    await expect(client.call('threads.btw.fork', { threadId: childId, requestId })).rejects.toMatchObject(parentRefusal);
    await client.call('threads.archive', { threadId: root.id, archived: false });
    const history = (await client.call('threads.get', { threadId })).messages;
    const answerCount = answers.length;
    const manualRequestId = 'side_manual_archive';
    await client.call('threads.btw', { threadId, requestId: manualRequestId, question: 'Pending during manual archive' });
    await client.call('threads.archive', { threadId: root.id, archived: true });
    const cancellation = { threadId, requestId: manualRequestId, answer: null, error: 'side request cancelled' };
    expect(answers.slice(answerCount)).toEqual([cancellation]);
    await vi.advanceTimersByTimeAsync(0);
    expect(answers.slice(answerCount)).toEqual([cancellation]);
    await client.call('threads.archive', { threadId: root.id, archived: false });
    await expect(client.call('threads.btw.fork', { threadId, requestId: manualRequestId })).rejects.toThrow('available completed');
    expect((await client.call('threads.get', { threadId })).messages).toEqual(history);
  },
);
