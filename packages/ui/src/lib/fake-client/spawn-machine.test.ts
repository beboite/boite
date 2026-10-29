import { afterEach, expect, test } from 'vitest';
import { FakeClient } from '../fake-client';
import { fakeCore } from './coordination';

/* `agent.spawn --machine` in the in-memory client refuses as the core's `memberNamed` and remote spawn do. */

const clients: FakeClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });

async function machine(id: string, name = id, delayMs = 0): Promise<FakeClient> {
  const client = new FakeClient({ delayMs, coreId: id, coreName: name, publicUrl: `https://${id}.test` });
  clients.push(client);
  await client.connect();
  return client;
}

test('a spawn on another machine names this machine, an unknown one, a shared name and an absent one as the core does', async () => {
  const desk = await machine('desk'), pc = await machine('pc');
  await desk.call('group.create', { name: 'Home' });
  await pc.call('group.join', { invite: (await desk.call('group.invite', {})).invite });
  const spawn = (to: string) => desk.call('agent.spawn', { threadId: 't-trace', project: 'notes', prompt: 'Print the letter', requestId: `spawn-${to}`, machine: to });

  await expect(spawn('desk')).rejects.toThrow('agent.spawn.machine: desk is this machine; leave --machine out');
  await expect(spawn('nowhere')).rejects.toMatchObject({ message: 'agent.spawn.machine: no machine nowhere in this group; the others are pc', data: { field: 'machine', expected: ['pc'] } });
  await expect(spawn('pc')).rejects.toThrow('pc does not let the other machines of its group start threads there');

  // A member the page no longer reaches did not answer; its switch is not known to be off.
  pc.close();
  await expect(spawn('pc')).rejects.toThrow('pc did not answer');

  const twin = await machine('fade01', 'pc');
  await twin.call('group.join', { invite: (await desk.call('group.invite', {})).invite });
  await expect(spawn('pc')).rejects.toThrow('agent.spawn.machine: 2 machines are named pc; name one by a core id prefix: pc, fade01');
});

test('thread new --model picks from this machine\'s models, or with --machine from that machine\'s, as the core does', async () => {
  const desk = await machine('desk'), pc = await machine('pc');
  await desk.call('group.create', { name: 'Home' });
  await pc.call('group.join', { invite: (await desk.call('group.invite', {})).invite });
  const label = (choice: { providerId: string; model: string }) => `${choice.providerId}/${choice.model}`;
  const own = (await desk.call('agent.projects', { threadId: 't-trace' })).find(project => project.current)!;
  const spawn = (params: { requestId: string; model?: string; effort?: string; machine?: string }) => desk.call('agent.spawn', { threadId: 't-trace', project: params.machine === undefined ? own.name : 'notes', prompt: 'Read the parser', ...params });

  const here = await desk.call('delegation.models', { threadId: 't-trace' });
  const other = here.choices.find(choice => !choice.current && choice.efforts.length > 0)!;
  const spawned = await spawn({ requestId: 'model-1', model: label(other), effort: other.efforts[0]! });
  expect(spawned.thread).toMatchObject({ providerId: other.providerId, model: other.model, effort: other.efforts[0] });
  await expect(spawn({ requestId: 'model-2', model: 'nothing-like-it' })).rejects.toMatchObject({
    message: 'model: no installed model matches "nothing-like-it"; run boite delegate models', data: { field: 'model', expected: here.choices.map(label) },
  });

  await expect(desk.call('delegation.models', { threadId: 't-trace', machine: 'pc' })).rejects.toThrow('boite settings request groupThreads true --machine pc --why');
  await pc.call('settings.set', { groupThreads: true });
  const there = await desk.call('delegation.models', { threadId: 't-trace', machine: 'pc' });
  expect(there.choices.length).toBeGreaterThan(0);
  await expect(spawn({ requestId: 'remote-1', machine: 'pc', model: 'nothing-like-it' })).rejects.toMatchObject({
    message: 'model: no installed model matches "nothing-like-it"; run boite delegate models --machine pc', data: { field: 'model', expected: there.choices.map(label) },
  });
  await expect(spawn({ requestId: 'remote-2', machine: 'pc', model: label(there.choices[0]!) })).rejects.toThrow('the in-memory client does not start threads on another machine');
});

