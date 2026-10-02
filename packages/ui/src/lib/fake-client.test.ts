import { afterEach, expect, test, vi } from 'vitest';
import { FakeClient } from './fake-client';
import { DEFAULT_DELEGATION_CONFIG, RpcErrorCode, TODO_TEXT_MAX, type RpcMethodName, type Turn } from '@boite/contracts';
import { FAKE_AUTO_COMPACT_SETTLE_MS } from './fake-client/turns';

afterEach(() => vi.useRealTimers());

test('moving a fake thread drops PR metadata from its previous branch', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    expect((await client.call('threads.pullRequest', { threadId: 't-trace' }))?.number).toBe(84);
    const moved = await client.call('threads.move', { threadId: 't-trace', projectId: 'p-notes' });
    expect(moved.branch).not.toBeNull();
    expect(await client.call('threads.pullRequest', { threadId: moved.id })).toBeNull();
    const drafts = await client.call('projects.drafts', {});
    expect((await client.call('threads.move', { threadId: moved.id, projectId: drafts.id })).branch).toBeNull();
    expect(await client.call('threads.pullRequest', { threadId: moved.id })).toBeNull();
  } finally { client.close(); }
});

test('rewinding a live follow-up keeps the turn belonging to earlier messages', async () => {
  const client = new FakeClient({ delayMs: 5 });
  await client.connect();
  try {
    const turn = await client.call('turns.start', { threadId: 't-trace', prompt: '[tools] Keep reading' });
    const params = { threadId: 't-trace', turnId: turn.id, prompt: 'Change direction', clientRequestId: 'rewind_follow_up' };
    expect(await client.call('turns.steer', params)).toEqual({ accepted: true });
    await client.settled();
    const target = (await client.call('threads.get', { threadId: 't-trace' })).messages.at(-1)!;
    const rewound = await client.call('threads.rewind', { threadId: 't-trace', messageId: target.id });
    expect(rewound.thread.turns.some(item => item.id === turn.id)).toBe(true);
    expect(rewound.thread.messages.filter(message => message.role === 'user' && message.turnId === turn.id)).toHaveLength(1);
    // As on the core, the receipt for the removed input no longer acknowledges it.
    expect(await client.call('turns.steer', params)).toEqual({ accepted: false });
  } finally { client.close(); }
});

test('fake agent receives selected element context while the visible prompt stays compact', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test.each(['question', '[permission]', '[tool]', '[tool-stream]', '[diff]', '[doc]', '[image]', '[spawn:fixture]'])('selected page data cannot activate the fake control marker %s', async marker => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('fake process events reach a client subscribed to that thread only, like the core', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('fake resources.list carries only threads running something now, like the core', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    const resources = await client.call('resources.list', {});
    // t-trace only ran processes that exited: its history is in trace.get, not here.
    expect((await client.call('trace.get', { threadId: 't-trace' })).length).toBeGreaterThan(0);
    expect(resources.map(entry => entry.threadId)).not.toContain('t-trace');
    for (const entry of resources) {
      expect(entry.live.length).toBeGreaterThan(0);
      expect(entry.live.every(record => record.exitedAt === null)).toBe(true);
      expect(entry.load.processes).toBeGreaterThan(0);
    }
  } finally { client.close(); }
});

test('fake artifacts refuse publication if the thread is archived during the media read', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
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
  } finally { fetchMedia.mockRestore(); read.mockRestore(); client.close(); }
});

