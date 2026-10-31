import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeTeamPost, teamMemberKey, TEAM_LETTER_BYTES, type AgentLetter, type CoordinationConfig, type Team, type TeamPost } from '@boite/contracts';
import { AGENT_ENV } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { RESIDENT_LETTER_TTL_MS } from '../src/coordination.ts';
import type { CoreClient } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnResult } from '../src/drivers/types.ts';
import { answerPostId } from '../src/teams/store.ts';
import { planTeamLetter, teamPostLine, teamPrompt } from '../src/teams/prompt.ts';
import { costing, makeAgent, turnsOf } from './agent-fixture.ts';
import { echoThread, holdAccountTurns, removeDir, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
// Drivers come back newest first: each restore puts back the one before it.
afterEach(async () => { for (const restore of restores.splice(0).reverse()) restore(); for (const core of cores.splice(0)) await core.stop(); });

interface Step { text?: string; status?: 'done' | 'error'; hold?: boolean; usage?: TurnResult['usage'] }

/**
 * The echo driver, scripted per prompt: `hold` keeps the turn running until
 * `finish`; unless `steers` is off, a running turn takes steers, each acknowledged by hand.
 */
function teamDriver(next: (prompt: string, threadId: string) => Step = () => ({ text: '[quiet]' }), steers = true) {
  const prompts: { threadId: string; prompt: string }[] = [];
  const steered: { threadId: string; prompt: string; ack: ReturnType<typeof Promise.withResolvers<boolean>> }[] = [];
  const running: { threadId: string; finish(status?: 'done' | 'error' | 'stopped'): void }[] = [];
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    prompts.push({ threadId: ctx.thread.id, prompt: ctx.prompt });
    const step = next(ctx.prompt, ctx.thread.id);
    const id = ctx.emit.startMessage('assistant');
    if (step.text !== undefined) ctx.emit.part(id, 0, { type: 'text', text: step.text });
    ctx.emit.complete(id, 'complete');
    const sessionId = ctx.sessionId ?? `session:${ctx.thread.id}`;
    const result = (status: 'done' | 'error' | 'stopped'): TurnResult => status === 'error'
      ? { status: 'error', error: 'Asked to fail', sessionId, usage: step.usage ?? null }
      : { status, sessionId, usage: step.usage ?? null };
    const gate = Promise.withResolvers<TurnResult>();
    if (step.hold) running.push({ threadId: ctx.thread.id, finish: (status = 'done') => gate.resolve(result(status)) });
    else gate.resolve(result(step.status ?? 'done'));
    return {
      done: gate.promise, stop: () => gate.resolve(result('stopped')),
      ...(steers ? { steer: (prompt: string) => { const ack = Promise.withResolvers<boolean>(); steered.push({ threadId: ctx.thread.id, prompt, ack }); return ack.promise; } } : {}),
    };
  } }));
  return { prompts, steers: steered, running, of: (threadId: string) => prompts.filter(entry => entry.threadId === threadId).map(entry => entry.prompt) };
}

/** What `run` threw, or rejected with. */
async function failure(run: () => unknown): Promise<Error & { rpc: { data?: unknown } }> {
  try { await run(); } catch (error) { return error as Error & { rpc: { data?: unknown } }; }
  throw new Error('expected a failure');
}

const DESKTOP = 'app-desktop-0001';
async function experiment(client: CoreClient, on = true) {
  await client.call('client.preferences', { app: DESKTOP, language: 'en', experiments: on ? ['teams'] : [], labels: {} });
}

type Bot = Awaited<ReturnType<typeof makeAgent>>;
async function setup(names = ['Ada'], dataDir?: string) {
  const h = await startTestCore(dataDir ? { dataDir } : {}); cores.push(h);
  const owner = await h.connect();
  await experiment(owner);
  const bots: Bot[] = [];
  for (const name of names) bots.push(await makeAgent(h, owner, { name }));
  const team = h.core.teams.create({ name: 'Crew', members: bots.map(bot => bot.agent.id) });
  const key = (bot: Bot) => teamMemberKey(h.core.coordination.card().coreId, bot.agent.id);
  const post = (text: string, extra: Partial<{ audience: 'team' | 'private'; to: string[]; inReplyTo: string; id: string; teamId: string }> = {}) =>
    h.core.teams.ownerPost({ teamId: team.id, id: crypto.randomUUID(), text, ...extra });
  return { h, owner, bots, team, key, post };
}

const db = (h: TestCore) => h.core.journal.db;
const teamLetters = (h: TestCore, threadId: string) => (db(h).query("SELECT data FROM coordination_letters WHERE thread_id = ? AND direction = 'in' AND json_extract(data, '$.team') IS NOT NULL ORDER BY created_at").all(threadId) as { data: string }[])
  .map(row => JSON.parse(row.data) as AgentLetter);
const seenRows = (h: TestCore, teamId: string) => db(h).query('SELECT member, seq, state FROM team_seen WHERE team_id = ? ORDER BY member, seq').all(teamId) as { member: string; seq: number; state: string }[];
const low = (h: TestCore, teamId: string, member: string) => (db(h).query('SELECT low FROM team_cursors WHERE team_id = ? AND member = ?').get(teamId, member) as { low: number } | null)?.low ?? 0;
const wakes = (h: TestCore, threadId: string) => turnsOf(h, threadId).filter(turn => turn.execution?.operation === 'coordination');
const posts = (h: TestCore, team: Team): TeamPost[] => h.core.teams.read({ team: team.id, limit: 100 }).posts;
const settledWakes = (h: TestCore, threadId: string) => wakes(h, threadId).every(turn => turn.status !== 'queued' && turn.status !== 'running');
const deliver = (h: TestCore, threadId: string) => (h.core.coordination as unknown as { deliver(threadId: string): Promise<void> }).deliver(threadId);
/** Delivery waits: a test hands the letters over itself. */
const holdDelivery = (h: TestCore) => {
  const spy = spyOn(h.core.coordination as unknown as { deliver(threadId: string): Promise<void> }, 'deliver').mockResolvedValue(undefined);
  return () => spy.mockRestore();
};

