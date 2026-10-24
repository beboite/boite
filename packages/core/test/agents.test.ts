import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { MessagePart } from '@boite/contracts';
import { connect } from '../src/client.ts';
import type { CoreClient } from '../src/client.ts';
import { INTRO_PROMPT } from '../src/agents/store.ts';
import { agentValue, echoAccount, makeAgent, settled, turnsOf } from './agent-fixture.ts';
import { echoThread, startTestCore, testProject, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let h: TestCore;
let client: CoreClient;
beforeEach(async () => { h = await startTestCore(); client = await h.connect(); });
afterEach(async () => { await h.stop(); });

const opening = (threadId: string, turnId: string) => h.core.journal.listMessages(threadId).find(m => m.turnId === turnId && m.role !== 'assistant');
const text = (part: MessagePart | undefined) => part?.type === 'text' ? part : null;

test('creating an agent creates its thread and starts its introduction there', async () => {
  const agent = await client.call('agents.profile.save', { value: agentValue(echoAccount(h)) });
  const { threadId } = await client.call('agents.open', { agentId: agent.id });
  const thread = h.core.threads.require(threadId);
  expect(thread).toMatchObject({ projectId: null, title: 'Ada', agentSessionId: h.core.workforce.sessionOf(agent.id)!.id });
  // The introduction starts at once, as an event turn opened by Boite.
  const [intro] = turnsOf(h, threadId);
  expect(intro?.execution?.operation).toBe('event');
  const line = opening(threadId, intro!.id)!;
  expect(line.role).toBe('system');
  expect(text(line.parts[0])).toMatchObject({ text: INTRO_PROMPT, displayText: 'Just created' });
  await waitFor(() => settled(h, threadId), 10_000);
  const snapshot = await client.call('agents.snapshot', {});
  expect(snapshot.sessions).toEqual([expect.objectContaining({ agentId: agent.id, threadId })]);
  expect(snapshot.status[0]).toMatchObject({ agentId: agent.id, threadId, state: 'idle', problem: null, today: { turns: expect.any(Number), wakes: 1 } });
  expect(snapshot.status[0]!.last?.text.length).toBeGreaterThan(0);
  expect(snapshot.watches).toEqual([]);
});

test('an agent created while wakes are paused introduces itself once they resume', async () => {
  await client.call('agents.limits.set', { paused: true });
  const agent = await client.call('agents.profile.save', { value: agentValue(echoAccount(h)) });
  const { threadId } = await client.call('agents.open', { agentId: agent.id });
  await Bun.sleep(700);
  expect(turnsOf(h, threadId)).toEqual([]);
  expect((await client.call('agents.snapshot', {})).status[0]!.state).toBe('paused');
  await client.call('agents.limits.set', { paused: false });
  await waitFor(() => turnsOf(h, threadId).length === 1 && settled(h, threadId), 10_000);
  expect(turnsOf(h, threadId)[0]!.execution?.operation).toBe('event');
});

test('a user message on an agent thread is an ordinary turn: queued, steered, stopped', async () => {
  const { threadId } = await makeAgent(h, client);
  const before = turnsOf(h, threadId).length;
  const turn = await client.call('turns.start', { threadId, prompt: 'Look at this [sleep:60000]' });
  expect(turn.execution?.operation).toBeUndefined();
  expect(['queued', 'running']).toContain(turn.status);
  expect(opening(threadId, turn.id)?.role).toBe('user');
  await waitFor(() => h.core.threads.require(threadId).status === 'running');
  // A second message while it works is the thread's own business: steered into the running turn.
  const steered = await client.call('turns.steer', { threadId, turnId: turn.id, prompt: 'and this', clientRequestId: 'steer-agent-001' });
  expect(steered.accepted).toBe(true);
  expect(await thrown(client.call('turns.start', { threadId, prompt: 'again' }))).toThrow('in-flight');
  expect((await client.call('turns.stop', { threadId })).stopped).toBe(true);
  await waitFor(() => settled(h, threadId));
  expect(turnsOf(h, threadId).slice(before).map(t => t.status)).toEqual(['stopped']);
  const capabilities = await client.call('threads.capabilities', { threadId });
  expect(capabilities.steering.reason).not.toBe('agent-session');
  expect(capabilities.fork.seeded.available).toBe(false);
});

test('an agent thread is never deleted; archiving the agent archives it and the agent comes back with it', async () => {
  const { agent, threadId } = await makeAgent(h, client);
  expect(await thrown(client.call('threads.remove', { threadId }))).toThrow("a bot's thread goes when the bot is archived");
  const archived = await client.call('agents.profile.save', { id: agent.id, expectedRevision: agent.revision, value: { ...agent, status: 'archived' } });
  expect(h.core.threads.require(threadId).archived).toBe(true);
  expect((await client.call('agents.snapshot', {})).status[0]!.state).toBe('archived');
  await client.call('agents.profile.save', { id: agent.id, expectedRevision: archived.revision, value: { ...archived, status: 'active' } });
  expect(h.core.threads.require(threadId).archived).toBe(false);
});

test('a bot thread removed with its project tells the clients, so no snapshot keeps naming it', async () => {
  const { threadId } = await makeAgent(h, client);
  // A bot carried over from an older core may keep its thread in a project.
  const project = await testProject(h, client);
  h.core.journal.putThread({ ...h.core.threads.require(threadId), projectId: project.id });
  // Each event's dispatch notes whether it invalidated the snapshot: the archive that comes first may go out
  // before the removal, and then nothing else would tell the clients the thread is gone.
  const store = h.core.workforce as unknown as { changed: () => void };
  const changed = store.changed.bind(store);
  let invalidated = false;
  store.changed = () => { invalidated = true; changed(); };
  const told: Record<string, boolean> = {};
  const off = h.core.bus.onAny((name, payload) => {
    if ((payload as { threadId?: string; id?: string } | null)?.threadId === threadId || (payload as { id?: string } | null)?.id === threadId) told[name] = invalidated;
    invalidated = false;
  });
  try { await client.call('projects.remove', { projectId: project.id }); } finally { off(); }
  expect(h.core.journal.getThread(threadId)).toBeNull();
  expect(told).toMatchObject({ 'thread.updated': true, 'thread.removed': true });
});

test('renaming a bot keeps the route its thread was moved to; a new route on the bot moves it', async () => {
  const { agent, threadId } = await makeAgent(h, client);
  // The user moved the conversation itself to another mode.
  await client.call('threads.update', { threadId, permissionMode: 'plan' });
  const renamed = await client.call('agents.profile.save', { id: agent.id, expectedRevision: agent.revision, value: { ...agent, name: 'Ada Two' } });
  expect(h.core.threads.require(threadId)).toMatchObject({ title: 'Ada Two', permissionMode: 'plan' });
  await client.call('agents.profile.save', { id: agent.id, expectedRevision: renamed.revision, value: { ...renamed, selection: { ...renamed.selection, permissionMode: 'acceptEdits' } } });
  expect(h.core.threads.require(threadId).permissionMode).toBe('acceptEdits');
});

test('agents.open makes the thread again when it was lost', async () => {
  const { agent, threadId } = await makeAgent(h, client);
  h.core.journal.deleteThreads([threadId]);
  const { threadId: again } = await client.call('agents.open', { agentId: agent.id });
  expect(again).not.toBe(threadId);
  expect(h.core.threads.require(again).agentSessionId).toBe(h.core.workforce.sessionOf(agent.id)!.id);
  expect(h.core.workforce.records.list('session')).toHaveLength(1);
});

test('an agent thread reads its own snapshot and nothing of another agent; an ordinary thread reads none', async () => {
  const { agent, threadId } = await makeAgent(h, client);
  const other = await makeAgent(h, client, { name: 'Bea' });
  await client.call('agents.accounts.set', { grants: [{ accountId: echoAccount(h), agentIds: null }] });
  const own = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    const snapshot = await own.call('agents.snapshot', { threadId });
    expect(snapshot.profiles.map(p => p.id)).toEqual([agent.id]);
    expect(snapshot.sessions.map(s => s.threadId)).toEqual([threadId]);
    expect(snapshot.accountGrants).toEqual([]);
    expect(await thrown(own.call('agents.snapshot', { threadId: other.threadId }))).toThrow('is for thread');
    expect(await thrown(own.call('agents.runtime.configure', { threadId, agentId: agent.id, expectedRevision: agent.revision, config: h.core.workforce.resident.config(agent.id) } as never))).toThrow("not one of the agent's methods");
  } finally { own.close(); }
  const { threadId: ordinary } = await echoThread(h, client);
  const plain = await connect(h.url, h.core.agents.tokenFor(ordinary));
  try { expect(await thrown(plain.call('agents.snapshot', { threadId: ordinary }))).toThrow("no bot's thread"); }
  finally { plain.close(); }
});

