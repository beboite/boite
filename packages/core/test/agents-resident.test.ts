import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { AGENT_ROUTINES_MAX } from '@boite/contracts';
import type { AgentProfile, AgentRuntimeConfig } from '@boite/contracts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { Core } from '../src/core.ts';
import { SCHEMA_VERSION } from '../src/journal/schema.ts';
import { checkSchedule, nextOccurrence } from '../src/agents/routines.ts';
import { agentContext, ROUTINES_TEXT_MAX } from '../src/agents/context.ts';
import { connect } from '../src/client.ts';
import { makeAgent, settled, turnsOf } from './agent-fixture.ts';
import { thrown } from './settle.ts';

let h: TestCore;
let agent: AgentProfile;
let threadId: string;
let client: Awaited<ReturnType<TestCore['connect']>>;
beforeEach(async () => {
  h = await startTestCore(); client = await h.connect();
  ({ agent, threadId } = await makeAgent(h, client, { name: 'Resident', domain: 'Research', instructions: 'Keep useful notes.' }));
});
afterEach(async () => { await h?.stop(); });
function policy(): AgentRuntimeConfig { return { defaultRoute: agent.selection, allowedRoutes: [{ ...agent.selection, model: 'echo', id: 'main', name: 'Main' }], subagents: { enabled: false, paused: false, profiles: [] }, autoMemory: false, dailyBudgetUsd: null }; }
const current = () => h.core.workforce.records.get('profile', agent.id);
const routineValue = (over: Record<string, unknown> = {}) => ({ agentId: agent.id, name: 'Daily review', prompt: 'Review new ideas', schedule: { kind: 'interval' as const, everyMinutes: 60 }, enabled: true, nextAt: null, lastTurnId: null, lastScheduledAt: null, ...over });

test('each identity owns a durable brain, with revision-checked edits', async () => {
  const brain = await client.call('agents.brain.get', { agentId: agent.id });
  expect(existsSync(brain.path)).toBe(true);
  const saved = await client.call('agents.brain.save', { agentId: agent.id, expectedRevision: brain.revision, instructions: 'Always verify sources.', memory: 'Keep the prototype private.' });
  expect(saved.memory).toBe('Keep the prototype private.');
  expect(await thrown(client.call('agents.brain.save', { agentId: agent.id, expectedRevision: brain.revision, instructions: 'stale', memory: '' }))).toThrow('revision');
});

test('default route must be allowed; account grants restrict identity and child routes', async () => {
  expect(await thrown(client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: current().revision, config: { ...policy(), allowedRoutes: [] } }))).toThrow('default');
  await client.call('agents.accounts.set', { grants: [{ accountId: agent.selection.accountId, agentIds: [] }] });
  expect(await thrown(client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: current().revision, config: policy() }))).toThrow('account');
});

test('a runtime saved by an older core still loads, and its retired keys are gone', async () => {
  h.core.journal.setSetting(`agents:runtime:${agent.id}`, { ...policy(), compactAfterTurns: 12, maxRunMinutes: 10 });
  const read = await client.call('agents.runtime.get', { agentId: agent.id });
  expect(read).toEqual({ ...policy(), eventWakes: true, defaultRoute: current().selection });
  expect(await thrown(client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: current().revision, config: { ...policy(), dailyBudgetUsd: -1 } }))).toThrow('dailyBudgetUsd');
});

test('removing an account drops its grant, so later grant edits still apply', async () => {
  const spare = await client.call('accounts.add', { providerId: 'echo', label: 'Spare' });
  await client.call('agents.accounts.set', { grants: [{ accountId: spare.id, agentIds: [] }] });
  await client.call('accounts.remove', { accountId: spare.id });
  const { accountGrants } = await client.call('agents.snapshot', {});
  expect(accountGrants).toEqual([]);
  expect(await client.call('agents.accounts.set', { grants: accountGrants })).toEqual([]);
});