test('teams stay closed while the experiment is off, and members on other machines wait for a later version', async () => {
  const { h, owner, bots, team } = await setup();
  await experiment(owner, false);
  const off = await failure(() => owner.call('teams.list', {}));
  expect(off.rpc.data).toMatchObject({ reason: 'experiment-off' });
  expect((await failure(() => owner.call('teams.post', { teamId: team.id, id: 'x', text: 'hi' }))).rpc.data).toMatchObject({ reason: 'experiment-off' });
  await experiment(owner);
  expect((await owner.call('teams.list', {})).teams.map(entry => entry.name)).toEqual(['Crew']);
  const later = await failure(() => owner.call('teams.members.add', { teamId: team.id, botId: 'pc/Bob' }));
  expect(later.message).toContain('members on other machines come in a later version');
  // The team chat runs no agent and is no coordination contact.
  expect(h.core.journal.getThread(team.threadId)).toMatchObject({ teamId: team.id, projectId: null });
  expect(() => h.core.threads.startTurn(team.threadId, 'hello')).toThrow('a team chat runs no agent');
  expect(team.members[0]).toMatchObject({ botId: bots[0]!.agent.id, joinedSeq: 0 });
}, 30_000);

test('one owner post in a team of one bot gives one wake and one answer post, then nothing', async () => {
  const { h, bots: [ada], team, key, post } = await setup();
  const driver = teamDriver(() => ({ text: 'Release shipped.' }));
  const sent = post('Ship the release');
  expect(sent).toMatchObject({ seq: 1, routedBy: 'single', to: [key(ada!)] });
  await waitFor(() => posts(h, team).length === 2 && settledWakes(h, ada!.threadId));
  const [wake] = wakes(h, ada!.threadId);
  expect(wakes(h, ada!.threadId)).toHaveLength(1);
  const answer = posts(h, team)[1]!;
  expect(answer).toMatchObject({ id: answerPostId(wake!.id), author: key(ada!), audience: 'team', text: 'Release shipped.', inReplyTo: sent.id, turnId: wake!.id, routedBy: 'reply', to: ['owner'] });
  const prompt = driver.of(ada!.threadId)[0]!;
  expect(prompt).toContain('#1 owner in the group, for you:\nShip the release');
  expect(prompt).toContain('Your final answer is posted in the group of "Crew"');
  // The answer goes to the owner, who is no bot: nothing else starts.
  await deliver(h, ada!.threadId);
  await Bun.sleep(200);
  expect(wakes(h, ada!.threadId)).toHaveLength(1);
  expect(posts(h, team)).toHaveLength(2);
  expect(teamLetters(h, ada!.threadId).map(letter => letter.status)).toEqual(['delivered']);
  expect(h.core.teams.read({ team: 'crew' }).deliveries).toContainEqual(expect.objectContaining({ postId: sent.id, member: key(ada!), state: 'delivered' }));
}, 30_000);

test('the author is never a recipient, whatever it names', async () => {
  const { h, bots: [ada, bob, cy], team, key } = await setup(['Ada', 'Bob', 'Cy']);
  teamDriver();
  const everyone = h.core.teams.say({ threadId: ada!.threadId, team: 'Crew', text: '@tous status, and @Ada too' });
  expect(everyone.to.sort()).toEqual([key(bob!), key(cy!)].sort());
  expect(everyone.routedBy).toBe('everyone');
  const self = h.core.teams.say({ threadId: ada!.threadId, team: 'Crew', text: 'note to @Ada' });
  expect(self).toMatchObject({ to: [], routedBy: 'mention' });
  // A reply to one's own post wakes nobody.
  expect(routeTeamPost(team, { author: key(ada!), text: 'more', audience: 'team', inReplyTo: self.id }, key(ada!))).toEqual({ to: [], routedBy: 'reply' });
  await waitFor(() => settledWakes(h, bob!.threadId) && settledWakes(h, cy!.threadId) && wakes(h, bob!.threadId).length === 1 && wakes(h, cy!.threadId).length === 1);
  expect(wakes(h, ada!.threadId)).toHaveLength(0);
  expect(teamLetters(h, ada!.threadId)).toHaveLength(0);
}, 30_000);

test('a private post reaches only its recipient: not the others\' letters, reads, search, directory or transcript reads', async () => {
  const { h, owner, bots: [ada, bob], team, key, post } = await setup(['Ada', 'Bob']);
  const driver = teamDriver();
  post('The launch code is 4321', { audience: 'private', to: [bob!.agent.id] });
  await waitFor(() => wakes(h, bob!.threadId).length === 1 && settledWakes(h, bob!.threadId));
  expect(driver.of(bob!.threadId)[0]).toContain('owner privately to you, for you:\nThe launch code is 4321');
  expect(driver.of(bob!.threadId)[0]).toContain('Your final answer is posted privately to owner');
  post('@Ada what is new?');
  await waitFor(() => wakes(h, ada!.threadId).length === 1 && settledWakes(h, ada!.threadId));
  expect(driver.of(ada!.threadId).join('\n')).not.toContain('4321');
  expect(h.core.teams.read({ threadId: ada!.threadId, team: 'Crew' }).posts.map(entry => entry.text)).toEqual(['@Ada what is new?']);
  expect(h.core.teams.read({ threadId: bob!.threadId, team: 'Crew' }).posts.map(entry => entry.text)).toContain('The launch code is 4321');
  expect(h.core.teams.read({ threadId: ada!.threadId, team: 'Crew' }).deliveries).toEqual([]);
  // Coordination never opens the team chat to anyone.
  const brief: CoordinationConfig = { mode: 'brief', resources: '', remote: true, paused: false };
  const other = (await echoThread(h, owner, 'Snoop')).threadId;
  h.core.coordination.configure(other, brief);
  h.core.coordination.configure(team.threadId, brief);
  expect((await h.core.coordination.directory(other)).agents.map(contact => contact.threadId)).not.toContain(team.threadId);
  const found = await h.core.coordination.search(other, '4321');
  expect(found.matches.map(match => match.threadId)).not.toContain(team.threadId);
  expect((await failure(() => h.core.coordination.read(other, { coreId: h.core.coordination.card().coreId, threadId: team.threadId }))).message).toContain('not a contact this thread may reach');
  expect((await failure(() => h.core.coordination.send({ threadId: other, to: { coreId: h.core.coordination.card().coreId, threadId: team.threadId }, text: 'hi', requestId: crypto.randomUUID() }))).message).toContain('recipient is unavailable');
  expect(key(ada!)).not.toBe(key(bob!));
}, 30_000);

