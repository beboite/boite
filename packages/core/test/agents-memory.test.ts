import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_MEMORY_MAX } from '@boite/contracts';
import { parseMemoryAnswer } from '../src/agents/memory.ts';
import { agentValue, echoAccount, makeAgent, scripted, settled, turnsOf } from './agent-fixture.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

const PASS = 'You keep the long-term memory of';

/** An agent that answers in words, and a memory pass that answers `pass(prompt)` and stays running until `release`. */
function script(pass: (prompt: string) => string) {
  const driver = scripted(ctx => ctx.prompt.includes(PASS) ? { text: pass(ctx.prompt), hold: true } : { text: ctx.prompt.includes('[quiet]-wake') ? '[quiet] nothing new' : 'The release is on Friday.' });
  restores.push(driver.restore);
  return driver;
}

async function setup(name = 'Ada') {
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  // The introduction runs with its pass held, then released, so each scenario starts from a settled agent.
  const made = await makeAgent(h, client, { name }, false);
  return { h, client, ...made, ask: (prompt: string) => client.call('turns.start', { threadId: made.threadId, prompt }) };
}
const passes = (h: TestCore, threadId: string) => h.core.journal.listThreads().filter(t => t.parentThreadId === threadId);

test('a pass answer names its summary and file; repeating the instructions or no change writes nothing', () => {
  expect(parseMemoryAnswer('SUMMARY: Noted Friday\n<memory>\n# Memory\n- release Friday\n</memory>')).toEqual({ summary: 'Noted Friday', memory: '# Memory\n- release Friday\n' });
  expect(parseMemoryAnswer('SUMMARY: no change')).toEqual({ summary: null, memory: null });
  // An answer that quotes the instructions first ends on its own summary.
  expect(parseMemoryAnswer('SUMMARY: <one short line>\n<memory>\n<the whole new MEMORY.md>\n</memory>\nanswer only this line:\nSUMMARY: no change')).toEqual({ summary: null, memory: null });
  expect(parseMemoryAnswer('SUMMARY: <one short line>\n<memory>\n<the whole new MEMORY.md>\n</memory>')).toEqual({ summary: null, memory: null });
  expect(parseMemoryAnswer('I updated it.')).toEqual({ summary: null, memory: null });
});

test('after an answer a memory pass rewrites MEMORY.md without holding the next turn, and its answer never reaches the agent', async () => {
  const driver = script(() => 'SUMMARY: Noted the release date\n<memory>\n# Memory\n- 2026-10-13: the release is on Friday\n</memory>');
  const { h, agent, threadId, ask } = await setup();
  // The introduction's pass is running: the next turn does not wait for it.
  await waitFor(() => driver.held.length === 1);
  const prompt = driver.prompts.get(passes(h, threadId)[0]!.id)![0]!;
  expect(prompt).toContain('The release is on Friday.');
  expect(prompt).toContain(`at most ${AGENT_MEMORY_MAX} characters`);
  const before = turnsOf(h, threadId).length;
  await ask('When is the release?');
  await waitFor(() => turnsOf(h, threadId).length === before + 1 && settled(h, threadId));
  expect(driver.held).toHaveLength(1);
  driver.release();
  await waitFor(() => h.core.workforce.resident.brain(agent.id).memory === '# Memory\n- 2026-10-13: the release is on Friday\n');
  // The turn that ended while the pass ran goes next, once: two passes in all, both archived when done.
  await waitFor(() => driver.held.length === 1);
  driver.release();
  await waitFor(() => !h.core.workforce.memory.busy());
  expect(passes(h, threadId)).toHaveLength(2);
  expect(passes(h, threadId).every(t => t.archived)).toBe(true);
  // Nothing of the pass came back to the agent's thread as a turn.
  expect(turnsOf(h, threadId)).toHaveLength(before + 1);
});

