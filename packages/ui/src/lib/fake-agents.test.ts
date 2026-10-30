import { expect, vi } from 'vitest';
import { AGENT_MEMORY_MAX, nextAgentOccurrence, type AgentProfile, type AgentSchedule, type Message } from '@boite/contracts';
import { test } from '../test/fake-client';
import { deskState } from './agent-desk';
import { FakeAgents } from './fake-agents';

const selection = { providerId: 'echo', accountId: 'a-echo', model: null, effort: null, permissionMode: 'default' as const };
const promptOf = (messages: Message[], turnId: string) => messages.find(m => m.turnId === turnId && m.role !== 'assistant')?.parts.find(p => p.type === 'text');

test('the fake saves calendar reminders with the same next date as the core', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  const agent = await client.call('agents.profile.save', { value: { name: 'Scout', domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  const schedules: AgentSchedule[] = [
    { kind: 'monthly', day: 31, time: '09:00', timezone: 'Europe/Paris' },
    { kind: 'yearly', month: 2, day: 29, time: '09:00', timezone: 'Asia/Tokyo' },
    { kind: 'once', at: Date.parse('2030-11-14T08:00:00Z') },
  ];
  for (const schedule of schedules) {
    const routine = await client.call('agents.routine.save', { value: { agentId: agent.id, name: schedule.kind, prompt: 'Review the notes', schedule, enabled: true, nextAt: null, lastTurnId: null, lastScheduledAt: null } });
    expect(routine.schedule).toEqual(schedule);
    expect(routine.nextAt).toBe(nextAgentOccurrence(schedule));
  }
});

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

test('an outside event wakes the bot in the fake as in the core, quoted as data under its key', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  const agent = await client.call('agents.profile.save', { value: { name: 'Scout', domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  const { threadId } = await client.call('agents.open', { agentId: agent.id });
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId })).status).toBe('idle'));
  expect(await client.call('agents.event', { agent: 'scout', key: 'ci', text: 'Build failed on main' })).toEqual({ agentId: agent.id, key: 'external:ci' });
  await expect(client.call('agents.event', { agent: 'Scout', key: 'bad key!', text: 'x' })).rejects.toThrow('key');
  const thread = await client.call('threads.get', { threadId });
  expect(promptOf(thread.messages, thread.turns.at(-1)!.id)).toMatchObject({ displayText: 'Outside event ci', text: expect.stringContaining('"Build failed on main"') });
  // As the core: the text is a JSON quote, cut with a note when quoting outgrows the cap, and a shared name is refused.
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId })).status).toBe('idle'));
  await client.call('agents.event', { agent: 'Scout', key: 'noise', text: '"done"\n' + '\u0001'.repeat(15_000) });
  const noisy = await client.call('threads.get', { threadId });
  const text = promptOf(noisy.messages, noisy.turns.at(-1)!.id)!.text;
  expect(text.length).toBeLessThanOrEqual(16_000);
  expect(JSON.parse(/you: ("(?:[^"\\]|\\.)*")/.exec(text)![1]!)).toMatch(/^"done"\n\u0001+$/);
  expect(text).toMatch(/ of 15007 characters\)$/);
  await client.call('agents.profile.save', { value: { name: 'scout', domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  await expect(client.call('agents.event', { agent: 'Scout', text: 'x' })).rejects.toThrow('2 bots are named');
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

test('a routine whose final text block opens with [quiet] is quiet in the fake as in the core, whatever follows the marker', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  const agent = await client.call('agents.profile.save', { value: { name: 'Scout', domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  const { threadId } = await client.call('agents.open', { agentId: agent.id });
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId })).status).toBe('idle'));
  const routine = await client.call('agents.routine.save', { value: { agentId: agent.id, name: 'Inbox', prompt: '[quiet] inbox empty\nNothing needs attention.', schedule: { kind: 'daily', time: '20:00', timezone: 'UTC' }, enabled: true, nextAt: null, lastTurnId: null, lastScheduledAt: null } });
  const { turnId } = await client.call('agents.routine.run', { routineId: routine.id, requestId: 'run-inbox-1' });
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId })).turns.find(t => t.id === turnId)?.status).toBe('done'));
  await vi.waitFor(async () => expect((await client.call('agents.snapshot', {})).routines[0]!.lastTurnId).toBe(turnId));
  expect((await client.call('agents.snapshot', {})).routines[0]!.lastOutcome).toBe('quiet');
  const thread = await client.call('threads.get', { threadId });
  expect(thread.turns.find(t => t.id === turnId)?.quiet).toBe(true);
  expect(thread.unread).toBe(false);
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