test('a burst of three mentions becomes one letter and one wake', async () => {
  const { h, bots: [ada, bob], post } = await setup(['Ada', 'Bob']);
  const driver = teamDriver();
  // Three posts in one tick: the kick runs after them.
  post('@Ada one'); post('@Ada two'); post('@Ada three');
  expect(teamLetters(h, ada!.threadId)).toHaveLength(1);
  expect(teamLetters(h, ada!.threadId)[0]!.team).toEqual(expect.objectContaining({ triggers: [1, 2, 3], owner: true }));
  await waitFor(() => wakes(h, ada!.threadId).length === 1 && settledWakes(h, ada!.threadId));
  await Bun.sleep(100);
  expect(wakes(h, ada!.threadId)).toHaveLength(1);
  const prompt = driver.of(ada!.threadId)[0]!;
  for (const word of ['one', 'two', 'three']) expect(prompt).toContain(`for you:\n@Ada ${word}`);
  expect(wakes(h, bob!.threadId)).toHaveLength(0);
}, 30_000);

test('a queued wake that is cancelled releases its posts, and submission marks them seen', async () => {
  const { h, team, bots: [ada], key, post } = await setup();
  teamDriver();
  h.core.workforce.setLimits({ paused: true });
  // Bots paused: the owner's post still wakes its bot, as the owner's own message.
  const release = holdDelivery(h);
  post('Check the logs');
  const [letter] = teamLetters(h, ada!.threadId);
  expect(letter!.team!.owner).toBe(true);
  release();
  const unhold = holdAccountTurns(h);
  await deliver(h, ada!.threadId);
  expect(wakes(h, ada!.threadId)[0]?.status).toBe('queued');
  expect(seenRows(h, team.id)).toEqual([{ member: key(ada!), seq: 1, state: 'flight' }]);
  // The letter back in the inbox would wake again at once: the test looks first.
  const looking = holdDelivery(h);
  h.core.threads.stopQueuedCoordination(ada!.threadId);
  await waitFor(() => teamLetters(h, ada!.threadId)[0]?.status === 'received');
  expect(seenRows(h, team.id)).toEqual([]);
  looking();
  unhold();
  await deliver(h, ada!.threadId);
  await waitFor(() => teamLetters(h, ada!.threadId)[0]?.status === 'delivered' && settledWakes(h, ada!.threadId));
  expect(low(h, team.id, key(ada!))).toBe(1);
  expect(seenRows(h, team.id)).toEqual([]);
}, 30_000);

test('a wake that errors or is stopped releases its posts without a second wake; a fresh trigger shows them as context', async () => {
  for (const outcome of ['error', 'stopped'] as const) {
    const { h, team, bots: [ada], key, post } = await setup();
    let first = true;
    const driver = teamDriver(() => { const hold = first; first = false; return hold ? { hold: true } : { text: '[quiet]' }; });
    post('Rotate the keys');
    await waitFor(() => driver.running.length === 1);
    expect(seenRows(h, team.id)).toEqual([{ member: key(ada!), seq: 1, state: 'flight' }]);
    if (outcome === 'error') driver.running[0]!.finish('error');
    else h.core.scheduler.stop(ada!.threadId);
    await waitFor(() => settledWakes(h, ada!.threadId) && seenRows(h, team.id).length === 0);
    const [letter] = teamLetters(h, ada!.threadId);
    expect(letter).toMatchObject({ status: 'uncertain' });
    await deliver(h, ada!.threadId);
    await Bun.sleep(100);
    expect(wakes(h, ada!.threadId)).toHaveLength(1);
    post('Then restart the API');
    await waitFor(() => wakes(h, ada!.threadId).length === 2 && settledWakes(h, ada!.threadId));
    const second = driver.of(ada!.threadId).at(-1)!;
    expect(second).toContain('#1 owner in the group:\nRotate the keys');
    expect(second).toContain('#2 owner in the group, for you:\nThen restart the API');
    expect(low(h, team.id, key(ada!))).toBe(2);
    await cores.pop()!.stop();
    for (const restore of restores.splice(0).reverse()) restore();
  }
}, 30_000);