test('paired clients read agents and their updates, and cannot change model policy or speak for an agent', async () => {
  const { grant } = await client.call('pairing.grant', {});
  const remote = await connect(h.url, '', { grant, client: { name: 'Remote PC', version: 'test' } });
  try {
    const changed = remote.next('agents.changed', () => true, 3000);
    await client.call('agents.memory.note', { agentId: agent.id, text: 'From the owner' });
    await changed;
    expect((await remote.call('agents.runtime.get', { agentId: agent.id })).defaultRoute.model).toBe('echo');
    expect((await remote.call('agents.brain.get', { agentId: agent.id })).memory).toContain('From the owner');
    expect(await thrown(remote.call('agents.memory.note', { agentId: agent.id, text: 'From the phone' }))).toThrow('owner');
    expect(await thrown(remote.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: current().revision, config: policy() }))).toThrow('owner');
  } finally { remote.close(); }
});

test('the main model and helper model have independent allowlists', async () => {
  const provider = h.core.providers.require('echo');
  provider.models.push({ ...provider.models[0]!, id: 'helper', name: 'Helper', default: false });
  const config = policy();
  config.subagents = { ...config.subagents, enabled: true, profiles: [{ ...config.allowedRoutes[0]!, id: 'helper', model: 'helper' }] };
  agent = await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: current().revision, config });
  expect(h.core.workforce.resident.allowed(agent.id, { ...agent.selection, model: 'helper' })).toBe(false);
  expect(h.core.workforce.resident.allowed(agent.id, { ...agent.selection, model: 'helper' }, true)).toBe(true);
  expect(h.core.workforce.resident.allowed(agent.id, agent.selection, true)).toBe(false);
  const child = await client.call('delegation.spawn', { threadId, profileId: 'helper', task: 'Check one fact', requestId: 'helper-spawn-001' });
  expect(child.thread.model).toBe('helper');
  expect(child.thread.projectId).toBeNull();
  // Withdrawing the account stops the child the agent started on it.
  await client.call('agents.accounts.set', { grants: [{ accountId: agent.selection.accountId, agentIds: [] }] });
  expect(h.core.workforce.resident.allowed(agent.id, child.thread, true)).toBe(false);
  await waitFor(() => !['running', 'queued'].includes(h.core.threads.require(child.thread.id).status), 15_000);
});

test('Run now starts a routine turn once per request, and refuses while the thread is at work', async () => {
  const routine = await client.call('agents.routine.save', { value: routineValue() });
  const request = { routineId: routine.id, requestId: 'routine-once-001' };
  const first = await client.call('agents.routine.run', request);
  expect((await client.call('agents.routine.run', request)).turnId).toBe(first.turnId);
  expect(h.core.journal.getTurn(first.turnId)?.execution?.operation).toBe('routine');
  // Run now leaves the schedule where it was.
  expect(h.core.workforce.records.get('routine', routine.id)).toMatchObject({ lastTurnId: first.turnId, nextAt: routine.nextAt });
  await waitFor(() => settled(h, threadId));
  await client.call('turns.start', { threadId, prompt: '[sleep:60000]' });
  await waitFor(() => h.core.threads.require(threadId).status === 'running');
  expect(await thrown(client.call('agents.routine.run', { ...request, requestId: 'routine-once-002' }))).toThrow('is at work');
  await client.call('turns.stop', { threadId });
  await waitFor(() => settled(h, threadId));
  await client.call('agents.routine.remove', { routineId: routine.id });
  expect(h.core.workforce.records.list('routine')).toEqual([]);
});

test('an agent schedules and removes only its own routines, from its own thread', async () => {
  const other = await makeAgent(h, client, { name: 'Bea' });
  const own = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    const saved = await own.call('agents.routine.save', { threadId, value: routineValue() });
    expect(saved.agentId).toBe(agent.id);
    expect(await thrown(own.call('agents.routine.save', { threadId, value: { ...routineValue(), agentId: other.agent.id } }))).toThrow('its own routines');
    const theirs = await client.call('agents.routine.save', { value: { ...routineValue(), agentId: other.agent.id } });
    expect(await thrown(own.call('agents.routine.remove', { threadId, routineId: theirs.id }))).toThrow('only its own routines');
    expect(await own.call('agents.routine.remove', { threadId, routineId: saved.id })).toEqual({ removed: true });
  } finally { own.close(); }
});