test('fake delegation enforces family access and keeps request IDs idempotent', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('fake agent.spawn starts a real thread marked at both ends and keeps retries idempotent', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('fake agent.addProject registers a folder once, with a line in the caller, and refuses a relative one', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('paired fake clients can inspect, message and stop delegation but cannot configure or spawn', async () => {
  const phone = new FakeClient({ delayMs: 0, principal: 'session', delegationDemo: true });
  await phone.connect();
  try {
    const view = await phone.call('delegation.get', { threadId: 't-trace' });
    expect(view.agents).toHaveLength(2);
    await expect(phone.call('delegation.configure', { threadId: 't-trace', config: view.config })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(phone.call('delegation.spawn', { threadId: 't-trace', profileId: 'reviewer', task: 'No', requestId: 'phone-spawn' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(phone.call('delegation.send', { threadId: 't-trace', toThreadId: view.agents[0]!.thread.id, text: 'Status?', requestId: 'phone-send' })).resolves.toMatchObject({ origin: 'user' });
    await expect(phone.call('delegation.stop', { threadId: 't-trace', agentId: view.agents[0]!.thread.id })).resolves.toMatchObject({ stopped: 1 });
  } finally { phone.close(); }
});

test('fake delegation starts independent children together and returns current idempotent state', async () => {
  const client = new FakeClient({ delayMs: 2 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('child manual turns update usage without a turn budget or duplicate retry', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('fake delegation launches thirty children despite legacy quotas from an older client', async () => {
  const client = new FakeClient({ delayMs: 2 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('a child stop targets itself, preserves its sibling and cannot target that sibling', async () => {
  const client = new FakeClient({ delayMs: 4 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('fake delegation reserves result request IDs and emits no result when pausing a running team', async () => {
  const client = new FakeClient({ delayMs: 3 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('regular Stop cancels queued children separately and pauses the team when stopping its parent', async () => {
  const client = new FakeClient({ delayMs: 4 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('telemetry handlers retain export and deletion state through the typed dispatcher', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    expect(await client.call('telemetry.state', {})).toEqual({ mode: 'basic', configured: true, pendingDeletion: false });
    await expect(client.call('telemetry.export', {})).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
    await client.call('telemetry.configure', { mode: 'enhanced' });
    expect(await client.call('telemetry.export', {})).toEqual({ events: [], truncated: false });
    expect(await client.call('telemetry.configure', { mode: 'off' })).toMatchObject({ mode: 'off', pendingDeletion: true });
    expect(await client.call('telemetry.retryForget', {})).toMatchObject({ mode: 'off', pendingDeletion: false });
  } finally { client.close(); }
});

test.each(['toString', 'constructor', '__proto__', 'missing.method'])('unknown RPC method %s is refused', async method => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    await expect(client.call(method as RpcMethodName, {})).rejects.toMatchObject({ code: RpcErrorCode.MethodNotFound });
  } finally { client.close(); }
});

test('coordination stays scoped to its core and paired devices can only inspect it', async () => {
  const first = new FakeClient({ delayMs: 0, coreId: 'core-first', coreName: 'First', publicUrl: 'https://first.test' });
  const second = new FakeClient({ delayMs: 0, coreId: 'core-second', coreName: 'Second', publicUrl: 'https://second.test' });
  const phone = new FakeClient({ delayMs: 0, principal: 'session', coreId: 'core-phone' });
  await Promise.all([first.connect(), second.connect(), phone.connect()]);

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
  expect((await first.call('collaboration.read', { threadId: 't-trace', target: { coreId: b.coreId, threadId: 't-trace' } })).entries.length).toBeGreaterThan(0);
  await expect(phone.call('collaboration.bridge.register', { coreId: a.coreId, enabled: true })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  const letter = await first.call('collaboration.send', { threadId: 't-trace', to: { coreId: b.coreId, threadId: 't-trace' }, text: 'Wait for the build', requestId: 'remote' });
  const project = (await first.call('projects.list', {})).find(project => project.id === 'p-boite')!;
  expect(letter.from.project).toBe(project.name);
  expect(letter.toProject).toBe(project.name);
  expect(letter.toMachine).toBe('Second');
  expect((await second.call('collaboration.get', { threadId: 't-trace' })).messages).toEqual([letter]);
  expect((await second.call('collaboration.get', { threadId: 't-trace' })).sent).toBe(0);
  await first.call('collaboration.untrust', { coreId: b.coreId });
  expect(await first.call('collaboration.peers', {})).toEqual([]);
  await first.call('threads.archive', { threadId: 't-trace', archived: true });
  expect((await first.call('collaboration.directory', { threadId: 't-trace' })).agents).toEqual([]);
  await expect(first.call('collaboration.send', { threadId: 't-trace', to: { coreId: a.coreId, threadId: 't-descriptors' }, text: 'Archived sender', requestId: 'archived' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
  await expect(first.call('collaboration.configure', { threadId: 't-trace', config: { mode: 'brief', resources: '', remote: true, paused: false } })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
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

test('fake speech downloads a model from a link, uses it, and removing it hands back the default', async () => {
  vi.useFakeTimers();
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    await expect(client.call('speech.install', { url: 'http://models.example/ggml-tiny.bin' })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
    const started = await client.call('speech.install', { url: 'https://models.example/ggml-tiny.bin' });
    expect(started.downloading).toMatch(/^custom-[a-f0-9]{12}$/);
    expect(started.models.at(-1)).toMatchObject({ kind: 'custom', name: 'ggml-tiny.bin', host: 'models.example', installed: false });
    await vi.advanceTimersByTimeAsync(20_000);
    const done = await client.call('speech.status', {});
    expect(done.installing).toBe(false);
    expect((await client.call('speech.config', {})).model).toBe(started.downloading);
    await client.call('speech.uninstall', { model: started.downloading! });
    expect((await client.call('speech.config', {})).model).toBe('small-q5_1');
    expect((await client.call('speech.status', {})).models.some(model => model.kind === 'custom')).toBe(false);
  } finally { client.close(); vi.useRealTimers(); }
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

test('fake settings ignore retired launch limits from older clients', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  const legacy = { maxConcurrentTurns: 1, perAccountConcurrency: 1, warmProcessMinutes: 3 };
  const settings = await client.call('settings.set', legacy);
  expect(settings.warmProcessMinutes).toBe(3);
  expect(settings).not.toHaveProperty('maxConcurrentTurns');
  expect(settings).not.toHaveProperty('perAccountConcurrency');
  const scheduler = await client.call('scheduler.get', {});
  expect(scheduler).not.toHaveProperty('maxConcurrentTurns');
  expect(scheduler).not.toHaveProperty('perAccountConcurrency');
  client.close();
});

test('fake settings store a pasted address as its origin and refuse what the core refuses', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
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

test('fake [ask] leaves a card nobody waits on, and its answer opens the next turn', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    const { id: threadId } = await newThread(client);
    await client.call('turns.start', { threadId, prompt: '[ask] [background] serve it' });
    await client.settled();
    const thread = await client.call('threads.get', { threadId });
    // The turn ended with the question still open and the shell still listed.
    expect(thread.status).toBe('idle');
    expect(thread.background?.map((task) => task.kind)).toEqual(['shell']);
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
    expect((await client.call('threads.get', { threadId })).background).toEqual([]);
  } finally { client.close(); }
});

test('fake async answers given while a turn runs start one turn together after it', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('an account check or provider reload that changes nothing stays silent, as on the core', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('fake hook counters move the way the core ledger moves them', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('deleted fake conversations survive closing and reconnecting with their history and archive flags', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('fake retention keeps indefinite deletions and applies a shorter saved delay to existing deletions', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('the fake core compacts by itself at the end of a turn once the threshold is reached', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('fake /btw admission, duplicate refusal and cancellation match the core without changing history', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});

test('fake side forks consume only the matching completed result and expire dismissed answers', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
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
  } finally { client.close(); }
});
