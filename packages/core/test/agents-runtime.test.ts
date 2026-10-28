import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { AgentRoutine } from '@boite/contracts';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreClient } from '../src/client.ts';
import { notifiesOnFinish } from '@boite/contracts';
import { AgentRuntime, EVENT_PROMPT_MAX, isAgentHeld, NOTICES_PER_HOUR } from '../src/agents/runtime.ts';
import { agentGuide, BOT_GUIDE } from '../src/agent-guide.ts';
import { agentContext } from '../src/agents/context.ts';
import { costing, makeAgent, scripted, settled, turnsOf } from './agent-fixture.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let client: CoreClient;
let restore: (() => void) | undefined;
beforeEach(async () => { h = await startTestCore(); client = await h.connect(); });
afterEach(async () => { restore?.(); restore = undefined; await h.stop(); });

const BLOCK = 'Boite: who you are, as a bot.';

function routine(agentId: string, over: Partial<AgentRoutine> = {}) {
  return client.call('agents.routine.save', { value: {
    agentId, name: 'Check the PRs', prompt: 'Look at the open pull requests', schedule: { kind: 'interval', everyMinutes: 60 }, enabled: true,
    nextAt: null, lastTurnId: null, lastScheduledAt: null, ...over,
  } });
}
/** Makes a routine due now, the way time would. */
function due(routineId: string): void {
  const current = h.core.workforce.records.get('routine', routineId);
  h.core.workforce.records.update('routine', current.id, current.revision, { ...current, nextAt: Date.now() - 1000 });
}
const read = (routineId: string) => h.core.workforce.records.get('routine', routineId);
/** What a thread's system lines say. */
const lines = (threadId: string) => h.core.journal.listMessages(threadId).filter(m => m.role === 'system').flatMap(m => m.parts.flatMap(p => p.type === 'text' ? [p.text] : []));

test('a bot\'s Boite guide is the thread guide less the project-bound commands, ending with the bot section; its block carries that section only with the guide off', async () => {
  const bot = agentGuide(true, false, [], true);
  const thread = agentGuide(true, false, [], false);
  expect(bot).toEndWith(`${BOT_GUIDE}\n\n`);
  expect(thread).not.toContain(BOT_GUIDE);
  for (const command of ['boite pr link <url>', 'boite pr watch', 'boite ask', 'boite settings [bot]', 'boite attach', 'boite browser']) expect(bot).toContain(command);
  for (const projectBound of ['boite where', 'Stay in the checkout', 'boite todo', 'projects add']) {
    expect(thread).toContain(projectBound);
    expect(bot).not.toContain(projectBound);
  }
  for (const own of ['[quiet]', 'boite bot remember', 'boite bot schedule', 'boite bot watch|unwatch', 'boite settings bot request', '--open <url>', 'boite thread send <id> <text>', 'boite answer <id> <ask-id> <option-or-text>']) expect(BOT_GUIDE).toContain(own);

  // The test core starts with the Boite guide off; a bot first meets it on.
  await client.call('brain.configure', { path: null, enabled: false, boiteGuide: true });
  const driver = scripted(() => ({ text: 'Hello.' })); restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client);
  const first = (driver.prompts.get(threadId) ?? [])[0]!;
  // The guide says it once, the block not again.
  expect(first).toContain('boite pr watch');
  expect(first.split(BOT_GUIDE).length - 1).toBe(1);
  expect(first).toContain(BLOCK);
  expect(agentContext(h.core, agent).text).not.toContain(BOT_GUIDE);
  // With the Boite guide off, the block is where a bot still learns how it works, and it goes again.
  expect(agentContext(h.core, agent, false).text).toContain(BOT_GUIDE);
  await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
  await client.call('turns.start', { threadId, prompt: 'Still there?' });
  await waitFor(() => (driver.prompts.get(threadId) ?? []).length === 2 && settled(h, threadId));
  const second = driver.prompts.get(threadId)![1]!;
  expect(second).toContain(BLOCK);
  expect(second.split(BOT_GUIDE).length - 1).toBe(1);
});