test('an agent holds at most 50 routines with short names and prompts, and its context lists 2,000 characters of them', async () => {
  const own = await connect(h.url, h.core.agents.tokenFor(threadId));
  try {
    const save = (i: number, over: Record<string, unknown> = {}) => own.call('agents.routine.save', { threadId, value: routineValue({ name: `${i}:${'R'.repeat(70)}`, enabled: false, schedule: { kind: 'once', at: 1 }, ...over }) });
    expect(await thrown(save(0, { name: 'N'.repeat(81) }))).toThrow('name');
    expect(await thrown(save(0, { prompt: 'P'.repeat(4001) }))).toThrow('prompt');
    for (let i = 0; i < AGENT_ROUTINES_MAX; i++) await save(i);
    expect(await thrown(save(AGENT_ROUTINES_MAX))).toThrow(`already has ${AGENT_ROUTINES_MAX} routines, the most an agent may hold is ${AGENT_ROUTINES_MAX}`);
    // The owner is held to the same count; an edit of one it has still saves.
    expect(await thrown(client.call('agents.routine.save', { value: routineValue() }))).toThrow(`already has ${AGENT_ROUTINES_MAX} routines`);
    const first = h.core.workforce.records.list('routine')[0]!;
    await own.call('agents.routine.save', { threadId, id: first.id, expectedRevision: first.revision, value: routineValue({ name: 'Renamed', enabled: false, schedule: { kind: 'once', at: 1 } }) });
  } finally { own.close(); }
  expect(h.core.workforce.records.list('routine')).toHaveLength(AGENT_ROUTINES_MAX);
  const block = agentContext(h.core, current()).text;
  const section = block.slice(block.indexOf('Your routines:'), block.indexOf('\n\n', block.indexOf('Your routines:')));
  const more = section.match(/\n(\d+) more: boite bot routines$/);
  expect(more).not.toBeNull();
  expect(section.length - more![0].length).toBeLessThanOrEqual('Your routines:\n'.length + ROUTINES_TEXT_MAX);
  expect(section.split('\n').filter(line => line.startsWith('- ')).length + Number(more![1])).toBe(AGENT_ROUTINES_MAX);
});

test('a once routine that ran stays done: resuming it fires nothing, a new date re-arms it', async () => {
  const routine = await client.call('agents.routine.save', { value: routineValue({ name: 'Tomorrow', prompt: 'Look once', schedule: { kind: 'once', at: Date.now() + 86_400_000 } }) });
  const ran = h.core.workforce.records.get('routine', routine.id);
  h.core.workforce.records.update('routine', ran.id, ran.revision, { ...ran, nextAt: Date.now() - 1000 });
  await waitFor(() => h.core.workforce.records.get('routine', routine.id).lastOutcome === 'done', 10_000);
  const done = h.core.workforce.records.get('routine', routine.id);
  expect([done.enabled, done.nextAt]).toEqual([false, null]);
  const resumed = await client.call('agents.routine.save', { id: done.id, expectedRevision: done.revision, value: { ...done, enabled: true } });
  expect(resumed.nextAt).toBeNull();
  const routineTurns = () => turnsOf(h, threadId).filter(t => t.execution?.operation === 'routine').length;
  // Two ticks of the scheduler, no waiting on its timer: a resumed once routine reads as nothing due.
  h.core.workforce.routines.tick(); h.core.workforce.routines.tick();
  expect(routineTurns()).toBe(1);
  const at = Date.now() + 3_600_000;
  expect((await client.call('agents.routine.save', { id: resumed.id, expectedRevision: resumed.revision, value: { ...resumed, schedule: { kind: 'once', at } } })).nextAt).toBe(at);
});

test('restart preserves the brain and catches up one due routine without duplicate turns', async () => {
  const brain = h.core.workforce.resident.brain(agent.id);
  h.core.workforce.resident.saveBrain({ agentId: agent.id, expectedRevision: brain.revision, instructions: 'Review evidence', memory: 'Private notes' });
  const routine = h.core.workforce.routines.save({ value: routineValue({ name: 'Overdue', prompt: 'Review once', schedule: { kind: 'once', at: Date.now() + 60_000 } }) });
  await h.server.stop(); await h.core.close();
  // Due an hour ago, while the core was down.
  const db = new Database(join(h.dataDir, 'journal.db'));
  db.query("UPDATE agent_entities SET data = json_set(data, '$.nextAt', ?) WHERE kind = 'routine' AND id = ?").run(Date.now() - 3_600_000, routine.id);
  db.close();
  const restarted = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    expect(restarted.workforce.resident.brain(agent.id).memory).toBe('Private notes');
    restarted.workforce.routines.tick(); restarted.workforce.routines.tick();
    const routineTurns = restarted.journal.listTurns(threadId).filter(t => t.execution?.operation === 'routine');
    expect(routineTurns).toHaveLength(1);
    expect(restarted.workforce.records.get('routine', routine.id)).toMatchObject({ enabled: false, nextAt: null, lastTurnId: routineTurns[0]!.id });
  } finally { await restarted.close(); }
});