for (const order of ['steer first', 'wake first'] as const) test(`a steer during a wake shows only new posts, and ${order} leaves each post seen once`, async () => {
  const { h, team, bots: [ada], key, post } = await setup();
  const driver = teamDriver(() => ({ text: '[quiet]', hold: true }));
  post('Plan the migration');
  await waitFor(() => driver.running.length === 1 && wakes(h, ada!.threadId)[0]?.status === 'running');
  post('Also the backups');
  await waitFor(() => driver.steers.length === 1);
  const steer = driver.steers[0]!;
  expect(steer.prompt).toContain('#2 owner in the group, for you:\nAlso the backups');
  expect(steer.prompt).not.toContain('Plan the migration');
  expect(steer.prompt).toContain('your final answer is not posted');
  expect(seenRows(h, team.id).map(row => row.state)).toEqual(['flight', 'flight']);
  const acknowledge = async () => { steer.ack.resolve(true); await waitFor(() => teamLetters(h, ada!.threadId)[1]?.status === 'delivered'); };
  const finish = async () => { driver.running[0]!.finish('done'); await waitFor(() => teamLetters(h, ada!.threadId)[0]?.status === 'delivered' && settledWakes(h, ada!.threadId)); };
  if (order === 'steer first') { await acknowledge(); expect(low(h, team.id, key(ada!))).toBe(0); await finish(); }
  else { await finish(); expect(low(h, team.id, key(ada!))).toBe(1); await acknowledge(); }
  expect(low(h, team.id, key(ada!))).toBe(2);
  expect(seenRows(h, team.id)).toEqual([]);
  expect(wakes(h, ada!.threadId)).toHaveLength(1);
}, 30_000);

test('a private post to one bot never pins a third bot\'s cursor', async () => {
  const { h, team, bots: [ada, bob, cy], key, post } = await setup(['Ada', 'Bob', 'Cy']);
  teamDriver();
  post('Between us', { audience: 'private', to: [bob!.agent.id] });
  post('@Cy go');
  await waitFor(() => wakes(h, cy!.threadId).length === 1 && settledWakes(h, cy!.threadId) && settledWakes(h, bob!.threadId) && teamLetters(h, cy!.threadId)[0]?.status === 'delivered');
  expect(low(h, team.id, key(cy!))).toBe(2);
  expect(low(h, team.id, key(ada!))).toBe(0);
}, 30_000);

test('a team letter fits 16 KB: whole triggers oldest first, the rest wait in a new letter; context that does not fit is named', async () => {
  const { h, bots: [ada], post } = await setup();
  // No steer: each letter gets a wake of its own.
  const driver = teamDriver(undefined, false);
  const release = holdDelivery(h);
  const big = (n: number) => `@Ada ${n} ${'é'.repeat(3_900)}`;
  post(big(1)); post(big(2)); post(big(3));
  // Near its expiry, a letter still hands what it could not carry a full lifetime.
  db(h).query("UPDATE coordination_letters SET data = json_set(data, '$.expiresAt', ?) WHERE thread_id = ? AND direction = 'in'").run(Date.now() + 60_000, ada!.threadId);
  release();
  await deliver(h, ada!.threadId);
  await waitFor(() => wakes(h, ada!.threadId).length === 3 && settledWakes(h, ada!.threadId), 10_000);
  const prompts = driver.of(ada!.threadId);
  for (const prompt of prompts) expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(TEAM_LETTER_BYTES);
  prompts.forEach((prompt, index) => expect(prompt).toContain(`for you:\n@Ada ${index + 1} `));
  expect(teamLetters(h, ada!.threadId).map(letter => letter.team!.triggers)).toEqual([[1], [2], [3]]);
  for (const letter of teamLetters(h, ada!.threadId).slice(1)) expect(letter.expiresAt - letter.createdAt).toBe(RESIDENT_LETTER_TTL_MS);
  // Context from the newest back; what does not fit is named, and counts as read.
  const at = (seq: number, text: string): TeamPost => ({ id: `p${seq}`, teamId: 't', seq, author: 'owner', text, audience: 'team', to: [], routedBy: 'none', why: null, inReplyTo: null, turnId: null, fingerprint: '', createdAt: 0 });
  const line = (entry: TeamPost, trigger: boolean) => teamPostLine(entry, 'c/a', () => 'owner', trigger);
  const plan = planTeamLetter([at(5, 'now')], [1, 2, 3, 4].map(seq => at(seq, 'x'.repeat(3_990))), line);
  expect(plan.context.map(entry => entry.seq)).toEqual([2, 3, 4]);
  expect(plan.omitted.map(entry => entry.seq)).toEqual([1]);
  expect(teamPrompt({ team: 'Crew', you: 'c/a', plan, channel: null, name: () => 'owner' })).toContain('1 earlier post is not shown: boite team read "Crew" --before 2.');
}, 30_000);

test('a batch takes two team letters; the third waits for the next one, and two teams render apart', async () => {
  const { h, bots: [ada], post } = await setup();
  teamDriver();
  const ops = h.core.teams.create({ name: 'Ops', members: [ada!.agent.id] });
  const docs = h.core.teams.create({ name: 'Docs', members: [ada!.agent.id] });
  const release = holdDelivery(h);
  post('crew work');
  h.core.teams.ownerPost({ teamId: ops.id, id: crypto.randomUUID(), text: 'ops work' });
  h.core.teams.ownerPost({ teamId: docs.id, id: crypto.randomUUID(), text: 'docs work' });
  const turnId = turnsOf(h, ada!.threadId)[0]!.id;
  const first = h.core.coordination.take(ada!.threadId, turnId)!;
  expect(first).toContain('Team "Crew"');
  expect(first).toContain('Team "Ops"');
  expect(first).not.toContain('docs work');
  expect(first.indexOf('ops work')).toBeGreaterThan(first.indexOf('Team "Ops"'));
  expect(teamLetters(h, ada!.threadId).map(letter => letter.status)).toEqual(['delivered', 'delivered', 'received']);
  expect(h.core.coordination.take(ada!.threadId, turnId)).toContain('docs work');
  release();
}, 30_000);