test('delegate spawn --machine starts the subagent on that machine, and its parent sees it there with its result', async () => {
  const desk = await machine('desk'), pc = await machine('pc');
  await desk.call('group.create', { name: 'Home' });
  await pc.call('group.join', { invite: (await desk.call('group.invite', {})).invite });
  const spawn = (params: { requestId: string; task?: string; model?: string; project?: string }) => desk.call('delegation.spawn', { threadId: 't-trace', task: 'Read the notes', machine: 'pc', ...params });

  await expect(spawn({ requestId: 'sub-1' })).rejects.toThrow('boite settings request groupThreads true --machine pc --why');
  await pc.call('settings.set', { groupThreads: true });
  await expect(spawn({ requestId: 'sub-1', project: 'nothing' })).rejects.toMatchObject({ message: expect.stringContaining('pc has no project named nothing; name one of its projects with --project'), data: { field: 'project' } });
  await expect(spawn({ requestId: 'sub-1', model: 'nothing-like-it' })).rejects.toThrow('model: no installed model matches "nothing-like-it"; run boite delegate models --machine pc');

  // A new child has its own state, even when the parent has private or pending work.
  const parent = fakeCore('desk')!.thread('t-trace');
  Object.assign(parent, { incognito: true, pendingAnswers: ['answer for the parent'], openQuestions: 1 });
  // Without --project it works there in the project named like the parent's.
  const child = await spawn({ requestId: 'sub-1' });
  expect(child.machine).toEqual({ coreId: 'pc', name: 'pc' });
  expect(child.thread.parentThreadId).toBe('t-trace');
  const there = await pc.call('threads.get', { threadId: child.thread.id });
  expect(there.projectId).toBe('p-boite');
  expect(there.parentThreadId).toBeUndefined();
  expect(there.incognito).toBeUndefined();
  expect(there.pendingAnswers ?? []).toEqual([]);
  expect(there.openQuestions ?? 0).toBe(0);
  expect((await spawn({ requestId: 'sub-1' })).thread.id).toBe(child.thread.id);
  await expect(spawn({ requestId: 'sub-1', task: 'Read other notes' })).rejects.toThrow('requestId already used for different content');

  const waited = await desk.call('delegation.wait', { threadId: 't-trace', agentId: child.thread.id, timeoutMs: 5000 });
  expect(waited.state).toBe('result_available');
  expect(waited.timedOut).toBe(false);
  const view = await desk.call('delegation.get', { threadId: 't-trace' });
  const agent = view.agents.find(entry => entry.thread.id === child.thread.id)!;
  expect(agent).toMatchObject({ machine: { coreId: 'pc', name: 'pc' }, task: 'Read the notes' });
  expect(agent.result).not.toBeNull();
  expect(view.messages.filter(letter => letter.origin === 'result' && letter.from.coreId === 'pc' && letter.from.threadId === child.thread.id)).toHaveLength(1);
  const page = await desk.call('delegation.result', { threadId: 't-trace', agentId: child.thread.id, turnId: agent.resultRef!.turnId });
  expect(page.text).toBe(agent.result);

  // A message goes to that machine: the child takes it as a new turn there, and its answer crosses back.
  const send = () => desk.call('delegation.send', { threadId: 't-trace', toThreadId: child.thread.id, requestId: 'more-1', text: 'Read the summary too' });
  // Internal results cross back even when the member's agent socket cannot hear turn.finished.
  pc.becomes('agent', 't-trace');
  const letter = await send();
  expect(letter).toMatchObject({ status: 'delivered', to: { coreId: 'pc', threadId: child.thread.id }, toMachine: 'pc' });
  expect((await send()).id).toBe(letter.id);
  const results = async () => (await desk.call('delegation.get', { threadId: 't-trace' })).messages.filter(entry => entry.origin === 'result' && entry.from.threadId === child.thread.id).length;
  for (let i = 0; i < 400 && await results() < 2; i++) await new Promise(resolve => setTimeout(resolve, 2));
  expect(await results()).toBe(2);
  pc.becomes('owner');
  const steered = await pc.call('threads.get', { threadId: child.thread.id });
  expect(steered.messages.filter(message => message.role === 'user').at(-1)!.parts).toMatchObject([{ type: 'text', text: 'Read the summary too' }]);
  const latest = (await desk.call('delegation.get', { threadId: 't-trace' })).agents.find(entry => entry.thread.id === child.thread.id)!;

  // Archived here, the parent's subagent there is stopped and archived too.
  await desk.call('threads.archive', { threadId: 't-trace' });
  expect((await pc.call('threads.get', { threadId: child.thread.id })).archived).toBe(true);

  // Out of reach, its parent keeps what it last saw.
  pc.close();
  expect((await desk.call('delegation.get', { threadId: 't-trace' })).agents.find(entry => entry.thread.id === child.thread.id)).toMatchObject({ machine: { coreId: 'pc' }, result: latest.result });
});