test('the context block is sent once, then again only once MEMORY.md changes or the session is fresh', async () => {
  const driver = scripted(() => ({ text: 'Noted.' })); restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client, { instructions: 'Answer about releases.' });
  const sent = () => driver.prompts.get(threadId) ?? [];
  // The introduction opened a fresh session: it carried the block, with the persona.
  expect(sent()[0]).toContain(BLOCK);
  expect(sent()[0]).toContain('You are Ada, Open source.\nAnswer about releases.');
  expect(sent()[0]).toContain('[quiet]');
  await client.call('turns.start', { threadId, prompt: 'First question?' });
  await waitFor(() => sent().length === 2 && settled(h, threadId));
  expect(sent()[1]).not.toContain(BLOCK);
  expect(sent()[1]).toContain('First question?');

  await client.call('agents.memory.note', { agentId: agent.id, text: 'The release is on Friday.' });
  await client.call('turns.start', { threadId, prompt: 'Second question?' });
  await waitFor(() => sent().length === 3 && settled(h, threadId));
  expect(sent()[2]).toContain(BLOCK);
  expect(sent()[2]).toMatch(/- \d{4}-\d{2}-\d{2} The release is on Friday\./);

  await client.call('turns.start', { threadId, prompt: 'Third question?' });
  await waitFor(() => sent().length === 4 && settled(h, threadId));
  expect(sent()[3]).not.toContain(BLOCK);

  // A fresh native session (a compaction, an account switch) hears it again, with the journal's history.
  const thread = h.core.threads.require(threadId);
  h.core.journal.putThread({ ...thread, sessionId: null, sessionGeneration: (thread.sessionGeneration ?? 0) + 1 });
  await client.call('turns.start', { threadId, prompt: 'Fourth question?' });
  await waitFor(() => sent().length === 5 && settled(h, threadId));
  expect(sent()[4]).toContain(BLOCK);
  expect(sent()[4]).toContain('Third question?');
});

test('a due routine wakes the agent with a routine turn and records how it ended', async () => {
  const { agent, threadId } = await makeAgent(h, client);
  const saved = await routine(agent.id);
  expect(saved.nextAt).toBeGreaterThan(Date.now());
  due(saved.id);
  await waitFor(() => read(saved.id).lastTurnId !== null);
  const turnId = read(saved.id).lastTurnId!;
  const turn = h.core.journal.getTurn(turnId)!;
  expect(turn.execution?.operation).toBe('routine');
  const line = h.core.journal.listMessages(threadId).find(m => m.turnId === turnId && m.role === 'system')!;
  expect(line.parts[0]).toMatchObject({ text: 'Look at the open pull requests', displayText: 'Routine · Check the PRs' });
  await waitFor(() => read(saved.id).lastOutcome === 'done');
  expect(read(saved.id).nextAt).toBeGreaterThan(Date.now() + 50 * 60_000);
  const status = (await client.call('agents.snapshot', {})).status[0]!;
  expect(status.nextWake).toMatchObject({ routineId: saved.id, label: 'Check the PRs' });
  expect(status.today.wakes).toBe(2);
});

test('a failed occurrence never blocks the next; a running one skips the next and still moves on', async () => {
  let fail = true;
  const driver = scripted(ctx => ctx.prompt.includes('Look at the open') ? { text: 'Checked.', status: fail ? 'error' : 'done', hold: ctx.prompt.includes('HOLD') } : { text: 'Hello.' });
  restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client);
  const saved = await routine(agent.id);
  due(saved.id);
  await waitFor(() => read(saved.id).lastOutcome === 'error');
  const failed = read(saved.id).lastTurnId;
  fail = false;
  due(saved.id);
  await waitFor(() => read(saved.id).lastOutcome === 'done' && read(saved.id).lastTurnId !== failed);

  // An occurrence still running when the next comes due: that next one only moves the time on.
  const long = await routine(agent.id, { name: 'Long', prompt: 'Look at the open HOLD' });
  due(long.id);
  await waitFor(() => read(long.id).lastTurnId !== null && h.core.threads.require(threadId).status === 'running');
  const running = read(long.id).lastTurnId;
  due(long.id);
  await waitFor(() => read(long.id).nextAt! > Date.now());
  expect(read(long.id).lastTurnId).toBe(running);
  expect(turnsOf(h, threadId).filter(t => t.execution?.operation === 'routine')).toHaveLength(3);
  driver.release();
  await waitFor(() => read(long.id).lastOutcome === 'done');
});