test('a restarted core redelivers a queued team wake with its owner flag', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-teams-'));
  try {
    const first = await setup(['Ada'], dataDir);
    const { h, bots: [ada], post } = first;
    teamDriver();
    holdAccountTurns(h);
    post('After the restart');
    await waitFor(() => wakes(h, ada!.threadId)[0]?.status === 'queued');
    await cores.pop()!.stop();
    for (const restore of restores.splice(0).reverse()) restore();
    const again = await startTestCore({ dataDir }); cores.push(again);
    const driver = teamDriver(() => ({ text: '[quiet]' }));
    // Bots paused: only an owner wake runs now.
    again.core.workforce.setLimits({ paused: true });
    expect(teamLetters(again, ada!.threadId)[0]?.team?.owner).toBe(true);
    await deliver(again, ada!.threadId);
    await waitFor(() => driver.of(ada!.threadId).length === 1 && settledWakes(again, ada!.threadId));
    expect(driver.of(ada!.threadId)[0]).toContain('After the restart');
    const last = wakes(again, ada!.threadId).at(-1)!;
    expect(last.status).toBe('done');
    await cores.pop()!.stop();
  } finally { await removeDir(dataDir); }
}, 30_000);

test('a paused team holds its letters on the hook, the steer and the wake; resuming delivers them; a removal rejects them', async () => {
  const { h, owner, team, bots: [ada], key, post } = await setup();
  const driver = teamDriver(prompt => (prompt.includes('Team "Crew"') ? { text: '[quiet]' } : { hold: true }));
  await owner.call('teams.pause', { teamId: team.id, paused: true });
  post('While paused');
  await deliver(h, ada!.threadId);
  expect(wakes(h, ada!.threadId)).toHaveLength(0);
  expect(h.core.coordination.take(ada!.threadId, turnsOf(h, ada!.threadId)[0]!.id)).toBeNull();
  // A running turn takes no steer from a paused team either.
  h.core.threads.startTurn(ada!.threadId, 'Busy work');
  await waitFor(() => driver.running.length === 1 && h.core.threads.canSteer(ada!.threadId));
  await deliver(h, ada!.threadId);
  expect(driver.steers).toHaveLength(0);
  await owner.call('teams.pause', { teamId: team.id, paused: false });
  await waitFor(() => driver.steers.length === 1);
  expect(driver.steers[0]!.prompt).toContain('While paused');
  driver.steers[0]!.ack.resolve(true);
  driver.running[0]!.finish();
  await waitFor(() => teamLetters(h, ada!.threadId)[0]?.status === 'delivered');
  await owner.call('teams.pause', { teamId: team.id, paused: true });
  const waiting = post('Never read');
  await owner.call('teams.members.remove', { teamId: team.id, botId: ada!.agent.id });
  expect(teamLetters(h, ada!.threadId)[1]).toMatchObject({ status: 'rejected', error: 'Ada left the team Crew' });
  expect(h.core.teams.read({ team: team.id }).deliveries).toContainEqual(expect.objectContaining({ postId: waiting.id, member: key(ada!), state: 'rejected', reason: 'Ada left the team Crew' }));
}, 30_000);

test('the reply envelope is fixed at the wake: a steer does not move it, and a mixed batch posts nothing', async () => {
  const { h, owner, team, bots: [ada], post } = await setup();
  const driver = teamDriver(() => ({ text: 'For the group', hold: true }));
  post('Group work');
  await waitFor(() => driver.running.length === 1);
  post('Just for you', { audience: 'private', to: [ada!.agent.id] });
  await waitFor(() => driver.steers.length === 1);
  driver.steers[0]!.ack.resolve(true);
  driver.running[0]!.finish();
  await waitFor(() => posts(h, team).length === 3);
  expect(posts(h, team)[2]).toMatchObject({ text: 'For the group', audience: 'team' });

  // An ordinary letter and a team letter in one wake: the answer goes nowhere.
  const other = (await echoThread(h, owner, 'Ops desk')).threadId;
  const brief: CoordinationConfig = { mode: 'brief', resources: '', remote: true, paused: false };
  h.core.coordination.configure(other, brief);
  h.core.coordination.configure(ada!.threadId, brief);
  const mixed = teamDriver(() => ({ text: 'Mixed answer' }));
  const release = holdDelivery(h);
  await h.core.coordination.send({ threadId: other, to: { coreId: h.core.coordination.card().coreId, threadId: ada!.threadId }, text: 'Ordinary letter', requestId: crypto.randomUUID() });
  post('@Ada team work');
  release();
  await deliver(h, ada!.threadId);
  await waitFor(() => mixed.of(ada!.threadId).length === 1 && settledWakes(h, ada!.threadId));
  const prompt = mixed.of(ada!.threadId)[0]!;
  expect(prompt).toContain('Ordinary letter');
  expect(prompt).toContain('team work');
  expect(prompt).toContain('your final answer is not posted');
  await Bun.sleep(100);
  expect(posts(h, team).map(entry => entry.text)).not.toContain('Mixed answer');
}, 30_000);

test('past the daily budget a bot\'s post waits through admit, and the owner\'s post still wakes', async () => {
  const { h, owner, bots: [ada, bob], post } = await setup(['Ada', 'Bob']);
  const driver = teamDriver(() => ({ text: '[quiet]', usage: costing(0.5) }));
  const runtime = await owner.call('agents.runtime.get', { agentId: ada!.agent.id });
  await owner.call('agents.runtime.configure', { agentId: ada!.agent.id, expectedRevision: h.core.workforce.records.get('profile', ada!.agent.id).revision, config: { ...runtime, dailyBudgetUsd: 0.01 } });
  // A spent turn of Ada's today.
  h.core.threads.startTurn(ada!.threadId, 'Spend');
  await waitFor(() => turnsOf(h, ada!.threadId).every(turn => turn.status === 'done') && driver.of(ada!.threadId).length === 1);
  h.core.teams.say({ threadId: bob!.threadId, team: 'Crew', text: '@Ada from a bot' });
  await deliver(h, ada!.threadId);
  await Bun.sleep(100);
  expect(wakes(h, ada!.threadId)).toHaveLength(0);
  expect(teamLetters(h, ada!.threadId)[0]).toMatchObject({ status: 'received' });
  post('@Ada from the owner');
  await waitFor(() => wakes(h, ada!.threadId).length === 1 && settledWakes(h, ada!.threadId));
  const prompt = driver.of(ada!.threadId).at(-1)!;
  expect(prompt).toContain('from a bot');
  expect(prompt).toContain('from the owner');
}, 30_000);

