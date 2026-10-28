import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { DEFAULT_DELEGATION_CONFIG, defaultTrackerModel, type Message, type ThreadActivity } from '@boite/contracts';
import { ActivityStore } from '../src/activity.ts';
import { lastJson, readUpdate, TRACKER_RULES, turnDigest } from '../src/goal-tracker-prompt.ts';
import { TRACKER_PASS } from '../src/goal-tracker.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoDriver } from '../src/drivers/echo.ts';
import { ModelProbes } from '../src/drivers/model-probes.ts';
import type { TurnContext } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let h: TestCore;
let restore: (() => void) | undefined;
beforeEach(async () => { h = await startTestCore(); });
afterEach(async () => { restore?.(); restore = undefined; await h.stop(); });

type Pass = 'write' | 'update' | 'check';
const passOf = (prompt: string): Pass => prompt.includes('Say which open items') ? 'check' : prompt.includes('The new messages, oldest first') ? 'update' : 'write';
const json = (value: unknown) => `Here is the list.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/**
 * An echo core with three roles: the goal's agent, its checklist tracker and
 * its reviewer, each answering from the test's script. The agent may report a
 * tool call before its text.
 */
function roles(script: {
  agent: (ctx: TurnContext) => { text: string; tool?: { name: string; input: unknown } };
  tracker: (pass: Pass, ctx: TurnContext) => string;
  reviewer?: (ctx: TurnContext) => string;
}): () => void {
  return setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      const id = ctx.emit.startMessage('assistant');
      if (h.core.activity.ownsTracker(ctx.thread.id)) ctx.emit.part(id, 0, { type: 'text', text: script.tracker(passOf(ctx.prompt), ctx) });
      else if (h.core.activity.ownsReviewer(ctx.thread.id)) ctx.emit.part(id, 0, { type: 'text', text: script.reviewer?.(ctx) ?? 'Checks pass.\nVERDICT: PASS' });
      else {
        const { text, tool } = script.agent(ctx);
        if (tool) ctx.emit.part(id, 0, { type: 'tool', toolId: 't1', name: tool.name, input: tool.input, output: 'ok', status: 'done' });
        ctx.emit.part(id, tool ? 1 : 0, { type: 'text', text });
      }
      ctx.emit.complete(id, 'complete');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
    },
  });
}

const goalOf = (threadId: string) => h.core.activity.get(threadId).goal!;
const userParts = async (client: Awaited<ReturnType<TestCore['connect']>>, threadId: string) =>
  (await client.call('threads.get', { threadId })).messages.filter(m => m.role === 'user').map(m => m.parts[0]!);

test('a reviewed goal\'s tracker writes the checklist, checks each turn and tells the next turn what is still open', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const agent: string[] = [];
  const passes: { pass: Pass; prompt: string; threadId: string }[] = [];
  const reviews: string[] = [];
  restore = roles({
    agent: ctx => {
      agent.push(ctx.prompt);
      return agent.length === 1 ? { text: 'Added the dark theme.', tool: { name: 'Edit', input: { file_path: 'src/theme.css' } } } : { text: 'Added the settings page.\n[BOITE_GOAL_COMPLETE]', tool: { name: 'Bash', input: { command: 'bun test' } } };
    },
    tracker: (pass, ctx) => {
      passes.push({ pass, prompt: ctx.prompt, threadId: ctx.thread.id });
      if (pass === 'write') return json({ items: [{ text: 'Ajouter un thème sombre', source: 'un thème sombre' }, { text: 'Ajouter une page de réglages', source: 'une page de réglages' }] });
      return json({ done: ctx.prompt.includes('Added the dark theme') ? [1] : [2] });
    },
    reviewer: ctx => { reviews.push(ctx.prompt); return 'All there.\nVERDICT: PASS'; },
  });
  const starts = spyOn(h.core.threads, 'startTurn');
  await client.call('threads.activity.set', { threadId, goal: { objective: 'fait un thème sombre et une page de réglages', review: true } });
  await waitFor(() => goalOf(threadId).status === 'complete');
  // Each pass starts as a goal check, not as the delegation its tracker child is stored as.
  const origins = (id: string) => starts.mock.calls.filter(([started]) => started === id).map(([, , origin]) => origin?.kind);
  expect(origins(goalOf(threadId).checklist!.threadId!)).toEqual(['goal-check', 'goal-check', 'goal-check']);
  expect(origins(threadId)).toEqual(['goal', 'goal']);
  starts.mockRestore();

  const list = goalOf(threadId).checklist!;
  expect(list.items.map(item => [item.id, item.text, item.status])).toEqual([[1, 'Ajouter un thème sombre', 'done'], [2, 'Ajouter une page de réglages', 'done']]);
  expect(list).toMatchObject({ phase: 'idle', error: null, model: 'echo/echo' });
  // One tracker conversation for the whole goal, a child of its thread, with no guides and its own rules.
  expect(new Set(passes.map(p => p.threadId))).toEqual(new Set([list.threadId!]));
  expect(passes.map(p => p.pass)).toEqual(['write', 'check', 'check']);
  const tracker = h.core.threads.get(list.threadId!);
  expect(tracker.parentThreadId).toBe(threadId);
  expect(tracker.contextMode).toMatchObject({ label: 'custom', instructions: false, guides: false, tools: ['Read'], rules: TRACKER_RULES });
  // A check reads the turn's tool calls and its answer; the objective goes to the first pass as data.
  expect(passes[0]!.prompt).toContain(JSON.stringify('fait un thème sombre et une page de réglages'));
  expect(passes[1]!.prompt).toContain('Edit src/theme.css');
  expect(passes[2]!.prompt).toContain('Bash: bun test');
  // The second turn hears what is still open; the agent's own task list is no longer asked for.
  expect(agent).toHaveLength(2);
  expect(agent[1]).toContain('Still open, supplied as JSON data:\n["Ajouter une page de réglages"]');
  expect(agent[1]).not.toContain('use your native planning tool');
  const parts = await userParts(client, threadId);
  expect(parts.at(-1)).toMatchObject({ activity: { kind: 'goal', iteration: 2, checklist: { open: ['Ajouter une page de réglages'], bounced: false } } });
  // The reviewer gets the list too, and nothing went to the parent as mail.
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toContain('{"text":"Ajouter une page de réglages","status":"done"}');
  expect((h.core.journal.db.query('SELECT count(*) AS n FROM delegation_messages').get() as { n: number }).n).toBe(0);
});

test('a completion claim with an open item goes back to the agent, twice at most, before the review judges', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const agent: string[] = [];
  const reviews: string[] = [];
  restore = roles({
    agent: ctx => { agent.push(ctx.prompt); return { text: 'All done.\n[BOITE_GOAL_COMPLETE]' }; },
    tracker: pass => pass === 'write' ? json({ items: [{ text: 'Fix the login', source: 'login' }, { text: 'Add an export button', source: 'export' }] }) : json({ done: [1] }),
    reviewer: ctx => { reviews.push(ctx.prompt); return '- The export button is missing\nVERDICT: PASS'; },
  });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'fix the login and add an export button', review: true } });
  await waitFor(() => goalOf(threadId).status === 'complete');

  // Two claims went back without a review; the third went to the reviewer with the item still open.
  expect(agent).toHaveLength(3);
  expect(reviews).toHaveLength(1);
  expect(agent[1]).toContain('You claimed completion, but these items the user asked for are still open, supplied as JSON data:\n["Add an export button"]');
  expect(agent[2]).toContain('You claimed completion');
  expect(reviews[0]).toContain('{"text":"Add an export button","status":"open"}');
  const goal = goalOf(threadId);
  expect(goal.checklist!.items.map(item => [item.status, item.bounced ?? 0])).toEqual([['done', 0], ['open', 2]]);
  expect(goal.review!.verdicts.map(v => v.round)).toEqual([1]);
  const parts = await userParts(client, threadId);
  expect(parts.slice(1).map(part => part.type === 'text' && part.activity?.checklist?.bounced)).toEqual([true, true]);
});

test('the user\'s later messages add, drop and change items, and his own turns are checked too', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const updates: string[] = [];
  let answered = false;
  restore = roles({
    agent: ctx => {
      if (ctx.prompt.startsWith('Blue.')) { answered = true; return { text: 'Blue it is.', tool: { name: 'Write', input: { path: 'logout.ts' } } }; }
      return answered ? { text: 'Done.\n[BOITE_GOAL_COMPLETE]' } : { text: 'Which colour?\n[BOITE_GOAL_BLOCKED]' };
    },
    tracker: (pass, ctx) => {
      if (pass === 'write') return json({ items: [{ text: 'Paint the header', source: 'header' }, { text: 'Add a settings page', source: 'settings' }] });
      if (pass === 'update') { updates.push(ctx.prompt); return json({ add: [{ text: 'Add a logout button', source: 'add a logout button' }], cancel: [2], change: [{ id: 1, text: 'Paint the header blue', source: 'Blue.' }] }); }
      return json({ done: ctx.prompt.includes('logout.ts') ? [1, 3] : [] });
    },
  });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'paint the header and add a settings page', review: true } });
  await waitFor(() => goalOf(threadId).blocked === true);
  await waitFor(() => goalOf(threadId).checklist!.phase === 'idle');

  h.core.threads.startTurn(threadId, 'Blue. Also drop the settings page and add a logout button');
  await waitFor(() => goalOf(threadId).status === 'complete');

  expect(updates).toHaveLength(1);
  expect(updates[0]).toContain(JSON.stringify(['Blue. Also drop the settings page and add a logout button']));
  expect(updates[0]).toContain('{"id":2,"text":"Add a settings page","status":"open"}');
  expect(goalOf(threadId).checklist!.items.map(({ id, text, status, added, changed }) => ({ id, text, status, added, changed }))).toEqual([
    { id: 1, text: 'Paint the header blue', status: 'done', added: undefined, changed: true },
    { id: 2, text: 'Add a settings page', status: 'cancelled', added: undefined, changed: undefined },
    { id: 3, text: 'Add a logout button', status: 'done', added: true, changed: undefined },
  ]);
});

test('the checklist runs on the model Settings names, and an unknown provider is refused', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  expect(await thrown(client.call('settings.set', { goalTracker: { providerId: 'nobody', model: 'x', effort: null } }))).toThrow('goalTracker names nobody, which is not a loaded provider');
  expect(await thrown(client.call('settings.set', { goalTracker: { providerId: 'echo', model: '', effort: null } }))).toThrow('goalTracker must be null');
  const set = await client.call('settings.set', { goalTracker: { providerId: ' echo ', model: 'echo', effort: 'low' } });
  expect(set.goalTracker).toEqual({ providerId: 'echo', model: 'echo', effort: 'low' });
  restore = roles({ agent: () => ({ text: 'Done.\n[BOITE_GOAL_COMPLETE]' }), tracker: pass => pass === 'write' ? json({ items: [{ text: 'Do it', source: 'it' }] }) : json({ done: [1] }) });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'do it', review: true } });
  await waitFor(() => goalOf(threadId).status === 'complete');
  const list = goalOf(threadId).checklist!;
  expect(list).toMatchObject({ model: 'echo/echo', effort: 'low' });
  expect(h.core.threads.get(list.threadId!)).toMatchObject({ model: 'echo', effort: 'low' });

  // A level the model does not offer stops the list, never the goal.
  await client.call('settings.set', { goalTracker: { providerId: 'echo', model: 'echo', effort: 'medium' } });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'do it again', review: true } });
  await waitFor(() => goalOf(threadId).status === 'complete');
  expect(goalOf(threadId).checklist).toMatchObject({ threadId: null, items: [], error: expect.stringContaining('reasoning effort') });
});

test('a tracker that answers without its JSON leaves the goal running without a list', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let writes = 0;
  restore = roles({ agent: () => ({ text: 'Done.\n[BOITE_GOAL_COMPLETE]' }), tracker: () => { writes++; return 'I could not decide.'; } });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'ship it', review: true } });
  await waitFor(() => goalOf(threadId).status === 'complete');
  const list = goalOf(threadId).checklist!;
  expect(list).toMatchObject({ items: [], error: 'The tracker answered without a {"items": [...]} JSON block.' });
  // The first pass and at most two more when the turn waits; then the goal goes on alone.
  expect(writes).toBeGreaterThanOrEqual(1);
  expect(writes).toBeLessThanOrEqual(3);
});

test('a restarted core knows its trackers again and leaves no pass marked as running', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const saved: ThreadActivity = { tasks: [], loop: null, goal: { objective: 'Ship it', status: 'active', iterations: 1, error: null,
    review: { phase: 'working', maxRounds: 5, reviewerThreadId: null, claimTurnId: null, delivered: 0, verdicts: [] },
    checklist: { threadId: 'thr_tracker', phase: 'checking', items: [{ id: 1, text: 'Ship it', source: 'Ship it', status: 'open' }], model: 'echo/echo', effort: null, error: null } } };
  h.core.journal.setSetting(`activity:${threadId}`, saved);
  const loaded = new ActivityStore(h.core);
  try {
    expect(loaded.ownsTracker('thr_tracker')).toBe(true);
    expect(loaded.get(threadId).goal).toMatchObject({ status: 'paused', checklist: { phase: 'idle', items: [{ status: 'open' }] } });
  } finally { loaded.close(); }
});

test('an update keeps ids, never reuses one, and ignores ids it does not know', () => {
  const items = [{ id: 1, text: 'A', source: 'a', status: 'done' as const }, { id: 2, text: 'B', source: 'b', status: 'open' as const }];
  expect(readUpdate(json({ add: [{ text: 'C', source: 'c' }, { text: ' ' }], cancel: [2, 9], change: [{ id: 1, text: 'A', source: '' }] }), items)).toEqual([
    { id: 1, text: 'A', source: 'a', status: 'done' },
    { id: 2, text: 'B', source: 'b', status: 'cancelled' },
    { id: 3, text: 'C', source: 'c', status: 'open', added: true },
  ]);
  expect(readUpdate('no json', items)).toBe('The tracker answered without an {"add", "cancel", "change"} JSON block.');
  // The last block wins; a bare object at the end is read too.
  expect(lastJson('```json\n{"done":[1]}\n```\nthen\n```json\n{"done":[2]}\n```')).toEqual({ done: [2] });
  expect(lastJson('Result: {"done": [3]} as asked')).toEqual({ done: [3] });
});

test('a turn digest lists tool calls, marks failed ones and keeps the last answer without goal markers', () => {
  const message = (parts: Message['parts']): Message => ({ id: 'm', threadId: 't', turnId: 'u', role: 'assistant', parts, state: 'complete', createdAt: 0 });
  const digest = turnDigest([
    message([{ type: 'tool', toolId: '1', name: 'apply_patch', input: { input: '*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts\n' }, output: null, status: 'done' }]),
    message([{ type: 'tool', toolId: '2', name: 'exec_command', input: { cmd: ['bun', 'test'] }, output: null, status: 'done', exitCode: 1 }, { type: 'text', text: 'Tests fail.\n[BOITE_GOAL_BLOCKED]' }]),
  ]);
  expect(digest).toEqual({ actions: ['apply_patch a.ts, b.ts', 'exec_command: bun test (failed)'], answer: 'Tests fail.' });
});

test('the default checklist model is the newest Opus at medium on Claude and the newest Sol at high on Codex, never a small model', () => {
  expect(defaultTrackerModel('claude-sdk', [{ id: 'claude-haiku-5-5' }, { id: 'claude-opus-4-8' }, { id: 'claude-opus-5-5' }, { id: 'claude-opus-5-5[1m]' }])).toEqual({ model: 'claude-opus-5-5', effort: 'medium' });
  expect(defaultTrackerModel('codex-appserver', [{ id: 'gpt-6-luna' }, { id: 'gpt-6-sol' }, { id: 'gpt-6.1-sol' }])).toEqual({ model: 'gpt-6.1-sol', effort: 'high' });
  expect(defaultTrackerModel('claude-sdk', [{ id: 'claude-haiku-5-5' }])).toBeNull();
  expect(defaultTrackerModel('echo', [{ id: 'echo' }])).toBeNull();
});

/** The tracker's passes hang until `finish`; `stops` says whether a stop ends one. */
function hangingTracker(stops: boolean) {
  const pending: (() => void)[] = [];
  const reset = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      const id = ctx.emit.startMessage('assistant');
      const answer = (text: string) => { ctx.emit.part(id, 0, { type: 'text', text }); ctx.emit.complete(id, 'complete'); };
      if (h.core.activity.ownsTracker(ctx.thread.id)) {
        let end!: () => void;
        const done = new Promise<{ status: 'stopped'; sessionId: null; usage: null }>(resolve => { end = () => resolve({ status: 'stopped', sessionId: null, usage: null }); });
        pending.push(end);
        return { stop() { if (stops) end(); }, done };
      }
      answer(h.core.activity.ownsReviewer(ctx.thread.id) ? 'VERDICT: PASS' : 'Done.\n[BOITE_GOAL_COMPLETE]');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
    },
  });
  return { finish: () => { for (const end of pending.splice(0)) end(); }, reset };
}

test('a tracker stuck on a pass it will not stop gives the goal back after three tries', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const saved = { ...TRACKER_PASS };
  Object.assign(TRACKER_PASS, { timeoutMs: 100, retryMs: 5 });
  const stuck = hangingTracker(false);
  try {
    await client.call('threads.activity.set', { threadId, goal: { objective: 'ship it', review: true } });
    await waitFor(() => goalOf(threadId).status === 'complete', 10_000);
    expect(goalOf(threadId).checklist).toMatchObject({ items: [], phase: 'idle', error: 'The checklist could not be written: the checklist conversation is still busy with an earlier pass' });
  } finally { stuck.finish(); stuck.reset(); Object.assign(TRACKER_PASS, saved); }
});

test('finishing a goal by hand during a checklist pass leaves its list idle', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const slow = hangingTracker(true);
  try {
    await client.call('threads.activity.set', { threadId, goal: { objective: 'ship it', review: true } });
    expect(goalOf(threadId).checklist!.phase).toBe('writing');
    const after = await client.call('threads.activity.control', { threadId, kind: 'goal', action: 'complete' });
    expect(after.goal!.checklist!.phase).toBe('idle');
    expect(goalOf(threadId).checklist!.phase).toBe('idle');
  } finally { slow.finish(); slow.reset(); }
});

test('a reviewer and a tracker read their agent\'s models again when an account change forgot them', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  // An agent whose models are known only from a read, as Claude's are.
  const descriptor = h.core.providers.require('echo');
  descriptor.protocol = 'acp';
  let reads = 0;
  const cache = new ModelProbes(async () => { reads++; return [{ id: 'discovered', name: 'Discovered' }]; });
  const reset = setDriver('acp', {
    ...echoDriver, protocol: 'acp',
    probe: ctx => cache.probe(ctx),
    probedModels: (providerId, accountId) => cache.models(providerId, accountId),
    forgetProbes: filter => cache.forget(filter),
    startTurn(ctx) {
      const id = ctx.emit.startMessage('assistant');
      const answer = (text: string) => { ctx.emit.part(id, 0, { type: 'text', text }); ctx.emit.complete(id, 'complete'); return { status: 'done' as const, sessionId: null, usage: null }; };
      if (h.core.activity.ownsTracker(ctx.thread.id)) return { stop() {}, done: Promise.resolve(answer(passOf(ctx.prompt) === 'write' ? json({ items: [{ text: 'Ship it', source: 'ship it' }] }) : json({ done: [1] }))) };
      if (h.core.activity.ownsReviewer(ctx.thread.id)) return { stop() {}, done: Promise.resolve(answer('VERDICT: PASS')) };
      // What an account update does in the middle of the goal, once its tracker is there.
      const done = waitFor(() => !!goalOf(threadId).checklist?.threadId).then(() => { cache.forget({}); return answer('Shipped.\n[BOITE_GOAL_COMPLETE]'); });
      return { stop() {}, done };
    },
  });
  try {
    await client.call('threads.update', { threadId, model: 'discovered' });
    expect(reads).toBe(1);
    cache.forget({});
    await client.call('threads.activity.set', { threadId, goal: { objective: 'ship it', review: true } });
    await waitFor(() => { const goal = goalOf(threadId); return goal.status === 'complete' || goal.status === 'paused'; });
    const goal = goalOf(threadId);
    expect(goal).toMatchObject({ status: 'complete', error: null, checklist: { error: null, items: [{ status: 'done' }] } });
    expect(h.core.threads.get(goal.checklist!.threadId!).model).toBe('discovered');
    expect(h.core.threads.get(goal.review!.verdicts[0]!.threadId).model).toBe('discovered');
    // One read for the thread, one before the tracker, one before the reviewer.
    expect(reads).toBe(3);
  } finally { reset(); descriptor.protocol = 'echo'; }
});

/**
 * An agent whose models are known only from a read, per account, with one
 * account's next read held until `release`. Its goal turns run `onClaim`
 * (an account update, say) before claiming completion.
 */
function readAgent(onClaim: (prompt: string) => void) {
  const descriptor = h.core.providers.require('echo');
  descriptor.protocol = 'acp';
  const reads: string[] = [];
  let held: string | null = null;
  const gate = Promise.withResolvers<void>();
  const cache = new ModelProbes(async ctx => {
    reads.push(ctx.accountId);
    if (ctx.accountId === held) { held = null; await gate.promise; }
    return [{ id: 'discovered', name: 'Discovered' }];
  });
  const reset = setDriver('acp', {
    ...echoDriver, protocol: 'acp',
    probe: ctx => cache.probe(ctx),
    probedModels: (providerId, accountId) => cache.models(providerId, accountId),
    forgetProbes: filter => cache.forget(filter),
    startTurn(ctx) {
      const id = ctx.emit.startMessage('assistant');
      let text = 'VERDICT: PASS';
      if (h.core.activity.ownsTracker(ctx.thread.id)) text = passOf(ctx.prompt) === 'write' ? json({ items: [{ text: 'Ship it', source: 'ship it' }] }) : json({ done: [1] });
      else if (!h.core.activity.ownsReviewer(ctx.thread.id)) { onClaim(ctx.prompt); text = 'Shipped.\n[BOITE_GOAL_COMPLETE]'; }
      ctx.emit.part(id, 0, { type: 'text', text });
      ctx.emit.complete(id, 'complete');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
    },
  });
  return { cache, reads, hold: (accountId: string) => { held = accountId; }, release: () => gate.resolve(), reset: () => { gate.resolve(); reset(); descriptor.protocol = 'echo'; } };
}

const reviewerOn = (accountId: string) => ({ ...DEFAULT_DELEGATION_CONFIG, profiles: [{ id: 'reviewer', name: 'reviewer', providerId: 'echo', accountId, model: 'discovered', effort: null }] });

test('a reviewer on another account reads that account\'s models, not the conversation\'s', async () => {
  const client = await h.connect();
  const { threadId, accountId } = await echoThread(h, client);
  h.core.journal.putAccount({ ...h.core.accounts.require(accountId), id: 'second-account', label: 'Second' });
  const agent = readAgent(() => agent.cache.forget({ accountId: 'second-account' }));
  try {
    for (const account of [accountId, 'second-account']) await client.call('providers.probe', { providerId: 'echo', accountId: account });
    await client.call('delegation.configure', { threadId, config: reviewerOn('second-account') });
    await client.call('threads.activity.set', { threadId, goal: { objective: 'ship it', review: true } });
    await waitFor(() => { const goal = goalOf(threadId); return goal.status === 'complete' || goal.status === 'paused'; });
    const goal = goalOf(threadId);
    expect(goal).toMatchObject({ status: 'complete', error: null });
    expect(h.core.threads.get(goal.review!.verdicts[0]!.threadId)).toMatchObject({ accountId: 'second-account', model: 'discovered' });
    // The conversation's own list was still there; the reviewer's account was read again.
    expect(agent.reads).toEqual([accountId, 'second-account', 'second-account']);
  } finally { agent.reset(); }
});

test('a read that ends after its goal was replaced lets the new goal read its own reviewer\'s models', async () => {
  const client = await h.connect();
  const { threadId, accountId } = await echoThread(h, client);
  for (const id of ['second-account', 'third-account']) h.core.journal.putAccount({ ...h.core.accounts.require(accountId), id, label: id });
  const agent = readAgent(prompt => agent.cache.forget({ accountId: prompt.includes('first') ? 'second-account' : 'third-account' }));
  try {
    for (const account of [accountId, 'second-account', 'third-account']) await client.call('providers.probe', { providerId: 'echo', accountId: account });
    await client.call('delegation.configure', { threadId, config: reviewerOn('second-account') });
    agent.hold('second-account');
    await client.call('threads.activity.set', { threadId, goal: { objective: 'first goal', review: true } });
    await waitFor(() => agent.reads.length === 4);
    // While the first reviewer's read hangs, a new goal with a reviewer on another account claims completion.
    await client.call('delegation.configure', { threadId, config: reviewerOn('third-account') });
    await client.call('threads.activity.set', { threadId, goal: { objective: 'second goal', review: true } });
    await waitFor(() => { const goal = goalOf(threadId); return goal.objective === 'second goal' && goal.review!.phase === 'reviewing' && h.core.threads.get(threadId).status === 'idle'; });
    agent.release();
    await waitFor(() => { const goal = goalOf(threadId); return goal.status === 'complete' || goal.status === 'paused'; });
    const goal = goalOf(threadId);
    expect(goal).toMatchObject({ objective: 'second goal', status: 'complete', error: null });
    expect(h.core.threads.get(goal.review!.verdicts[0]!.threadId)).toMatchObject({ accountId: 'third-account', model: 'discovered' });
    expect(agent.reads.at(-1)).toBe('third-account');
  } finally { agent.reset(); }
});