test('a quiet event leaves the thread read, notifies nobody and skips the memory pass; one with news does not', async () => {
  const driver = scripted(ctx => ({ text: ctx.prompt.includes('nothing new') ? 'Checked the two PRs.\n[quiet] both green' : ctx.prompt.includes('You keep the long-term memory') ? 'SUMMARY: no change' : 'PR 12 failed its checks.' }));
  restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client, {}, false);
  // No memory pass of the introduction is left running.
  await waitFor(() => h.core.workforce.memory.busy() === false, 10_000);
  h.core.threads.markRead(threadId);
  const passes = () => h.core.journal.listThreads().filter(t => t.parentThreadId === threadId).length;
  const before = passes();

  const quiet = h.core.agentRuntime.wake(agent.id, { kind: 'event', label: '2 project events', prompt: 'nothing new on the desk' })!;
  expect(quiet).not.toBeNull();
  await waitFor(() => settled(h, threadId) && h.core.journal.getTurn(quiet.id)?.status === 'done');
  const finished = h.core.journal.getTurn(quiet.id)!;
  expect(finished.quiet).toBe(true);
  expect(h.core.threads.require(threadId).unread).toBe(false);
  expect(notifiesOnFinish(h.core.threads.require(threadId), finished, 0)).toBe(false);
  await Bun.sleep(300);
  expect(passes()).toBe(before);
  const status = (await client.call('agents.snapshot', {})).status[0]!;
  expect(status.unread).toBe(0);
  expect(status.today.quiet).toBe(1);
  expect(status.last?.text).not.toContain('[quiet]');

  const news = h.core.agentRuntime.wake(agent.id, { kind: 'event', label: '1 project event', prompt: 'a PR failed' })!;
  await waitFor(() => h.core.journal.getTurn(news.id)?.status === 'done');
  const told = h.core.journal.getTurn(news.id)!;
  expect(told.quiet).toBeUndefined();
  expect(h.core.threads.require(threadId).unread).toBe(true);
  expect(notifiesOnFinish(h.core.threads.require(threadId), told, 0)).toBe(true);
  await waitFor(() => passes() === before + 1);
  expect((await client.call('agents.snapshot', {})).status[0]).toMatchObject({ unread: 1, last: { text: 'PR 12 failed its checks.' } });
});

test('past its daily budget a wake is skipped with one line, and the user\'s messages still run', async () => {
  const driver = scripted(() => ({ text: 'Done.', usage: costing(0.5) })); restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client);
  const runtime = await client.call('agents.runtime.get', { agentId: agent.id });
  await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: h.core.workforce.records.get('profile', agent.id).revision, config: { ...runtime, dailyBudgetUsd: 0.4 } });
  expect(h.core.workforce.resident.config(agent.id).dailyBudgetUsd).toBe(0.4);
  // The introduction spent $0.50 already.
  const saved = await routine(agent.id);
  due(saved.id);
  await waitFor(() => read(saved.id).lastOutcome === 'skipped');
  expect(read(saved.id).nextAt).toBeGreaterThan(Date.now());
  expect(h.core.agentRuntime.wake(agent.id, { kind: 'event', label: '1 project event', prompt: 'a fact' })).toBeNull();
  expect(lines(threadId).filter(text => text.includes('past the daily budget of $0.40'))).toHaveLength(1);
  const before = turnsOf(h, threadId).length;
  await client.call('turns.start', { threadId, prompt: 'Still there?' });
  await waitFor(() => turnsOf(h, threadId).length === before + 1 && settled(h, threadId));
  expect(turnsOf(h, threadId).at(-1)!.status).toBe('done');
  expect((await client.call('agents.snapshot', {})).status[0]!.today.costUsd).toBe(1);
});