/** Two machines of one group with group threads on; `delayMs` paces the second one's turns. */
async function group(delayMs = 0) {
  const desk = await machine('desk'), pc = await machine('pc', 'pc', delayMs);
  await desk.call('group.create', { name: 'Home' });
  await pc.call('group.join', { invite: (await desk.call('group.invite', {})).invite });
  await pc.call('settings.set', { groupThreads: true });
  return { desk, pc };
}

test('a wait on a subagent on another machine ends as soon as it asks a question or an approval there', async () => {
  // Paced there, so the wait is under way before the child asks.
  const { desk } = await group(20);
  for (const [kind, task] of [['question', 'Ask a question first'], ['permission', 'Write the notes [permission]']] as const) {
    const child = await desk.call('delegation.spawn', { threadId: 't-trace', task, machine: 'pc', requestId: kind });
    expect(child.needsInput).toBeUndefined();
    const wait = desk.call('delegation.wait', { threadId: 't-trace', agentId: child.thread.id, timeoutMs: 60_000 });
    wait.catch(() => {});
    const early = await Promise.race([wait, new Promise(resolve => setTimeout(resolve, 3000, 'still waiting'))]);
    expect(early).toMatchObject({ state: 'needs_input', timedOut: false, agents: [{ needsInput: [expect.objectContaining({ kind })] }] });
  }
});

test('subagents here and on another machine counting from the same seed keep apart, only the ones here count turns, and the owner\'s model rule holds there', async () => {
  const { desk } = await group(20);
  const here = fakeCore('desk')!, there = fakeCore('pc')!;
  const spawn = (requestId: string, task: string, machine?: string) => desk.call('delegation.spawn', { threadId: 't-trace', task, requestId, ...(machine === undefined ? {} : { machine }) });
  const turns = async () => (await desk.call('delegation.get', { threadId: 't-trace' })).turnsUsed;
  const used = await turns();
  // Both machines would name their next thread alike.
  here.seq = there.seq = Math.max(here.seq, there.seq);
  const near = await spawn('near', 'Read the parser');
  const far = await spawn('far', 'Read the notes', 'pc');
  expect((await spawn('far', 'Read the notes', 'pc')).thread.id).toBe(far.thread.id);
  there.seq = Math.max(here.seq, there.seq);
  const later = await spawn('later', 'Read the lexer', 'pc');
  const next = await spawn('next', 'Read the tests');
  expect(new Set([near, far, later, next].map(agent => agent.thread.id)).size).toBe(4);
  // As the core: only the turns this machine admits count, a child there spends there.
  expect(await turns()).toBe(used + 2);

  // Each public call reaches the child it names.
  const view = await desk.call('delegation.get', { threadId: 't-trace' });
  expect([near, far, later, next].map(agent => view.agents.filter(entry => entry.thread.id === agent.thread.id).map(entry => entry.machine?.coreId ?? 'desk'))).toEqual([['desk'], ['pc'], ['pc'], ['desk']]);
  const waited = await desk.call('delegation.wait', { threadId: 't-trace', agentId: far.thread.id, timeoutMs: 5000 });
  expect(waited.agents.map(agent => [agent.machine?.coreId, waited.state])).toEqual([['pc', 'result_available']]);
  const page = await desk.call('delegation.result', { threadId: 't-trace', agentId: far.thread.id, turnId: waited.agents[0]!.resultRef!.turnId });
  expect(page.text).toBe(waited.agents[0]!.result);
  expect((await desk.call('delegation.send', { threadId: 't-trace', toThreadId: near.thread.id, requestId: 'near-1', text: 'Read the tests too' })).to).toEqual({ coreId: 'local', threadId: near.thread.id });
  await desk.call('delegation.wait', { threadId: 't-trace', agentId: later.thread.id, timeoutMs: 5000 });
  expect((await desk.call('delegation.send', { threadId: 't-trace', toThreadId: later.thread.id, requestId: 'later-1', text: 'Read the tests too' })).to).toEqual({ coreId: 'pc', threadId: later.thread.id });

  // Limited to this conversation's model and the profiles, the other machine's list says so too.
  await desk.call('delegation.configure', { threadId: 't-trace', config: { enabled: true, paused: false, profiles: [], anyModel: false } });
  expect((await desk.call('delegation.models', { threadId: 't-trace' })).anyModel).toBe(false);
  expect((await desk.call('delegation.models', { threadId: 't-trace', machine: 'pc' })).anyModel).toBe(false);
});
