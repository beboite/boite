/*
 * The agents that stand as the companion: the look each one wears, the row
 * read from the agents snapshot, the replies and memories the companion reads
 * and saves back, the agent it makes, and the notes it shows besides.
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { AgentConversationMessage, AgentMemory, AgentProfile, AgentScope, AgentsSnapshot } from '@boite/contracts';
import { BOX_COLORS, encodeRobot, ROBOT_PARTS, robotOf, seededRobot } from '../robots';
import type { Brain } from './brain';
import { AGENT_TOOLS, CLASSIC_SKIN, companionAgent, freshSkin, membersOf, memoriesToForget, memoryToKeep, profileWith, repliesAfter, replyTo, skinOf } from './crew';
import { addReminder, readReminders } from './memory';
import { Notes } from './notes.svelte';
import { toBox } from './skin';

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

const record = { revision: 3, createdAt: 0, updatedAt: 0 };
const direct = (id: string): AgentScope => ({ kind: 'agent', id });
const BRAIN: Brain = { providerId: 'claude', accountId: 'acc', model: 'haiku', effort: null };

const profile = (id: string, extra: Partial<AgentProfile> = {}): AgentProfile => ({
  ...record,
  id,
  name: id,
  domain: '',
  instructions: '',
  avatar: '',
  selection: { ...BRAIN, permissionMode: 'default' },
  status: 'active',
  tools: [],
  accountIntegration: 'provider',
  ...extra
});

const said = (id: string, senderId: string | null, createdAt: number, extra: Partial<AgentConversationMessage> = {}): AgentConversationMessage => ({
  ...record,
  id,
  scope: direct('bots'),
  senderId,
  text: id,
  recipientIds: [],
  replyTo: null,
  episodeId: 'e',
  sourceRunId: null,
  createdAt,
  ...extra
});

const memory = (id: string, text: string, scope = direct('bots')): AgentMemory => ({ ...record, id, scope, title: text, text, sourceScopes: [scope], sourceRunId: null, expiresAt: null });

const snapshotOf = (part: Partial<AgentsSnapshot>) => ({ profiles: [], messages: [], sessions: [], work: [], memories: [], ...part }) as unknown as AgentsSnapshot;

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------

test('an agent stands as a box: its own box, any other robot made one in its colour, or the box its id draws', () => {
  expect(skinOf(profile('bots', { avatar: CLASSIC_SKIN }))).toEqual({ family: 'box', shape: 0, color: 0, eyes: 0, top: 0 });
  const box = { family: 'box', shape: 4, color: 7, eyes: 2, top: 5 } as const;
  expect(skinOf(profile('a', { avatar: encodeRobot(box) }))).toEqual(box);
  // A jelly robot keeps its colour (one up, past the classic body) and its top as the accessory.
  expect(skinOf(profile('a', { avatar: encodeRobot({ family: 'jelly', shape: 1, color: 2, eyes: 1, top: 3 }) }))).toMatchObject({ family: 'box', color: 3, top: 3 });
  // No avatar: the robot the Agents page draws for its id, as a box.
  expect(skinOf(profile('seeded'))).toEqual(toBox(seededRobot('seeded')));
  expect(skinOf(profile('emoji', { avatar: '🦊' }))).toEqual(seededRobot('emoji', 'box'));
});

test('a fresh look takes a body colour nobody wears, never the classic one, and always an accessory', () => {
  const worn = (color: number) => ({ family: 'box' as const, shape: 0, color, eyes: 0, top: 0 });
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const others = [worn(0), worn(1), worn(2), worn(3)];
    const skin = robotOf('x', freshSkin(seed, others))!;
    expect(skin.family).toBe('box');
    expect(skin.color).toBeGreaterThan(3);
    expect(skin.color).toBeLessThan(BOX_COLORS);
    expect(skin.top).toBeGreaterThan(0);
    expect(skin.top).toBeLessThan(ROBOT_PARTS.box.top);
    expect(freshSkin(seed, others)).toBe(freshSkin(seed, others));
  }
  const all = Array.from({ length: BOX_COLORS }, (_, color) => worn(color));
  expect(robotOf('x', freshSkin('crowded', all))!.color).toBeGreaterThan(0);
  const lastFree = all.filter((robot) => robot.color !== 6);
  expect(robotOf('x', freshSkin('one-left', lastFree))!.color).toBe(6);
});

// ---------------------------------------------------------------------------
// The row and its conversations
// ---------------------------------------------------------------------------

test('the row keeps the order the user gave it, an archived or deleted agent left out', () => {
  const snapshot = snapshotOf({ profiles: [profile('a'), profile('b'), profile('gone', { status: 'archived' }), profile('paused', { status: 'paused' })] });
  expect(membersOf(snapshot, ['b', 'missing', 'gone', 'a', 'paused']).map((agent) => agent.id)).toEqual(['b', 'a', 'paused']);
  expect(membersOf(null, ['a'])).toEqual([]);
});

test('a request gets the reply its agent wrote to it; a note about an entrusted thread is no reply', () => {
  const snapshot = snapshotOf({
    messages: [
      said('u1', null, 1),
      said('note', 'bots', 2, { thread: { id: 't', title: 'Fix', event: 'done' } }),
      said('other', 'helper', 3, { replyTo: 'u1', scope: direct('helper') }),
      said('r1', 'bots', 4, { replyTo: 'u1' }),
      said('r2', 'bots', 6)
    ]
  });
  expect(replyTo(snapshot, 'bots', 'u1')?.id).toBe('r1');
  expect(replyTo(snapshot, 'bots', 'u9')).toBeNull();
  expect(repliesAfter(snapshot, 'bots', 0).map((message) => message.id)).toEqual(['r1', 'r2']);
  expect(repliesAfter(snapshot, 'bots', 4).map((message) => message.id)).toEqual(['r2']);
  // Each agent has its own conversation.
  expect(repliesAfter(snapshot, 'helper', 0).map((message) => message.id)).toEqual(['other']);
});

test('a fact is kept once in the agent memory, and a forget expires the memories it names', () => {
  const memories = [memory('m1', 'Plays Overwatch on Fridays'), memory('m2', 'Is called Chris')];
  expect(memoryToKeep(memories, 'bots', '  ')).toBeNull();
  expect(memoryToKeep(memories, 'bots', 'is called  chris.')).toBeNull();
  expect(memoryToKeep(memories, 'bots', 'Likes  green\ntea')).toEqual({
    value: { scope: direct('bots'), title: 'Likes green tea', text: 'Likes green tea', sourceScopes: [direct('bots')], sourceRunId: null, expiresAt: null }
  });
  const forgotten = memoriesToForget(memories, 'overwatch', 42);
  expect(forgotten).toEqual([{ id: 'm1', expectedRevision: 3, value: { scope: direct('bots'), title: 'Plays Overwatch on Fridays', text: 'Plays Overwatch on Fridays', sourceScopes: [direct('bots')], sourceRunId: null, expiresAt: 42 } }]);
  expect(memoriesToForget(memories, 'nothing like it', 42)).toEqual([]);
});

test('the companion makes an active agent with its tools, and saves another look at the revision it read', () => {
  const made = companionAgent('Bots', 'Desk', 'Role', CLASSIC_SKIN, BRAIN, 'bypassPermissions');
  expect(made).toEqual({
    value: { name: 'Bots', domain: 'Desk', instructions: 'Role', avatar: CLASSIC_SKIN, selection: { ...BRAIN, permissionMode: 'bypassPermissions' }, status: 'active', tools: AGENT_TOOLS, accountIntegration: 'provider' }
  });
  made.value.tools.push('extra');
  expect(AGENT_TOOLS).not.toContain('extra');
  const agent = profile('bots', { name: 'Bots', instructions: 'Mine', tools: ['memory'] });
  const saved = profileWith(agent, { avatar: 'robot:b.1.2.3.4' });
  expect(saved).toMatchObject({ id: 'bots', expectedRevision: 3, value: { name: 'Bots', instructions: 'Mine', avatar: 'robot:b.1.2.3.4', tools: ['memory'] } });
  expect(saved.value).not.toHaveProperty('revision');
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

test('a finished thread the agents work in is not told as news', () => {
  const notes = new Notes({ client: () => null, threads: () => [], ownThreads: () => ['own'], holding: () => false, rang: () => {} });
  notes.finished(['own', 'other']);
  expect(notes.notices.map((notice) => notice.threadId)).toEqual(['other']);
  notes.dispose();
});

test('a reminder that comes due rings, and again a few times while nobody answers it', () => {
  vi.useFakeTimers();
  addReminder('Take the tea out', Date.now() + 1500);
  const rang = vi.fn();
  const notes = new Notes({ client: () => null, threads: () => [], ownThreads: () => [], holding: () => false, rang });

  vi.advanceTimersByTime(1000);
  expect(rang).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2000);
  expect(rang).toHaveBeenCalledTimes(1);
  expect(notes.alarms.map((alarm) => alarm.text)).toEqual(['Take the tea out']);
  expect(readReminders()).toEqual([]);
  vi.advanceTimersByTime(60_000);
  expect(rang).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(10 * 60_000);
  expect(rang).toHaveBeenCalledTimes(3);
  notes.done(notes.alarms[0]!.id);
  addReminder('Call back', Date.now() + 500);
  vi.advanceTimersByTime(1000);
  expect(rang).toHaveBeenCalledTimes(4);
  notes.done(notes.alarms[0]!.id);
  vi.advanceTimersByTime(5 * 60_000);
  expect(rang).toHaveBeenCalledTimes(4);
  notes.dispose();
});