test('a turn the core starts by itself meets the pause and the budget: held with one line, then run; the user\'s messages and a resume are not held', async () => {
  const driver = scripted(() => ({ text: 'Done.', usage: costing(0.5) })); restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client);
  await client.call('turns.start', { threadId, prompt: 'One explicit user turn.' });
  await waitFor(() => settled(h, threadId) && turnsOf(h, threadId).length === 2);
  const runtime = await client.call('agents.runtime.get', { agentId: agent.id });
  await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: h.core.workforce.records.get('profile', agent.id).revision, config: { ...runtime, dailyBudgetUsd: 0.1 } });
  h.core.workforce.setLimits({ paused: true });
  const turns = () => turnsOf(h, threadId).length;
  const before = turns();
  h.core.threads.deferred.wake(threadId, 'A background shell completed, without a user message.');
  h.core.threads.deferred.wake(threadId, 'A second one completed.');
  await Bun.sleep(700);
  expect(turns()).toBe(before);
  const held = () => lines(threadId).filter(text => text.startsWith('Held the turn its background work asked for'));
  expect(held()).toEqual(['Held the turn its background work asked for: bots are paused. It runs once bots resume.']);
  // Every other way the core starts a turn by itself meets the same gate.
  for (const origin of [{ kind: 'coordination' }, { kind: 'delegation' }, { kind: 'goal-check' }, { kind: 'pull-request' }, { kind: 'resume', reason: 'carry-on', requestId: 'auto-continue_trn_x' }] as const) {
    let error: unknown = null;
    try { h.core.threads.startTurn(threadId, 'autonomous', origin); } catch (caught) { error = caught; }
    expect(isAgentHeld(error)).toBe(true);
  }
  await Bun.sleep(10);
  expect(lines(threadId)).toContain('Held the automatic resume: bots are paused. It was dropped.');
  // The user's own message runs through the pause and the spent budget.
  await client.call('turns.start', { threadId, prompt: 'Still there?' });
  await waitFor(() => turns() === before + 1 && settled(h, threadId));
  // Resumed but past the budget: still held, the one line already said.
  h.core.workforce.setLimits({ paused: false });
  await Bun.sleep(700);
  expect(turns()).toBe(before + 1);
  await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: h.core.workforce.records.get('profile', agent.id).revision, config: { ...runtime, dailyBudgetUsd: null } });
  await waitFor(() => turns() === before + 2 && settled(h, threadId));
  const woke = turnsOf(h, threadId).at(-1)!;
  expect(woke.execution?.operation).toBe('background');
  const prompt = driver.prompts.get(threadId)!.at(-1)!;
  expect(prompt).toContain('A background shell completed');
  expect(prompt).toContain('A second one completed.');
  expect(held()).toHaveLength(1);
});

test('a paused agent skips its routine and moves on, and still answers the user', async () => {
  const { agent, threadId } = await makeAgent(h, client);
  const paused = await client.call('agents.profile.save', { id: agent.id, expectedRevision: h.core.workforce.records.get('profile', agent.id).revision, value: { ...agent, status: 'paused' } });
  const saved = await routine(agent.id);
  due(saved.id);
  await waitFor(() => read(saved.id).lastOutcome === 'skipped');
  expect(read(saved.id).lastTurnId).toBeNull();
  const before = turnsOf(h, threadId).length;
  await client.call('turns.start', { threadId, prompt: 'Are you there?' });
  await waitFor(() => turnsOf(h, threadId).length === before + 1 && settled(h, threadId));
  expect(turnsOf(h, threadId).at(-1)!.status).toBe('done');
  expect(paused.status).toBe('paused');
});

test('facts gather into one event turn once the thread is free and the first is old enough', async () => {
  const driver = scripted(ctx => ({ text: 'Seen.', hold: ctx.prompt.includes('Hold on') })); restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client);
  await client.call('turns.start', { threadId, prompt: 'Hold on' });
  await waitFor(() => h.core.threads.require(threadId).status === 'running');
  expect(h.core.agentRuntime.fact(agent.id, { key: 'turn:one', text: 'Thread one finished.', delay: 0 })).toBe(true);
  expect(h.core.agentRuntime.fact(agent.id, { key: 'turn:two', text: 'Thread two finished.', delay: 0 })).toBe(true);
  expect(h.core.agentRuntime.fact(agent.id, { key: 'turn:two', text: 'again' })).toBe(false);
  await Bun.sleep(700);
  expect(turnsOf(h, threadId).filter(t => t.execution?.operation === 'event')).toHaveLength(1);
  driver.release();
  await waitFor(() => turnsOf(h, threadId).filter(t => t.execution?.operation === 'event').length === 2 && settled(h, threadId));
  const event = turnsOf(h, threadId).at(-1)!;
  const line = h.core.journal.listMessages(threadId).find(m => m.turnId === event.id && m.role === 'system')!;
  expect(line.parts[0]).toMatchObject({ displayText: '2 project events' });
  expect(line.parts[0]!.type === 'text' && line.parts[0]!.text).toContain('- [turn:one] Thread one finished.\n- [turn:two] Thread two finished.');
  expect(h.core.agentRuntime.facts(agent.id)).toEqual([]);
});

