import { expect, vi } from 'vitest';
import type { AgentProfile, Message } from '@boite/contracts';
import { test } from '../test/fake-client';
import { deskState } from './agent-desk';
import { FakeAgents } from './fake-agents';

const selection = { providerId: 'echo', accountId: 'a-echo', model: null, effort: null, permissionMode: 'default' as const };
const promptOf = (messages: Message[], turnId: string) => messages.find(m => m.turnId === turnId && m.role !== 'assistant')?.parts.find(p => p.type === 'text');

test('creating an agent makes its thread and starts its first turn there, labelled in the conversation', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  const agent = await client.call('agents.profile.save', { value: { name: 'Scout', domain: '', instructions: 'Check the issues every morning.', avatar: '', selection, status: 'active' } });
  const { threadId } = await client.call('agents.open', { agentId: agent.id });
  const thread = await client.call('threads.get', { threadId });
  expect(thread.agentSessionId).toBeTruthy();
  expect(thread.projectId).toBeNull();
  const intro = thread.turns[0]!;
  expect(intro.execution?.operation).toBe('event');
  expect(promptOf(thread.messages, intro.id)).toMatchObject({ displayText: 'Just created', text: expect.stringContaining('Check the issues every morning.') });
  // The same thread comes back on every open.
  expect((await client.call('agents.open', { agentId: agent.id })).threadId).toBe(threadId);
  const snapshot = await client.call('agents.snapshot', {});
  expect(snapshot.sessions).toEqual([expect.objectContaining({ agentId: agent.id, threadId })]);
  expect(snapshot.status[0]).toMatchObject({ agentId: agent.id, threadId });
});

test('changed instructions wake the agent once; a rename does not', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  let agent = await client.call('agents.profile.save', { value: { name: 'Scout', domain: '', instructions: 'Old', avatar: '', selection, status: 'active' } });
  const { threadId } = await client.call('agents.open', { agentId: agent.id });
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId })).status).toBe('idle'));
  agent = await client.call('agents.profile.save', { id: agent.id, expectedRevision: agent.revision, value: { ...agent, name: 'Scouty' } });
  agent = await client.call('agents.profile.save', { id: agent.id, expectedRevision: agent.revision, value: { ...agent, instructions: 'New' } });
  const thread = await client.call('threads.get', { threadId });
  expect(thread.turns.map(t => promptOf(thread.messages, t.id)?.displayText)).toEqual(['Just created', 'Instructions changed']);
});

test('a routine run is a routine turn on the agent\'s thread, and a quiet answer sets its outcome and leaves nothing unread', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  const agent = await client.call('agents.profile.save', { value: { name: 'Scout', domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  const { threadId } = await client.call('agents.open', { agentId: agent.id });
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId })).status).toBe('idle'));
  const routine = await client.call('agents.routine.save', { value: { agentId: agent.id, name: 'Night check', prompt: 'Check the builds.\n\n[quiet] builds green', schedule: { kind: 'daily', time: '20:00', timezone: 'UTC' }, enabled: true, nextAt: null, lastTurnId: null, lastScheduledAt: null } });
  const { turnId } = await client.call('agents.routine.run', { routineId: routine.id, requestId: 'run-night-check-1' });
  await vi.waitFor(async () => expect((await client.call('agents.snapshot', {})).routines[0]!.lastOutcome).toBe('quiet'));
  const thread = await client.call('threads.get', { threadId });
  const turn = thread.turns.find(t => t.id === turnId)!;
  expect(turn.execution?.operation).toBe('routine');
  expect(promptOf(thread.messages, turnId)).toMatchObject({ displayText: 'Routine · Night check' });
  expect(thread.unread).toBe(false);
  expect((await client.call('agents.snapshot', {})).routines[0]!.lastTurnId).toBe(turnId);
  await client.call('agents.routine.remove', { routineId: routine.id });
  expect((await client.call('agents.snapshot', {})).routines).toEqual([]);
});

test('remember appends a dated line to MEMORY.md, and a desk keeps the threads put on it with their own state', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  const agent = await client.call('agents.profile.save', { value: { name: 'Scout', domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  const brain = await client.call('agents.memory.note', { agentId: agent.id, text: 'Releases ship on Fridays.' });
  expect(brain.memory).toMatch(/^- \d{4}-\d{2}-\d{2}: Releases ship on Fridays\.$/);
  const watch = await client.call('agents.watch', { agentId: agent.id, watchThreadId: 't-trace', watched: true });
  expect(watch).toMatchObject({ threadId: 't-trace', origin: 'followed' });
  expect((await client.call('agents.snapshot', {})).watches.map(w => w.threadId)).toEqual(['t-trace']);
  await client.call('agents.watch', { agentId: agent.id, watchThreadId: 't-trace', watched: false });
  expect((await client.call('agents.snapshot', {})).watches).toEqual([]);
});

test('the demo has an agent at work on a live step, one waiting on a login and one at rest until its routine', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0, agentsDemo: true });
  const snapshot = await client.call('agents.snapshot', {});
  const by = (name: string) => { const agent = snapshot.profiles.find(p => p.name === name)!; return snapshot.status.find(s => s.agentId === agent.id)!; };
  expect(by('Nova')).toMatchObject({ state: 'working', activity: 'Run the UI tests' });
  expect(by('Iris').state).toBe('waiting');
  expect(by('Mira')).toMatchObject({ state: 'idle', nextWake: expect.objectContaining({ label: 'Evening review' }), unread: 1 });
  const nova = snapshot.profiles.find(p => p.name === 'Nova')!;
  // Its desk holds every state a desk card has, the question answerable in place.
  const desk = snapshot.watches.filter(w => w.agentId === nova.id);
  expect(desk.map(w => deskState(w)).sort()).toEqual(['merged', 'needs-you', 'review', 'stalled', 'working']);
  expect(desk.find(w => w.state === 'needs-you')?.question?.options).toEqual(['Lucide', 'Phosphor']);
  expect(desk.find(w => w.pullRequest?.number === 482)?.pullRequest?.checks).toBe('failing');
  // Stop ends the live step as the core stops a turn.
  await client.call('turns.stop', { threadId: by('Nova').threadId! });
  await vi.waitFor(async () => expect((await client.call('agents.snapshot', {})).status.find(s => s.agentId === nova.id)!.state).toBe('idle'));
});

test('an agent\'s own thread reads only its own agent', () => {
  const agents = new FakeAgents(() => {}, { create: (agent: AgentProfile) => `t-${agent.name}`, wake: () => { throw new Error('no wakes here'); } });
  const one = agents.seedAgent({ name: 'One', domain: '', instructions: '', avatar: '', selection, status: 'active' }, 1);
  agents.seedAgent({ name: 'Two', domain: '', instructions: '', avatar: '', selection, status: 'active' }, 2);
  expect(agents.snapshot(one.threadId).profiles.map(p => p.name)).toEqual(['One']);
  expect(agents.snapshot().profiles.map(p => p.name)).toEqual(['One', 'Two']);
});
