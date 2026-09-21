import { afterEach, expect, test, vi } from 'vitest';
import { FakeClient } from './fake-client';
import { RpcErrorCode, TODO_TEXT_MAX } from '@boite/contracts';

afterEach(() => vi.useRealTimers());

test('coordination stays scoped to its core and paired devices can only inspect it', async () => {
  const first = new FakeClient({ delayMs: 0, coreId: 'core-first', coreName: 'First', publicUrl: 'https://first.test' });
  const second = new FakeClient({ delayMs: 0, coreId: 'core-second', coreName: 'Second', publicUrl: 'https://second.test' });
  const phone = new FakeClient({ delayMs: 0, principal: 'session', coreId: 'core-phone' });
  await Promise.all([first.connect(), second.connect(), phone.connect()]);

  expect((await first.call('collaboration.get', { threadId: 't-trace' })).config.mode).toBe('off');
  await first.call('collaboration.configure', { threadId: 't-trace', config: { mode: 'team', resources: 'UI', remote: true, paused: false } });
  expect((await first.call('collaboration.get', { threadId: 't-trace' })).config.resources).toBe('UI');
  await first.call('collaboration.configure', { threadId: 't-descriptors', config: { mode: 'brief', resources: 'Descriptors', remote: false, paused: false } });
  expect((await first.call('collaboration.directory', { threadId: 't-trace' })).agents.map(agent => agent.threadId)).not.toContain('t-descriptors');
  await first.call('collaboration.configure', { threadId: 't-descriptors', config: { mode: 'brief', resources: 'Descriptors', remote: true, paused: false } });
  expect((await first.call('collaboration.directory', { threadId: 't-trace' })).agents.map(agent => agent.threadId)).toContain('t-descriptors');
  expect((await second.call('collaboration.get', { threadId: 't-trace' })).config.mode).toBe('off');
  expect((await phone.call('collaboration.get', { threadId: 't-trace' })).config.mode).toBe('off');
  await expect(phone.call('collaboration.configure', { threadId: 't-trace', config: { mode: 'brief', resources: '', remote: false, paused: false } })).rejects.toMatchObject({ code: RpcErrorCode.Refused });

  const [a, b] = await Promise.all([first.call('collaboration.identity', {}), second.call('collaboration.identity', {})]);
  await Promise.all([first.call('collaboration.trust', { peer: b }), second.call('collaboration.trust', { peer: a })]);
  expect(await first.call('collaboration.peers', {})).toEqual([b]);
  await second.call('collaboration.configure', { threadId: 't-trace', config: { mode: 'brief', resources: 'Build VM', remote: true, paused: false } });
  await expect(first.call('collaboration.check', { coreId: b.coreId })).resolves.toEqual({ ok: true });
  expect((await first.call('collaboration.directory', { threadId: 't-trace' })).agents).toContainEqual(expect.objectContaining({ coreId: b.coreId, threadId: 't-trace' }));
  const letter = await first.call('collaboration.send', { threadId: 't-trace', to: { coreId: b.coreId, threadId: 't-trace' }, text: 'Wait for the build', requestId: 'remote' });
  expect((await second.call('collaboration.get', { threadId: 't-trace' })).messages).toEqual([letter]);
  expect((await second.call('collaboration.get', { threadId: 't-trace' })).sent).toBe(0);
  await first.call('collaboration.untrust', { coreId: b.coreId });
  expect(await first.call('collaboration.peers', {})).toEqual([]);
  first.close(); second.close(); phone.close();
});

test('fake threads reject unknown providers even when speed is omitted', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    const before = await client.call('threads.list', {});
    await expect(client.call('threads.create', { projectId: 'p-boite', providerId: 'unknown', accountId: 'a-echo' })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
    expect(await client.call('threads.list', {})).toEqual(before);
  } finally { client.close(); }
});