test('a quiet wake starts no pass; a pass that runs past the cap or drops most of the memory changes nothing; the owner can turn it off', async () => {
  let answer = 'SUMMARY: Trimmed\n<memory>\n- one line\n</memory>';
  const driver = script(() => answer);
  const { h, client, agent, threadId } = await setup();
  await waitFor(() => driver.held.length === 1);
  driver.release();
  await waitFor(() => !h.core.workforce.memory.busy());
  const brain = h.core.workforce.resident.brain(agent.id);
  const long = Array.from({ length: 80 }, (_, i) => `- 2026-10-${String(1 + i % 28).padStart(2, '0')}: fact number ${i} worth keeping`).join('\n');
  h.core.workforce.resident.saveBrain({ agentId: agent.id, expectedRevision: brain.revision, instructions: brain.instructions, memory: long });

  const quiet = h.core.agentRuntime.wake(agent.id, { kind: 'event', label: '1 project event', prompt: '[quiet]-wake' })!;
  await waitFor(() => h.core.journal.getTurn(quiet.id)?.status === 'done' && settled(h, threadId));
  expect(h.core.journal.getTurn(quiet.id)!.quiet).toBe(true);
  await Bun.sleep(300);
  expect(driver.held).toHaveLength(0);

  await client.call('turns.start', { threadId, prompt: 'Anything new?' });
  await waitFor(() => driver.held.length === 1);
  driver.release();
  await waitFor(() => !h.core.workforce.memory.busy());
  expect(h.core.workforce.resident.brain(agent.id).memory).toBe(long);

  answer = `SUMMARY: Grew\n<memory>\n${'x'.repeat(AGENT_MEMORY_MAX + 10)}\n</memory>`;
  await client.call('turns.start', { threadId, prompt: 'And this?' });
  await waitFor(() => driver.held.length === 1);
  driver.release();
  await waitFor(() => !h.core.workforce.memory.busy());
  expect(h.core.workforce.resident.brain(agent.id).memory).toBe(long);

  const runtime = await client.call('agents.runtime.get', { agentId: agent.id });
  expect(runtime.autoMemory).toBe(true);
  const profile = h.core.workforce.records.get('profile', agent.id);
  await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: profile.revision, config: { ...runtime, autoMemory: false } });
  const count = passes(h, threadId).length;
  await client.call('turns.start', { threadId, prompt: 'And now?' });
  await waitFor(() => settled(h, threadId) && turnsOf(h, threadId).at(-1)!.status === 'done');
  await Bun.sleep(300);
  expect(passes(h, threadId)).toHaveLength(count);
});

test('boite agent remember adds a dated line, and is refused once MEMORY.md is full', async () => {
  script(() => 'SUMMARY: no change');
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  const { agent, threadId } = await makeAgent(h, client);
  const noted = await client.call('agents.memory.note', { agentId: agent.id, text: 'The user\nwants short answers.' });
  expect(noted.memory).toMatch(/^- \d{4}-\d{2}-\d{2} The user wants short answers\.\n$/);
  const brain = h.core.workforce.resident.brain(agent.id);
  h.core.workforce.resident.saveBrain({ agentId: agent.id, expectedRevision: brain.revision, instructions: brain.instructions, memory: 'x'.repeat(AGENT_MEMORY_MAX - 5) });
  expect(await thrown(client.call('agents.memory.note', { agentId: agent.id, text: 'One more' }))).toThrow(`of ${AGENT_MEMORY_MAX} characters`);
  expect(await thrown(client.call('agents.memory.note', { threadId: 'thr_nobody', text: 'x' }))).toThrow("no persistent agent's thread");
  expect(threadId).toBeTruthy();
});

test('brains move to the folder the owner chooses, named after their agents, and back', async () => {
  script(() => 'SUMMARY: no change');
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  const { agent } = await makeAgent(h, client, { name: 'Open Source' });
  const { agent: twin } = await makeAgent(h, client, { name: 'Open source' });
  const before = h.core.workforce.resident.brain(agent.id);
  expect(before.path).toBe(join(h.dataDir, 'agent-workspaces', agent.id, 'brain'));
  h.core.workforce.resident.saveBrain({ agentId: agent.id, expectedRevision: before.revision, instructions: before.instructions, memory: 'Keep the prototype private.' });
  writeFileSync(join(before.path, 'skills', 'triage.md'), '# Triage\n');
  h.core.workforce.resident.brain(twin.id);

  mkdirSync(join(h.dataDir, '..', `brains-${agent.id}`, 'open-source-2'), { recursive: true });
  // The core keeps a chosen folder's real path: macOS's /tmp is a link to /private/tmp.
  const root = realpathSync(join(h.dataDir, '..', `brains-${agent.id}`));
  const taken = join(root, 'open-source-2');
  writeFileSync(join(taken, 'note.md'), 'mine');
  expect(await thrown(client.call('agents.brain.root', { path: 'relative/brains' }))).toThrow('absolute');
  expect(await thrown(client.call('agents.brain.root', { path: join(h.dataDir, 'inside') }))).toThrow("core's own data");

  const chosen = await client.call('agents.brain.root', { path: root });
  expect(chosen).toEqual({ path: root, custom: true });
  const moved = h.core.workforce.resident.brain(agent.id);
  expect(moved.path).toBe(join(root, 'open-source'));
  expect(moved.memory).toBe('Keep the prototype private.');
  expect(readFileSync(join(moved.path, 'skills', 'triage.md'), 'utf8')).toBe('# Triage\n');
  expect(existsSync(before.path)).toBe(false);
  // The second agent of the same name skips the folder that already holds someone's files.
  expect(h.core.workforce.resident.brain(twin.id).path).toBe(join(root, 'open-source-3'));
  expect(readFileSync(join(taken, 'note.md'), 'utf8')).toBe('mine');
  expect((await client.call('agents.snapshot', {})).brainRoot).toEqual({ path: root, custom: true });

  // A folder that already holds someone's files is never merged into: the brain takes the next name.
  mkdirSync(join(root, '..', `busy-${agent.id}`, 'open-source'), { recursive: true });
  const busy = realpathSync(join(root, '..', `busy-${agent.id}`));
  writeFileSync(join(busy, 'open-source', 'MEMORY.md'), 'other');
  expect(await client.call('agents.brain.root', { path: busy })).toEqual({ path: busy, custom: true });
  expect(h.core.workforce.resident.brain(agent.id).path).toBe(join(busy, 'open-source-2'));

  expect(await client.call('agents.brain.root', { path: null })).toEqual({ path: join(h.dataDir, 'agent-workspaces'), custom: false });
  expect(h.core.workforce.resident.brain(agent.id).memory).toBe('Keep the prototype private.');
  expect(h.core.workforce.resident.brain(agent.id).path).toBe(before.path);
});