test('scheduled-only bots retain facts across runtime restart and failed admission, then deliver once with a routine', async () => {
  const driver = scripted(() => ({ text: 'Caught up.' })); restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client);
  const config = await client.call('agents.runtime.get', { agentId: agent.id });
  await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision, config: { ...config, eventWakes: false } });
  const runtime = () => h.core.agentRuntime as unknown as Omit<AgentRuntime, 'tick'> & { tick(): void };
  const events = () => turnsOf(h, threadId).filter(t => t.execution?.operation === 'event');
  const before = events().length;
  expect(runtime().fact(agent.id, { key: 'saved:0', text: 'MARKER_0', threadIds: [], delay: 0 })).toBe(true);
  runtime().tick();
  expect(events()).toHaveLength(before);
  for (let i = 1; i < 65; i++) expect(runtime().fact(agent.id, { key: `saved:${i}`, text: `MARKER_${i} ${'x'.repeat(300)}`, threadIds: [], delay: 0 })).toBe(true);
  runtime().fact(agent.id, { key: 'revoked', text: 'REVOKED_FACT', threadIds: ['thr_inaccessible'], delay: 0 });
  await runtime().close();
  // Reconstruct from the durable journal, as startup does, with no event wake.
  (h.core as { agentRuntime: AgentRuntime }).agentRuntime = new AgentRuntime(h.core);
  runtime().tick();
  expect(runtime().facts(agent.id)).toHaveLength(66);
  expect(events()).toHaveLength(before);
  const wake = { kind: 'routine' as const, label: 'Morning', prompt: 'Catch up on the projects.' };
  const begin = h.core.threads.startTurn;
  h.core.threads.startTurn = () => { throw new Error('Admission unavailable'); };
  try { expect(runtime().attempt(agent, wake)).toEqual({ held: 'failed' }); }
  finally { h.core.threads.startTurn = begin; }
  expect(runtime().facts(agent.id)).toHaveLength(66);
  await client.call('turns.start', { threadId, prompt: 'Direct question still works.' });
  await waitFor(() => settled(h, threadId));
  expect(runtime().facts(agent.id)).toHaveLength(66);
  const saved = await routine(agent.id);
  due(saved.id);
  runtime().tick();
  await waitFor(() => read(saved.id).lastOutcome === 'done');
  const message = h.core.journal.listMessages(threadId).find(m => m.turnId === read(saved.id).lastTurnId && m.role === 'system')!;
  const text = message.parts[0]?.type === 'text' ? message.parts[0].text : '';
  expect(text).toContain('MARKER_0');
  expect(text).toContain('MARKER_64');
  expect(text).not.toContain('REVOKED_FACT');
  expect(runtime().facts(agent.id)).toHaveLength(0);
  const next = runtime().attempt(agent, wake).turn!;
  expect(h.core.journal.listMessages(threadId).find(m => m.turnId === next.id && m.role === 'system')!.parts[0]).toMatchObject({ text: wake.prompt });
  await waitFor(() => settled(h, threadId));
  runtime().tick();
  expect(events()).toHaveLength(before);
}, 15_000);

test('deferred arrivals leave the automatic event allowance available after re-enabling wakes', async () => {
  const { agent, threadId } = await makeAgent(h, client);
  const config = await client.call('agents.runtime.get', { agentId: agent.id });
  const save = (eventWakes: boolean) => client.call('agents.runtime.configure', {
    agentId: agent.id, expectedRevision: h.core.workforce.records.get('profile', agent.id).revision, config: { ...config, eventWakes },
  });
  await save(false);
  for (let i = 0; i < NOTICES_PER_HOUR; i++) h.core.agentRuntime.fact(agent.id, { key: `deferred:${i}`, text: `Deferred ${i}.`, threadIds: [] });
  expect(h.core.agentRuntime.start(agent, { kind: 'routine', label: 'Morning', prompt: 'Catch up.' })).toBeDefined();
  await waitFor(() => settled(h, threadId));
  expect(h.core.agentRuntime.facts(agent.id)).toHaveLength(0);
  await save(true);
  for (let i = 0; i < NOTICES_PER_HOUR; i++) {
    expect(h.core.agentRuntime.fact(agent.id, { key: `automatic:${i}`, text: `Automatic ${i}.`, threadIds: [] })).toBe(true);
  }
  expect(h.core.agentRuntime.fact(agent.id, { key: 'over-cap', text: 'Over cap.', threadIds: [] })).toBe(false);
  expect(h.core.agentRuntime.facts(agent.id)).toHaveLength(NOTICES_PER_HOUR);
});