test('a retried publication or post gives one post, and a reused id with other content is refused', async () => {
  const { h, team, bots: [ada], post } = await setup();
  teamDriver(() => ({ text: 'Once.' }));
  const sent = post('Say it once', { id: 'p-1' });
  expect(post('Say it once', { id: 'p-1' })).toEqual(sent);
  expect((await failure(() => post('Something else', { id: 'p-1' }))).message).toContain('already used for a different post');
  await waitFor(() => posts(h, team).length === 2 && settledWakes(h, ada!.threadId));
  const [wake] = wakes(h, ada!.threadId);
  const again = h.core.teams.publishAnswer(wake!);
  expect(again?.id).toBe(answerPostId(wake!.id));
  expect(posts(h, team)).toHaveLength(2);
  expect(h.core.journal.listTurns(team.threadId)).toHaveLength(2);
}, 30_000);

/** `boite <args>` from a bot's thread, with its agent token. */
async function boiteAs(h: TestCore, threadId: string, args: string[]) {
  let out = '';
  let err = '';
  const env = { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: h.url, [AGENT_ENV.token]: h.core.agents.tokenFor(threadId) };
  const code = await runCli(args, { out: text => { out += text; }, err: text => { err += text; }, env, cwd: process.cwd() });
  return { code, out, err };
}

test('boite team: a bot lists, posts, reads and asks for cards; the experiment and other machines refuse', async () => {
  const { h, owner, bots: [ada, bob], team, key } = await setup(['Ada', 'Bob']);
  teamDriver();
  expect((await boiteAs(h, ada!.threadId, ['team', 'list'])).out).toContain('Crew: Ada, Bob');
  const said = await boiteAs(h, ada!.threadId, ['team', 'say', 'Crew', '@Bob', 'check', 'the', 'build', '--request-id', 'post-1']);
  expect(said.out).toContain('posted: #1 in Crew (post-1)');
  expect(said.out).toContain(`wakes: ${key(bob!)}`);
  // A retry with the same id gives the same post.
  expect((await boiteAs(h, ada!.threadId, ['team', 'say', 'Crew', '@Bob check the build', '--request-id', 'post-1'])).out).toContain('posted: #1');
  await boiteAs(h, ada!.threadId, ['team', 'dm', 'Crew', 'owner', 'private', 'note']);
  const read = await boiteAs(h, bob!.threadId, ['team', 'read', 'Crew', '--before', '5']);
  expect(read.out).toContain('#1 Ada in the group (post-1): @Bob check the build');
  expect(read.out).not.toContain('private note');
  const proposed = await boiteAs(h, ada!.threadId, ['team', 'propose', '--name', 'Pair', '--members', 'Bob', '--brief', 'Release work']);
  expect(proposed.out).toContain('card: create Pair with Bob');
  expect(h.core.threads.listQuestions(ada!.threadId).map(request => request.team?.kind)).toEqual(['create']);
  expect((await boiteAs(h, bob!.threadId, ['team', 'leave', 'Crew'])).out).toContain('card: leave Crew');
  const remote = await boiteAs(h, ada!.threadId, ['team', 'invite', 'Crew', 'pc/Cy']);
  expect(remote.code).not.toBe(0);
  expect(remote.err).toContain('members on other machines come in a later version');
  await experiment(owner, false);
  const off = await boiteAs(h, ada!.threadId, ['team', 'list']);
  expect(off.code).not.toBe(0);
  expect(off.err).toContain('Teams experiment');
  expect(team.members).toHaveLength(2);
}, 30_000);

// Round 1 of the review: what a crash, a restart or a setting must not lose.

test('a post whose letters were interrupted reaches its recipients once: a retried id or a restart repairs it', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-teams-'));
  try {
    const { h, team, bots: [ada, bob], post } = await setup(['Ada', 'Bob'], dataDir);
    teamDriver();
    h.core.teams.pause({ teamId: team.id, paused: true });
    // The post stands though both letters fail, and a retry whose first repair fails still makes the other.
    const cut = spyOn(h.core.coordination.teamLetters, 'accept').mockImplementation(() => { throw new Error('interrupted before the letter'); });
    expect(post('@Ada @Bob ping', { id: 'gap-1' }).seq).toBe(1);
    cut.mockRestore();
    const once = spyOn(h.core.coordination.teamLetters, 'accept').mockImplementationOnce(() => { throw new Error('interrupted before the letter'); });
    post('@Ada @Bob ping', { id: 'gap-1' });
    expect(teamLetters(h, ada!.threadId).length + teamLetters(h, bob!.threadId).length).toBe(1);
    once.mockRestore();
    post('@Ada @Bob ping', { id: 'gap-1' });
    expect(teamLetters(h, ada!.threadId).map(letter => letter.team!.triggers)).toEqual([[1]]);
    expect(teamLetters(h, bob!.threadId).map(letter => letter.team!.triggers)).toEqual([[1]]);
    // Interrupted again, and the core stops before anyone retries.
    spyOn(h.core.coordination.teamLetters, 'accept').mockImplementation(() => { throw new Error('interrupted before the letter'); });
    post('@Ada again', { id: 'gap-2' });
    await cores.pop()!.stop();
    for (const restore of restores.splice(0).reverse()) restore();
    const again = await startTestCore({ dataDir }); cores.push(again);
    await experiment(await again.connect());
    const driver = teamDriver();
    expect(teamLetters(again, ada!.threadId).map(letter => letter.team!.triggers)).toEqual([[1, 2]]);
    again.core.teams.pause({ teamId: team.id, paused: false });
    await waitFor(() => wakes(again, ada!.threadId).length === 1 && settledWakes(again, ada!.threadId));
    expect(driver.of(ada!.threadId)).toHaveLength(1);
    expect(driver.of(ada!.threadId)[0]).toContain('again');
    await cores.pop()!.stop();
  } finally { await removeDir(dataDir); }
}, 30_000);