test('subagents are on by default on any granted model; listed profiles restrict them', async () => {
  script(() => 'SUMMARY: no change');
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  h.core.workforce.setLimits({ paused: true });
  const agent = await client.call('agents.profile.save', { value: agentValue(echoAccount(h)) });
  const other = { ...agent.selection, model: 'echo-other' };
  expect(h.core.workforce.resident.config(agent.id).subagents).toMatchObject({ enabled: true, anyModel: true, profiles: [] });
  expect(h.core.workforce.resident.allowed(agent.id, other, true)).toBe(true);
  const runtime = await client.call('agents.runtime.get', { agentId: agent.id });
  const listed = await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision, config: { ...runtime, subagents: { ...runtime.subagents, profiles: [{ id: 'small', name: 'Small', providerId: 'echo', accountId: echoAccount(h), model: 'echo', effort: null }] } } });
  expect(h.core.workforce.resident.allowed(agent.id, other, true)).toBe(false);
  expect(h.core.workforce.resident.allowed(agent.id, { ...agent.selection, model: 'echo' }, true)).toBe(true);
  await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: listed.revision, config: { ...runtime, subagents: { ...runtime.subagents, anyModel: false } } });
  expect(h.core.workforce.resident.allowed(agent.id, other, true)).toBe(false);
});

test('every exchange that ends while a pass runs reaches the next pass', async () => {
  const driver = script(() => 'SUMMARY: no change');
  const { h, threadId, ask } = await setup();
  await waitFor(() => driver.held.length === 1);
  for (const fact of ['FACT_ALPHA', 'FACT_BRAVO', 'FACT_CHARLIE']) {
    const before = turnsOf(h, threadId).length;
    await ask(`Remember ${fact}.`);
    await waitFor(() => turnsOf(h, threadId).length === before + 1 && settled(h, threadId));
  }
  driver.release();
  await waitFor(() => passes(h, threadId).length === 2 && driver.held.length === 1);
  const second = driver.prompts.get(passes(h, threadId).find(t => !t.archived)!.id)![0]!;
  for (const fact of ['FACT_ALPHA', 'FACT_BRAVO', 'FACT_CHARLIE']) expect(second).toContain(fact);
  driver.release();
  await waitFor(() => !h.core.workforce.memory.busy());
  expect(passes(h, threadId)).toHaveLength(2);
});

test('a running memory pass never holds back the notification of the answer the user reads', async () => {
  const driver = script(() => 'SUMMARY: no change');
  const { h, threadId, ask } = await setup();
  await waitFor(() => driver.held.length === 1);
  const told: string[] = [];
  const push = h.core.push as unknown as { notify: (threadId: string) => void; reachable: () => boolean };
  push.reachable = () => true;
  push.notify = id => { told.push(id); };
  const before = turnsOf(h, threadId).length;
  await ask('When is the release?');
  await waitFor(() => turnsOf(h, threadId).length === before + 1 && settled(h, threadId));
  await Bun.sleep(50);
  expect(told).toEqual([threadId]);
  driver.release();
  await waitFor(() => driver.held.length === 1);
  driver.release();
  await waitFor(() => !h.core.workforce.memory.busy());
});

test('its status shows the last memory pass, running then how it ended, and each change tells the clients', async () => {
  const driver = script(() => 'SUMMARY: Noted the release date\n<memory>\n- the release is on Friday\n</memory>');
  const { h, agent, threadId } = await setup();
  await waitFor(() => driver.held.length === 1);
  const status = () => h.core.workforce.snapshot().status.find(s => s.agentId === agent.id)!;
  const pass = passes(h, threadId)[0]!.id;
  expect(status().memory).toMatchObject({ threadId: pass, status: 'running', summary: null });
  const store = h.core.workforce as unknown as { changed: () => void };
  const changed = store.changed.bind(store);
  let calls = 0;
  store.changed = () => { calls += 1; changed(); };
  driver.release();
  await waitFor(() => status().memory?.status === 'done');
  expect(status().memory).toMatchObject({ threadId: pass, summary: 'Noted the release date' });
  expect(calls).toBeGreaterThan(0);
  expect(h.core.journal.getSetting(`agents:memory-pass:${agent.id}`)).toEqual(status().memory);
});