test('re-enabling event wakes drains a deferred backlog in bounded batches without replay after restart', async () => {
  const driver = scripted(ctx => ({ text: 'Seen.', hold: ctx.prompt.includes('BACKLOG_0') })); restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client);
  const config = await client.call('agents.runtime.get', { agentId: agent.id });
  const save = (eventWakes: boolean) => client.call('agents.runtime.configure', {
    agentId: agent.id, expectedRevision: h.core.workforce.records.get('profile', agent.id).revision, config: { ...config, eventWakes },
  });
  const tick = () => (h.core.agentRuntime as unknown as { tick(): void }).tick();
  const events = () => turnsOf(h, threadId).filter(t => t.execution?.operation === 'event');
  await save(false);
  const now = Date.now;
  const arrived = now();
  // Facts in one burst share a timestamp; each batch must still have its own receipt.
  Date.now = () => arrived;
  try {
    for (let i = 0; i < 5; i++) h.core.agentRuntime.fact(agent.id, { key: `backlog:${i}`, text: `BACKLOG_${i} ${'x'.repeat(6000)}`, threadIds: [], delay: 0 });
  } finally { Date.now = now; }
  const before = events().length;
  await save(true);
  const delivered: string[] = [];
  for (const remaining of [4, 3, 0]) {
    tick();
    if (remaining === 4) {
      await waitFor(() => driver.held.length === 1);
      expect(h.core.agentRuntime.fact(agent.id, { key: 'new-live', text: 'NEW_LIVE', threadIds: [], delay: 0 })).toBe(true);
      const keys = ['backlog:2', 'backlog:3', 'backlog:4', 'new-live'];
      expect(h.core.agentRuntime.facts(agent.id).map(f => f.key)).toEqual(keys);
      const persisted = h.core.journal.getSetting(`agents:pending:${agent.id}`) as { facts: { key: string }[] };
      expect(persisted.facts.map(f => f.key)).toEqual(keys);
      driver.release();
    }
    await h.core.agentRuntime.close();
    expect(h.core.agentRuntime.facts(agent.id)).toHaveLength(remaining);
    await waitFor(() => settled(h, threadId));
    const turn = events().at(-1)!;
    const message = h.core.journal.listMessages(threadId).find(m => m.turnId === turn.id && m.role === 'system')!;
    const prompt = message.parts[0]?.type === 'text' ? message.parts[0].text : '';
    expect(prompt.length).toBeLessThanOrEqual(EVENT_PROMPT_MAX);
    delivered.push(...(prompt.match(/BACKLOG_\d|NEW_LIVE|RESTART_LIVE/g) ?? []));
    // The remainder is durable and each new batch starts after a reconstructed runtime.
    expect(h.core.journal.getSetting(`agents:pending:${agent.id}`)).toEqual(remaining ? expect.objectContaining({ facts: expect.any(Array) }) : undefined);
    (h.core as { agentRuntime: AgentRuntime }).agentRuntime = new AgentRuntime(h.core);
    expect(h.core.agentRuntime.facts(agent.id)).toHaveLength(remaining);
    if (remaining === 4) {
      // Protection must also survive the runtime reconstruction, before the next lot starts.
      expect(h.core.agentRuntime.fact(agent.id, { key: 'restart-live', text: 'RESTART_LIVE', threadIds: [], delay: 0 })).toBe(true);
      const keys = ['backlog:2', 'backlog:3', 'backlog:4', 'new-live', 'restart-live'];
      expect(h.core.agentRuntime.facts(agent.id).map(f => f.key)).toEqual(keys);
      const persisted = h.core.journal.getSetting(`agents:pending:${agent.id}`) as { facts: { key: string }[] };
      expect(persisted.facts.map(f => f.key)).toEqual(keys);
    }
  }
  expect(delivered).toEqual(['BACKLOG_0', 'BACKLOG_1', 'BACKLOG_2', 'BACKLOG_3', 'BACKLOG_4', 'NEW_LIVE', 'RESTART_LIVE']);
  expect(events()).toHaveLength(before + 3);
  tick();
  expect(events()).toHaveLength(before + 3);
});