test('two members of one name: a name picks neither, an id picks the right one', async () => {
  const { h, team, bots: [, second], key } = await setup(['Ada', 'Ada']);
  teamDriver();
  for (const call of [() => h.core.teams.ownerPost({ teamId: team.id, id: 'twin-1', text: 'hi', audience: 'private', to: ['Ada'] }),
    () => h.core.teams.removeMember({ teamId: team.id, botId: 'ada' })]) expect((await failure(call)).message).toMatch(/2 members are named "ada"/i);
  expect(h.core.teams.ownerPost({ teamId: team.id, id: 'twin-2', text: 'hi', audience: 'private', to: [second!.agent.id] }).to).toEqual([key(second!)]);
}, 30_000);

test('a private answer to a member who left is dropped once, not retried at every turn', async () => {
  const { h, team, bots: [ada, bob] } = await setup(['Ada', 'Bob']);
  const driver = teamDriver(() => ({ text: 'noted', hold: true }));
  h.core.teams.dm({ threadId: bob!.threadId, team: team.id, to: ada!.agent.id, text: 'between us' });
  await waitFor(() => driver.running.length === 1);
  h.core.teams.removeMember({ teamId: team.id, botId: bob!.agent.id });
  driver.running[0]!.finish();
  await waitFor(() => settledWakes(h, ada!.threadId) && JSON.stringify(db(h).query('SELECT published FROM team_replies').all()) === '[{"published":1}]');
  expect(posts(h, team).map(post => post.text)).toEqual(['between us']);
}, 30_000);

test('an interrupted post to a member the owner removed stays with the old membership: no retry or restart revives it after a rejoin', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-teams-'));
  try {
    const { h, team, bots: [, bob], post } = await setup(['Ada', 'Bob'], dataDir);
    teamDriver();
    h.core.teams.pause({ teamId: team.id, paused: true });
    const cut = spyOn(h.core.coordination.teamLetters, 'accept').mockImplementation(() => { throw new Error('interrupted before the letter'); });
    post('@Bob OLD_MEMBERSHIP_REQUEST', { id: 'old-1' });
    cut.mockRestore();
    h.core.teams.removeMember({ teamId: team.id, botId: bob!.agent.id });
    const delivery = (core: typeof h) => core.core.journal.db.query("SELECT state FROM team_deliveries WHERE post_id = 'old-1'").all();
    expect(delivery(h)).toEqual([{ state: 'rejected' }]);
    h.core.teams.addMember({ teamId: team.id, botId: bob!.agent.id });
    post('@Bob OLD_MEMBERSHIP_REQUEST', { id: 'old-1' });
    expect(teamLetters(h, bob!.threadId)).toEqual([]);
    post('@Bob fresh request');
    await cores.pop()!.stop();
    for (const restore of restores.splice(0).reverse()) restore();
    const again = await startTestCore({ dataDir }); cores.push(again);
    await experiment(await again.connect());
    const driver = teamDriver();
    expect(teamLetters(again, bob!.threadId).map(letter => letter.team!.triggers)).toEqual([[2]]);
    again.core.teams.pause({ teamId: team.id, paused: false });
    await waitFor(() => wakes(again, bob!.threadId).length === 1 && settledWakes(again, bob!.threadId));
    expect(driver.of(bob!.threadId)[0]).toContain('fresh request');
    expect(driver.of(bob!.threadId)[0]).not.toContain('OLD_MEMBERSHIP_REQUEST');
    await cores.pop()!.stop();
  } finally { await removeDir(dataDir); }
}, 30_000);

test('a steer left unacknowledged by a restart releases its posts: the next delivery renders them', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-teams-'));
  try {
    const { h, team, bots: [ada], post } = await setup(['Ada'], dataDir);
    const driver = teamDriver(() => ({ hold: true }));
    h.core.threads.startTurn(ada!.threadId, 'Ordinary work');
    await waitFor(() => driver.running.length === 1);
    post('Earlier post');
    await waitFor(() => driver.steers.length === 1);
    expect(seenRows(h, team.id).map(row => row.state)).toEqual(['flight']);
    await cores.pop()!.stop();
    for (const restore of restores.splice(0).reverse()) restore();
    const again = await startTestCore({ dataDir }); cores.push(again);
    await experiment(await again.connect());
    expect(seenRows(again, team.id)).toEqual([]);
    expect(teamLetters(again, ada!.threadId)[0]).toMatchObject({ status: 'uncertain', error: 'Awaiting provider acknowledgement' });
    const fresh = teamDriver();
    again.core.teams.ownerPost({ teamId: team.id, id: 'fresh', text: 'Fresh trigger' });
    await waitFor(() => fresh.of(ada!.threadId).length === 1 && settledWakes(again, ada!.threadId));
    expect(fresh.of(ada!.threadId)[0]).toContain('Earlier post');
    await cores.pop()!.stop();
  } finally { await removeDir(dataDir); }
}, 30_000);