test.each([{ data: '?' }, { mimeType: '' }, { name: 42 }, { kind: 'unknown' }, { data: 'A'.repeat(7 * 1048576) }])('fake uploads refuse malformed attachment fields before creating a turn: %#', async change => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    const before = await client.call('threads.get', { threadId: 't-trace' });
    await expect(client.call('turns.start', { threadId: 't-trace', prompt: 'Read', attachments: [{ kind: 'file', mimeType: 'text/plain', data: 'YWJj', name: 'notes.txt', ...change }] as never })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    expect((await client.call('threads.get', { threadId: 't-trace' })).turns).toEqual(before.turns);
  } finally { client.close(); }
});

test('fake speech refuses overlapping request IDs and accepts a retry after completion', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  const { revision } = await client.call('speech.status', {});
  const first = client.call('speech.transcribe', { requestId: 'first', revision, audio: '' });
  try {
    await expect(client.call('speech.transcribe', { requestId: 'second', revision, audio: '' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await first;
    expect((await client.call('speech.transcribe', { requestId: 'second', revision, audio: '' })).text).toBeTruthy();
  } finally { await first.catch(() => {}); client.close(); }
});

test('fake speech refuses a recording made before configuration changed', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    const { revision } = await client.call('speech.status', {});
    const config = await client.call('speech.config', {});
    await client.call('speech.configure', { ...config, language: 'fr' });
    await expect(client.call('speech.transcribe', { requestId: 'old', revision, audio: '' }))
      .rejects.toMatchObject({ code: RpcErrorCode.Refused, message: expect.stringContaining('settings changed') });
  } finally { client.close(); }
});

test.each(['goal', 'loop'] as const)('changing the other activity keeps the running %s completion', async kind => {
  vi.useFakeTimers();
  const client = new FakeClient({ delayMs: 1 });
  await client.connect();
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
  client.close();
});

async function newThread(client: FakeClient, projectId = 'p-boite') {
  return client.call('threads.create', { projectId, providerId: 'echo', accountId: 'a-echo' });
}

test.each(['remove', 'complete'] as const)('fake %s invalidates a goal before its delayed stop completes', async action => {
  vi.useFakeTimers();
  const client = new FakeClient({ delayMs: 10 });
  await client.connect();
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
  client.close();
});

test.each(['maxConcurrentTurns', 'perAccountConcurrency'] as const)('fake settings reject invalid %s atomically', async (field) => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  const before = await client.call('settings.get', {});
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    await expect(client.call('settings.set', { [field]: value, warmProcessMinutes: 99 }))
      .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams, message: `${field} must be a positive integer` });
    expect(await client.call('settings.get', {})).toEqual(before);
  }
  expect((await client.call('settings.set', { [field]: 3 }))[field]).toBe(3);
  client.close();
});

test('fake refuses a second active turn and archived threads without adding messages', async () => {
  vi.useFakeTimers();
  const client = new FakeClient({ delayMs: 1 });
  await client.connect();
  const thread = await newThread(client);
  await client.call('turns.start', { threadId: thread.id, prompt: '[permission]' });
  const before = await client.call('threads.get', { threadId: thread.id });
  await expect(client.call('turns.start', { threadId: thread.id, prompt: 'second' }))
    .rejects.toMatchObject({ code: RpcErrorCode.Refused, message: 'this thread already has an in-flight turn' });
  expect((await client.call('threads.get', { threadId: thread.id })).messages).toEqual(before.messages);
  await vi.runAllTimersAsync();
  await expect(client.call('turns.start', { threadId: thread.id, prompt: 'while waiting' })).rejects.toThrow(/in-flight/);
  await client.call('threads.archive', { threadId: thread.id });
  await expect(client.call('turns.start', { threadId: thread.id, prompt: 'archived' })).rejects.toThrow(/archived/);
  await client.call('threads.archive', { threadId: thread.id, archived: false });
  await client.call('turns.start', { threadId: thread.id, prompt: 'again' });
  await vi.runAllTimersAsync();
  await client.settled();
  client.close();
});

test.each([
  ['stop', '[permission] question'], ['archive', '[permission] question'], ['remove', '[permission] question'],
  ['stop', 'question'], ['archive', 'question'], ['remove', 'question']
] as const)('fake %s drains its own %s turn and leaves other requests pending', async (action, prompt) => {
  vi.useFakeTimers();
  const client = new FakeClient({ delayMs: 1 });
  await client.connect();
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
  client.close();
});