test('an unused provider account still belongs to its persistent profile', async () => {
  await makeAgent(h, client);
  expect(await thrown(client.call('accounts.remove', { accountId: echoAccount(h) }))).toThrow('this account is used by a bot');
});

test('a paired phone lists agents, opens one and talks to it with turns.start', async () => {
  const { agent, threadId } = await makeAgent(h, client);
  const { grant } = await client.call('pairing.grant', {});
  const phone = await connect(h.url, '', { grant, client: { name: 'Phone', version: 'test' } });
  try {
    expect((await phone.call('agents.snapshot', {})).profiles.map(p => p.id)).toEqual([agent.id]);
    expect(await phone.call('agents.open', { agentId: agent.id })).toEqual({ threadId });
    await phone.call('turns.start', { threadId, prompt: 'From the phone' });
    await waitFor(() => settled(h, threadId) && h.core.journal.listMessages(threadId).some(m => m.role === 'user'));
    expect(await thrown(phone.call('agents.profile.save', { id: agent.id, expectedRevision: agent.revision, value: agent }))).toThrow('owner');
  } finally { phone.close(); }
});

test('an agent created paused introduces itself once it is made active', async () => {
  const agent = await client.call('agents.profile.save', { value: agentValue(echoAccount(h), { status: 'paused' }) });
  const { threadId } = await client.call('agents.open', { agentId: agent.id });
  await Bun.sleep(700);
  expect(turnsOf(h, threadId)).toEqual([]);
  const current = h.core.workforce.records.get('profile', agent.id);
  await client.call('agents.profile.save', { id: agent.id, expectedRevision: current.revision, value: { ...current, status: 'active' } });
  await waitFor(() => turnsOf(h, threadId).length === 1 && settled(h, threadId), 10_000);
  expect(text(opening(threadId, turnsOf(h, threadId)[0]!.id)!.parts[0])).toMatchObject({ displayText: 'Just created' });
});