test('an answer the core did not publish before it stopped is posted once at the next start', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-teams-'));
  const answers = (h: TestCore) => (db(h).query("SELECT COUNT(*) AS n FROM team_posts WHERE text = 'The final answer'").get() as { n: number }).n;
  try {
    const { h, bots: [ada], post } = await setup(['Ada'], dataDir);
    teamDriver(() => ({ text: 'The final answer' }));
    // Stopped between the turn's commit and its publication.
    h.core.teams.close();
    post('Answer this');
    await waitFor(() => wakes(h, ada!.threadId)[0]?.status === 'done');
    expect(answers(h)).toBe(0);
    await cores.pop()!.stop();
    for (const restore of restores.splice(0).reverse()) restore();
    for (let start = 0; start < 2; start += 1) {
      const again = await startTestCore({ dataDir }); cores.push(again);
      await waitFor(() => answers(again) === 1);
      await Bun.sleep(50);
      expect(answers(again)).toBe(1);
      await cores.pop()!.stop();
    }
  } finally { await removeDir(dataDir); }
}, 30_000);

test('turning a bot\'s coordination off leaves its team letters, waiting or queued, to the team', async () => {
  const { h, team, bots: [ada, bob], post } = await setup(['Ada', 'Bob']);
  const driver = teamDriver();
  const off: CoordinationConfig = { mode: 'off', resources: '', remote: true, paused: false };
  h.core.teams.pause({ teamId: team.id, paused: true });
  post('@Ada held');
  h.core.coordination.configure(ada!.threadId, off);
  expect(teamLetters(h, ada!.threadId)[0]).toMatchObject({ status: 'received' });
  const unhold = holdAccountTurns(h);
  h.core.teams.pause({ teamId: team.id, paused: false });
  post('@Bob queued');
  await waitFor(() => wakes(h, bob!.threadId)[0]?.status === 'queued' && wakes(h, ada!.threadId)[0]?.status === 'queued');
  h.core.coordination.configure(bob!.threadId, off);
  expect(wakes(h, bob!.threadId)[0]?.status).toBe('queued');
  unhold();
  await waitFor(() => [ada!, bob!].every(bot => teamLetters(h, bot.threadId)[0]?.status === 'delivered' && settledWakes(h, bot.threadId)));
  expect(driver.of(ada!.threadId)[0]).toContain('held');
  expect(driver.of(bob!.threadId)[0]).toContain('queued');
}, 30_000);

test('a team chat refuses what would reach a provider: turns, retitle, compact, rewind, fork, move, side requests, selection and goals', async () => {
  const { h, owner, team, post } = await setup();
  let titles = 0;
  restores.push(setDriver('echo', { protocol: 'echo', startTurn() { throw new Error('a team chat ran an agent'); }, async title() { titles += 1; return 'Not the team'; } }));
  post('First post');
  const [message] = h.core.journal.listMessages(team.threadId);
  const project = await owner.call('projects.add', { name: 'Elsewhere', path: mkdtempSync(join(tmpdir(), 'boite-teams-project-')) });
  const threadId = team.threadId;
  const calls: [string, () => Promise<unknown>][] = [
    ['turns.start', () => owner.call('turns.start', { threadId, prompt: 'hi', clientRequestId: 'c-1' })],
    ['threads.retitle', () => owner.call('threads.retitle', { threadId })],
    ['threads.compact', () => owner.call('threads.compact', { threadId })],
    ['threads.rewind', () => owner.call('threads.rewind', { threadId, messageId: message!.id })],
    ['threads.fork', () => owner.call('threads.fork', { threadId, messageId: message!.id })],
    ['threads.move', () => owner.call('threads.move', { threadId, projectId: project.id })],
    ['threads.btw', () => owner.call('threads.btw', { threadId, question: 'and?', requestId: 'btw-00001' })],
    ['threads.update', () => owner.call('threads.update', { threadId, model: 'other' })],
    ['threads.goal.track', () => owner.call('threads.goal.track', { threadId })],
    ['turns.recover', () => owner.call('turns.recover', { threadId, turnId: message!.turnId, action: 'resume' })],
  ];
  const refusals: [string, string][] = [];
  for (const [name, call] of calls) refusals.push([name, (await failure(call)).message]);
  expect(refusals.filter(([, text]) => !text.includes('a team chat runs no agent'))).toEqual([]);
  expect(titles).toBe(0);
  expect(h.core.threads.require(threadId)).toMatchObject({ title: 'Crew', projectId: null });
}, 30_000);

test('a bot\'s post marks the team chat unread; a private post to the owner notifies the owner, group and owner posts do not', async () => {
  const { h, team, bots: [ada], post } = await setup();
  teamDriver();
  const notify = spyOn(h.core.push as unknown as { notify(threadId: string, text: { body: string }, tag: string): void }, 'notify').mockImplementation(() => undefined);
  const updated: string[] = [];
  const off = h.core.bus.onAny((name, payload) => { if (name === 'thread.updated' && (payload as { id: string }).id === team.threadId) updated.push(name); });
  const before = h.core.threads.require(team.threadId).updatedAt;
  post('@Ada status?');
  expect(h.core.threads.require(team.threadId).unread).toBe(false);
  await Bun.sleep(5);
  h.core.teams.say({ threadId: ada!.threadId, team: 'Crew', text: 'All green' });
  const chat = h.core.threads.require(team.threadId);
  expect(chat.unread).toBe(true);
  expect(chat.updatedAt).toBeGreaterThan(before);
  expect(updated.length).toBeGreaterThan(0);
  expect(notify).not.toHaveBeenCalled();
  h.core.threads.markRead(team.threadId);
  h.core.teams.dm({ threadId: ada!.threadId, team: 'Crew', to: 'owner', text: 'Only for you' });
  expect(h.core.threads.require(team.threadId).unread).toBe(true);
  expect(notify.mock.calls.map(([threadId, text]) => [threadId, text.body])).toEqual([[team.threadId, 'Ada: Only for you']]);
  off();
}, 30_000);