test('fake probes expose distinct OpenCode, Codex, pi, Grok, Muse and Antigravity catalogs', async () => {
  vi.useFakeTimers();
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
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
  client.close();
});

test('fake probes use descriptor models for protocols without probing', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  const { loaded } = await client.call('providers.list', {});
  for (const [providerId, accountId] of [['claude', 'a-claude-main'], ['echo', 'a-echo']] as const) {
    expect((await client.call('providers.probe', { providerId, accountId })).models)
      .toEqual(loaded.find((provider) => provider.id === providerId)?.models);
  }
  client.close();
});

test('fake keeps forced isolation when a provider forbids default accounts', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  const account = await client.call('accounts.add', { providerId: 'antigravity', label: 'Isolated', useDefaultLocation: true });
  expect(account.isolationDir).not.toBeNull();
  client.close();
});

test('fake probes reject invalid provider/account pairs and unavailable agents', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  await expect(client.call('providers.probe', { providerId: 'missing', accountId: 'a-echo' })).rejects.toThrow(/provider/);
  await expect(client.call('providers.probe', { providerId: 'opencode', accountId: 'missing' })).rejects.toThrow(/account/);
  await expect(client.call('providers.probe', { providerId: 'opencode', accountId: 'a-echo' })).rejects.toThrow(/another provider/);
  await expect(client.call('providers.probe', { providerId: 'antigravity', accountId: 'a-antigravity' })).rejects.toThrow(/not available/);
  client.close();
});


test.each(['drop', 'close'] as const)('fake speech releases abandoned requests on %s, even when the retry reuses its ID', async action => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  const { revision } = await client.call('speech.status', {});
  const first = client.call('speech.transcribe', { requestId: 'same', revision, audio: '' });
  const abandoned = expect(first).rejects.toThrow();
  await expect(client.call('speech.transcribe', { requestId: 'overlap', revision, audio: '' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  client[action]();
  await abandoned;
  await client.restore();
  try {
    expect((await client.call('speech.transcribe', { requestId: 'same', revision, audio: '' })).text).toBeTruthy();
  } finally { client.close(); }
});

test('fake panel.open refuses what the core refuses and names the file by its relative path', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('fake todos hold the core limits: a known status and at most TODO_TEXT_MAX characters', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    await expect(client.call('todos.add', { threadId: 't-trace', text: 'x'.repeat(TODO_TEXT_MAX + 1) })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    const card = await client.call('todos.add', { threadId: 't-trace', text: 'Write the fake guards' });
    await expect(client.call('todos.update', { threadId: 't-trace', todoId: card.id, status: 'finished' as never, text: 'moved anyway' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(client.call('todos.update', { threadId: 't-trace', todoId: card.id, text: 'x'.repeat(TODO_TEXT_MAX + 1) })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    const list = await client.call('todos.list', { threadId: 't-trace' });
    expect(list.find((todo) => todo.id === card.id)).toMatchObject({ text: 'Write the fake guards', status: 'open' });
  } finally { client.close(); }
});

test('fake files and diffs stay inside the thread directory like the core', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    await expect(client.call('files.read', { threadId: 't-trace', path: '../boite-legacy/README.md' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(client.call('files.read', { threadId: 't-trace', path: 'src/missing.ts' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(client.call('files.list', { threadId: 't-trace', path: '..' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(client.call('files.list', { threadId: 't-trace', path: 'nowhere' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(client.call('files.write', { threadId: 't-trace', path: '../escape.txt', text: 'x' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(client.call('files.write', { threadId: 't-trace', path: 'nowhere/new.txt', text: 'x' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(client.call('git.diff', { threadId: 't-trace', path: '../outside.ts' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    expect((await client.call('files.read', { threadId: 't-trace', path: './docs//guide/editor.md' })).path).toBe('docs/guide/editor.md');
    expect((await client.call('files.list', { threadId: 't-trace', path: 'docs/' })).map((entry) => entry.path)).toContain('docs/guide');
  } finally { client.close(); }
});