test('the fake keeps MEMORY.md under its cap on remember too, as the core does', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  const agent = await client.call('agents.profile.save', { value: { name: 'Scout', domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  const brain = await client.call('agents.brain.get', { agentId: agent.id });
  await client.call('agents.brain.save', { agentId: agent.id, expectedRevision: brain.revision, instructions: brain.instructions, memory: 'x'.repeat(AGENT_MEMORY_MAX - 10) });
  await expect(client.call('agents.memory.note', { agentId: agent.id, text: 'One fact too many.' })).rejects.toThrow(`${AGENT_MEMORY_MAX}`);
  expect((await client.call('agents.brain.get', { agentId: agent.id })).memory).toHaveLength(AGENT_MEMORY_MAX - 10);
});

test('entrusting a thread keeps the other bots\' desks; archiving it ends the entrustment, as in the core', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  const save = (name: string) => client.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  const ada = await save('Ada'), bob = await save('Bob');
  await client.call('agents.watch', { agentId: bob.id, watchThreadId: 't-trace', watched: true });
  await client.call('agents.entrust', { threadId: 't-trace', agentId: ada.id });
  const desk = (await client.call('agents.snapshot', {})).watches.map(w => [w.agentId, w.origin]);
  expect(desk).toEqual(expect.arrayContaining([[bob.id, 'followed'], [ada.id, 'entrusted']]));
  await client.call('threads.archive', { threadId: 't-trace' });
  expect((await client.call('agents.snapshot', {})).entrusted).toEqual([]);
});

test('taking a thread back takes the grant in the fake as in the core: the watch stays only where the bot reaches the thread another way', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  const ada = await client.call('agents.profile.save', { value: { name: 'Ada', domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  const desk = async () => (await client.call('agents.snapshot', {})).watches.find(w => w.agentId === ada.id && w.threadId === 't-trace')?.origin ?? null;
  await client.call('agents.entrust', { threadId: 't-trace', agentId: ada.id });
  await client.call('agents.entrust', { threadId: 't-trace', agentId: null });
  expect(await desk()).toBeNull();
  // Its project entrusted to the bot: the thread stays on its desk as one it follows there.
  const { projectId } = await client.call('threads.get', { threadId: 't-trace' });
  const current = (await client.call('agents.snapshot', {})).profiles.find(a => a.id === ada.id)!;
  await client.call('agents.profile.save', { id: ada.id, expectedRevision: current.revision, value: { ...current, projectIds: [projectId!] } });
  await client.call('agents.entrust', { threadId: 't-trace', agentId: ada.id });
  await client.call('agents.entrust', { threadId: 't-trace', agentId: null });
  expect(await desk()).toBe('followed');
});

test('in the fake as in the core, a watch the bot had before an entrustment survives its end, and an archive ends it like a take-back', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  const ada = await client.call('agents.profile.save', { value: { name: 'Ada', domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  const desk = async () => (await client.call('agents.snapshot', {})).watches.find(w => w.agentId === ada.id && w.threadId === 't-trace')?.origin ?? null;
  await client.call('agents.watch', { agentId: ada.id, watchThreadId: 't-trace', watched: true });
  await client.call('agents.entrust', { threadId: 't-trace', agentId: ada.id });
  await client.call('agents.entrust', { threadId: 't-trace', agentId: null });
  expect(await desk()).toBe('followed');
  await client.call('agents.watch', { agentId: ada.id, watchThreadId: 't-trace', watched: false });
  await client.call('agents.entrust', { threadId: 't-trace', agentId: ada.id });
  await client.call('threads.archive', { threadId: 't-trace' });
  expect(await desk()).toBeNull();
});

test('a removed thread leaves every desk in the fake as in the core, whatever brought it there', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0 });
  const save = (name: string) => client.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  const ada = await save('Ada'), bob = await save('Bob');
  await client.call('agents.watch', { agentId: ada.id, watchThreadId: 't-trace', watched: true });
  await client.call('agents.watch', { agentId: bob.id, watchThreadId: 't-trace', watched: true });
  await client.call('agents.entrust', { threadId: 't-trace', agentId: ada.id });
  await client.call('threads.remove', { threadId: 't-trace' });
  expect((await client.call('agents.snapshot', {})).watches.filter(w => w.threadId === 't-trace')).toEqual([]);
});

test('the demo has an agent at work on a live step, one waiting on a login and one at rest until its routine', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0, agentsDemo: true });
  const snapshot = await client.call('agents.snapshot', {});
  const by = (name: string) => { const agent = snapshot.profiles.find(p => p.name === name)!; return snapshot.status.find(s => s.agentId === agent.id)!; };
  expect(by('Nova')).toMatchObject({ state: 'working', activity: 'Run the UI tests' });
  expect(by('Iris').state).toBe('waiting');
  expect(by('Mira')).toMatchObject({ state: 'idle', nextWake: expect.objectContaining({ label: 'Evening review' }), unread: 1 });
  const nova = snapshot.profiles.find(p => p.name === 'Nova')!;
  // Its desk holds every state a desk card has, the question answerable in place, and a thread of another machine.
  const desk = snapshot.watches.filter(w => w.agentId === nova.id);
  expect(desk.map(w => deskState(w)).sort()).toEqual(['idle', 'merged', 'needs-you', 'review', 'stalled', 'working']);
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

test('the fake core holds an agent to 50 routines, an 80-character name and a 4,000-character prompt, and narrows the desk', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0, agentsDemo: true });
  const all = (await client.call('agents.snapshot', {})).watches;
  expect(all.length).toBeGreaterThan(0);
  expect((await client.call('agents.snapshot', { desk: all[0]!.agentId })).watches).toEqual(all.filter(w => w.agentId === all[0]!.agentId));
  expect((await client.call('agents.snapshot', { desk: null })).watches).toEqual([]);
  const agent = await client.call('agents.profile.save', { value: { name: 'Scout', domain: '', instructions: '', avatar: '', selection, status: 'active' } });
  expect((await client.call('agents.snapshot', { desk: agent.id })).watches).toEqual([]);
  const routine = (name: string, prompt = 'Check the builds.') => client.call('agents.routine.save', { value: { agentId: agent.id, name, prompt, schedule: { kind: 'interval', everyMinutes: 60 }, enabled: true, nextAt: null, lastTurnId: null, lastScheduledAt: null } });
  await expect(routine('x'.repeat(81))).rejects.toThrow('name: expected 1 to 80 characters');
  await expect(routine('Long', 'x'.repeat(4001))).rejects.toThrow('prompt: expected 1 to 4000 characters');
  for (let i = 0; i < 50; i++) await routine(`Check ${i}`);
  await expect(routine('One more')).rejects.toThrow('the most an agent may hold is 50');
  // An edit of one it holds is no new routine.
  const first = (await client.call('agents.snapshot', {})).routines.find(r => r.agentId === agent.id)!;
  await expect(client.call('agents.routine.save', { id: first.id, expectedRevision: first.revision, value: { ...first, name: 'Renamed' } })).resolves.toMatchObject({ name: 'Renamed' });
});