test('routine fact consumption rolls back before any driver starts and commits before delivery, without request replay', async () => {
  const delivered: { prompt: string; inTransaction: boolean }[] = [];
  const driver = scripted(ctx => {
    delivered.push({ prompt: ctx.prompt, inTransaction: h.core.journal.db.inTransaction });
    return { text: 'Seen.' };
  }); restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client);
  const config = await client.call('agents.runtime.get', { agentId: agent.id });
  await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision, config: { ...config, eventWakes: false } });
  h.core.agentRuntime.fact(agent.id, { key: 'durable', text: 'DURABLE_FACT', threadIds: [], delay: 0 });
  const before = turnsOf(h, threadId).length;
  const calls = delivered.length;
  const remove = h.core.journal.deleteSetting;
  h.core.journal.deleteSetting = key => {
    if (key === `agents:pending:${agent.id}`) throw new Error('Storage unavailable');
    return remove.call(h.core.journal, key);
  };
  const wake = { kind: 'routine' as const, label: 'Morning', prompt: 'Review the news.', requestId: 'routine-durable' };
  try { expect(h.core.agentRuntime.attempt(agent, wake)).toEqual({ held: 'failed' }); }
  finally { h.core.journal.deleteSetting = remove; }
  expect(delivered).toHaveLength(calls);
  expect(turnsOf(h, threadId)).toHaveLength(before);
  expect(h.core.agentRuntime.facts(agent.id)).toHaveLength(1);
  expect(h.core.journal.getSetting(`agents:pending:${agent.id}`)).toMatchObject({ facts: [{ key: 'durable' }] });
  expect(h.core.journal.turnRequest(threadId, wake.requestId)).toBeNull();
  await h.core.agentRuntime.close();
  (h.core as { agentRuntime: AgentRuntime }).agentRuntime = new AgentRuntime(h.core);
  expect(h.core.agentRuntime.facts(agent.id)).toHaveLength(1);
  const turn = h.core.agentRuntime.attempt(agent, wake).turn!;
  await waitFor(() => settled(h, threadId));
  expect(delivered.at(-1)).toEqual({ prompt: expect.stringContaining('DURABLE_FACT'), inTransaction: false });
  expect(h.core.agentRuntime.facts(agent.id)).toHaveLength(0);
  expect(h.core.journal.getSetting(`agents:pending:${agent.id}`)).toBeUndefined();
  h.core.agentRuntime.fact(agent.id, { key: 'later', text: 'LATER_FACT', threadIds: [], delay: 0 });
  expect(h.core.agentRuntime.attempt(agent, wake).turn?.id).toBe(turn.id);
  expect(h.core.agentRuntime.facts(agent.id).map(f => f.key)).toEqual(['later']);
  expect(delivered).toHaveLength(calls + 1);
  expect(turnsOf(h, threadId)).toHaveLength(before + 1);
});

test('default event wakes still spend facts skipped for budget or failed admission, without a later retry', async () => {
  const driver = scripted(() => ({ text: 'Seen.', usage: costing(0.5) })); restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client);
  const config = await client.call('agents.runtime.get', { agentId: agent.id });
  const save = (dailyBudgetUsd: number | null) => client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: h.core.workforce.records.get('profile', agent.id).revision, config: { ...config, dailyBudgetUsd } });
  const tick = () => (h.core.agentRuntime as unknown as { tick(): void }).tick();
  const before = turnsOf(h, threadId).length;
  await save(0.4);
  h.core.agentRuntime.fact(agent.id, { key: 'budget', text: 'Over budget.', delay: 0, threadIds: [] });
  tick();
  expect(h.core.agentRuntime.facts(agent.id)).toHaveLength(0);
  await save(null);
  tick();
  expect(turnsOf(h, threadId)).toHaveLength(before);
  const begin = h.core.threads.startTurn;
  h.core.threads.startTurn = () => { throw new Error('Admission unavailable'); };
  try {
    h.core.agentRuntime.fact(agent.id, { key: 'failed', text: 'Failed admission.', delay: 0, threadIds: [] });
    tick();
    expect(h.core.agentRuntime.facts(agent.id)).toHaveLength(0);
  } finally { h.core.threads.startTurn = begin; }
  tick();
  expect(turnsOf(h, threadId)).toHaveLength(before);
});