test('daily routines run once per local date across the autumn clock change', () => {
  const next = nextOccurrence({ kind: 'daily', time: '02:30', timezone: 'Europe/Paris' }, Date.parse('2026-10-25T00:30:00Z'));
  expect(new Date(next!).toISOString()).toBe('2026-10-26T01:30:00.000Z');
  // 02:30 does not exist on 28 March 2027 in Paris: the next listed date runs instead.
  const skipped = (days?: number[]) => new Date(nextOccurrence({ kind: 'daily', time: '02:30', timezone: 'Europe/Paris', ...(days ? { days } : {}) }, Date.parse('2027-03-28T00:00:00Z'))!).toISOString();
  expect(skipped()).toBe('2027-03-29T00:30:00.000Z');
  expect(skipped([0])).toBe('2027-04-04T00:30:00.000Z');
});

test('weekday routines run only on listed local weekdays', () => {
  const mwf = checkSchedule({ kind: 'daily', time: '09:00', timezone: 'Europe/Paris', days: [5, 1, 3] });
  expect(mwf).toEqual({ kind: 'daily', time: '09:00', timezone: 'Europe/Paris', days: [1, 3, 5] });
  const next = (after: string) => new Date(nextOccurrence(mwf, Date.parse(after))!).toISOString();
  expect(next('2026-10-07T06:00:00Z')).toBe('2026-10-07T07:00:00.000Z'); // Wednesday, before 09:00
  expect(next('2026-10-07T07:00:00Z')).toBe('2026-10-09T07:00:00.000Z'); // Wednesday at 09:00: Friday
  expect(next('2026-10-23T08:00:00Z')).toBe('2026-10-26T08:00:00.000Z'); // Friday past, Monday after the clock change
  // Local weekday, not UTC: Monday 00:30 in Tokyo is Sunday in UTC.
  expect(new Date(nextOccurrence({ kind: 'daily', time: '00:30', timezone: 'Asia/Tokyo', days: [1] }, Date.parse('2026-10-07T00:00:00Z'))!).toISOString()).toBe('2026-10-11T15:30:00.000Z');
  expect(checkSchedule({ kind: 'daily', time: '09:00', timezone: 'UTC', days: [6, 5, 4, 3, 2, 1, 0] })).toEqual({ kind: 'daily', time: '09:00', timezone: 'UTC' });
  for (const days of [[], [8], [1, 1], [1.5], ['1'] as unknown as number[], [0, 1, 2, 3, 4, 5, 6, 0]]) expect(() => checkSchedule({ kind: 'daily', time: '09:00', timezone: 'UTC', days })).toThrow('schedule.days: expected 1 to 7 different weekday numbers');
});

test('schema 14 from the earlier persistent branch upgrades without losing the agent thread', async () => {
  await client.call('turns.start', { threadId, prompt: 'Preserve this history' });
  await waitFor(() => settled(h, threadId) && turnsOf(h, threadId).length === 2);
  const session = h.core.workforce.sessionOf(agent.id)!;
  await h.server.stop(); await h.core.close();
  const db = new Database(join(h.dataDir, 'journal.db'));
  db.exec('DROP TABLE delegated_agents; DROP TABLE delegation_messages; DROP INDEX threads_parent; ALTER TABLE threads DROP COLUMN parent_thread_id; ALTER TABLE threads DROP COLUMN prompt_cache; PRAGMA user_version=14');
  db.close();
  const next = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    const thread = next.threads.get(session.threadId);
    expect(thread.projectId).toBeNull();
    expect(thread.agentSessionId).toBe(session.id);
    expect(thread.turns).toHaveLength(2);
    expect(next.workforce.records.get('profile', agent.id).name).toBe(agent.name);
    expect(next.journal.db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
  } finally { await next.close(); }
});