test('changed instructions wake the agent once to review its routines', async () => {
  const { agent, threadId } = await makeAgent(h, client);
  const current = h.core.workforce.records.get('profile', agent.id);
  await client.call('agents.profile.save', { id: agent.id, expectedRevision: current.revision, value: { ...current, instructions: 'Check every day at 9.' } });
  await waitFor(() => turnsOf(h, threadId).filter(t => t.execution?.operation === 'event').length === 2 && settled(h, threadId));
  const turn = turnsOf(h, threadId).at(-1)!;
  expect(h.core.journal.listMessages(threadId).find(m => m.turnId === turn.id && m.role === 'system')!.parts[0]).toMatchObject({ displayText: 'Instructions changed' });
  // A save that leaves the instructions as they were wakes nothing.
  const again = h.core.workforce.records.get('profile', agent.id);
  await client.call('agents.profile.save', { id: agent.id, expectedRevision: again.revision, value: { ...again, domain: 'Releases' } });
  await Bun.sleep(700);
  expect(turnsOf(h, threadId).filter(t => t.execution?.operation === 'event')).toHaveLength(2);
});

test('an occurrence skipped while the engine is paused keeps the clock going: the next one runs once it resumes', async () => {
  const { agent, threadId } = await makeAgent(h, client);
  const saved = await routine(agent.id, { schedule: { kind: 'interval', everyMinutes: 1 } });
  h.core.workforce.setLimits({ paused: true });
  due(saved.id);
  h.core.workforce.routines.tick();
  expect(read(saved.id).lastOutcome).toBe('skipped');
  h.core.workforce.setLimits({ paused: false });
  const before = turnsOf(h, threadId).length;
  // No record changes between the skip and the next occurrence.
  h.core.workforce.routines.tick(read(saved.id).nextAt! + 1);
  expect(turnsOf(h, threadId)).toHaveLength(before + 1);
  expect(turnsOf(h, threadId).at(-1)!.execution?.operation).toBe('routine');
});

test('instructions changed while the agent is paused wake it once it resumes', async () => {
  const { agent, threadId } = await makeAgent(h, client);
  const events = () => turnsOf(h, threadId).filter(t => t.execution?.operation === 'event');
  let current = h.core.workforce.records.get('profile', agent.id);
  await client.call('agents.profile.save', { id: agent.id, expectedRevision: current.revision, value: { ...current, status: 'paused' } });
  current = h.core.workforce.records.get('profile', agent.id);
  await client.call('agents.profile.save', { id: agent.id, expectedRevision: current.revision, value: { ...current, instructions: 'Check DAILY_MARKER every day at 09:00.' } });
  await Bun.sleep(700);
  expect(events()).toHaveLength(1);
  current = h.core.workforce.records.get('profile', agent.id);
  await client.call('agents.profile.save', { id: agent.id, expectedRevision: current.revision, value: { ...current, status: 'active' } });
  await waitFor(() => events().length === 2 && settled(h, threadId), 10_000);
  expect(h.core.journal.listMessages(threadId).find(m => m.turnId === events()[1]!.id && m.role === 'system')!.parts[0]).toMatchObject({ displayText: 'Instructions changed' });
});

test('moving the brains sends the context block again, with the new folder', async () => {
  const driver = scripted(() => ({ text: 'Noted.' })); restore = driver.restore;
  const { agent, threadId } = await makeAgent(h, client);
  const sent = () => driver.prompts.get(threadId) ?? [];
  await client.call('turns.start', { threadId, prompt: 'First question?' });
  await waitFor(() => sent().length === 2 && settled(h, threadId));
  expect(sent()[1]).not.toContain(BLOCK);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'boite-brains-')));
  await client.call('agents.brain.root', { path: root });
  const moved = h.core.workforce.resident.brain(agent.id).path;
  expect(moved.startsWith(root)).toBe(true);
  await client.call('turns.start', { threadId, prompt: 'Second question?' });
  await waitFor(() => sent().length === 3 && settled(h, threadId));
  expect(sent()[2]).toContain(BLOCK);
  expect(sent()[2]).toContain(`Your brain is ${moved}.`);
});
