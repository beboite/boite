import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile } from '@boite/contracts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { parseMemoryAnswer } from '../src/agents/memory.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

const PASS = 'You keep the long-term memory of';
const IMAGE = { type: 'artifact' as const, id: '0b5d2c1e-9a7f-4c3b-8e21-5f6a7b8c9d0e', mimeType: 'image/png', bytes: 2048, name: 'capture.png' };

/**
 * An agent that answers in words and attaches a picture, and a memory pass
 * that answers `pass(prompt)`. A pass stays running until `release` is called.
 */
function script(pass: (prompt: string) => string) {
  const prompts: string[] = [];
  const held: (() => void)[] = [];
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    prompts.push(ctx.prompt);
    const memory = ctx.prompt.includes(PASS);
    const id = ctx.emit.startMessage('assistant');
    ctx.emit.part(id, 0, { type: 'text', text: memory ? pass(ctx.prompt) : 'The release is on Friday; here is the board.' });
    if (!memory) ctx.emit.part(id, 1, IMAGE);
    ctx.emit.complete(id, 'complete');
    const result: TurnResult = { status: 'done', sessionId: `session:${ctx.thread.id}`, usage: null };
    return { done: memory ? new Promise<TurnResult>(resolve => held.push(() => resolve(result))) : Promise.resolve(result), stop() {} };
  } }));
  return { prompts, release: () => { for (const done of held.splice(0)) done(); }, held };
}

async function setup(name = 'Ada') {
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const agent = await client.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', status: 'active', tools: ['messages'], selection: { providerId: 'echo', accountId: account.id, model: 'echo', effort: null, permissionMode: 'default' } } });
  const ask = (text: string, requestId: string) => client.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, recipientIds: [agent.id], text, requestId });
  const work = () => h.core.workforce.records.list('work').filter(w => w.agentId === agent.id);
  return { h, client, agent, ask, work, accountId: account.id };
}

test('a pass answer names its summary and file; repeating the instructions or no change writes nothing', () => {
  expect(parseMemoryAnswer('SUMMARY: Noted Friday\n<memory>\n# Memory\n- release Friday\n</memory>')).toEqual({ summary: 'Noted Friday', memory: '# Memory\n- release Friday\n' });
  expect(parseMemoryAnswer('SUMMARY: no change')).toEqual({ summary: null, memory: null });
  // An answer that quotes the instructions first ends on its own summary.
  expect(parseMemoryAnswer('SUMMARY: <one short line>\n<memory>\n<the whole new MEMORY.md>\n</memory>\nanswer only this line:\nSUMMARY: no change')).toEqual({ summary: null, memory: null });
  expect(parseMemoryAnswer('SUMMARY: <one short line>\n<memory>\n<the whole new MEMORY.md>\n</memory>')).toEqual({ summary: null, memory: null });
  expect(parseMemoryAnswer('I updated it.')).toEqual({ summary: null, memory: null });
});

test('after a task a memory pass rewrites MEMORY.md, the next task waits for it, and its answer never reaches the agent as mail', async () => {
  const pass = script(() => 'SUMMARY: Noted the release date\n<memory>\n# Memory\n- 2026-10-13: the release is on Friday\n</memory>');
  const { h, agent, ask, work } = await setup();
  await ask('When is the release?', 'release-question-1');
  await waitFor(() => pass.held.length > 0);
  const passPrompt = pass.prompts.find(p => p.includes(PASS))!;
  expect(passPrompt).toContain('When is the release?');
  expect(passPrompt).toContain('The release is on Friday; here is the board.');

  // The next task waits while the pass writes, so it starts from the new memory.
  await ask('Remind me tomorrow', 'release-question-2');
  await Bun.sleep(1500);
  expect(work().find(w => w.status === 'pending')).toBeDefined();
  pass.release();
  await waitFor(() => work().filter(w => w.status === 'done').length === 2);
  const [first, second] = work();
  expect(first!.memory).toMatchObject({ status: 'done', summary: 'Noted the release date' });
  expect(h.core.workforce.resident.brain(agent.id).memory).toBe('# Memory\n- 2026-10-13: the release is on Friday\n');
  const run = h.core.workforce.records.get('run', second!.runId!);
  expect(run.context.instructions).toContain('the release is on Friday');
  // Two tasks, two answers: the pass's own answer queued no work and posted nothing.
  expect(work()).toHaveLength(2);
  expect(h.core.workforce.records.list('message').filter(m => m.senderId === agent.id)).toHaveLength(2);
  const keeper = h.core.journal.getThread(first!.memory!.threadId)!;
  expect(keeper.archived).toBe(true);
  pass.release();
});

test('the reply carries the files the agent attached', async () => {
  script(() => 'SUMMARY: no change');
  const { h, agent, ask } = await setup();
  await ask('Show me the board', 'board-question-1');
  await waitFor(() => h.core.workforce.records.list('message').some(m => m.senderId === agent.id));
  const reply = h.core.workforce.records.list('message').find(m => m.senderId === agent.id)!;
  expect(reply.files).toHaveLength(1);
  expect(reply.files![0]).toMatchObject({ part: IMAGE });
  expect(h.core.journal.getMessage(reply.files![0]!.messageId)?.threadId).toBe(reply.files![0]!.threadId);
});

test('a pass that would drop most of the memory, or that the owner turned off, changes nothing', async () => {
  const pass = script(() => 'SUMMARY: Trimmed\n<memory>\n- one line\n</memory>');
  const { h, client, agent, ask, work } = await setup();
  const brain = h.core.workforce.resident.brain(agent.id);
  const long = Array.from({ length: 80 }, (_, i) => `- 2026-10-${String(1 + i % 28).padStart(2, '0')}: fact number ${i} worth keeping`).join('\n');
  h.core.workforce.resident.saveBrain({ agentId: agent.id, expectedRevision: brain.revision, instructions: brain.instructions, memory: long });
  await ask('Anything new?', 'shrink-question-1');
  await waitFor(() => pass.held.length > 0);
  pass.release();
  await waitFor(() => work()[0]?.memory?.status === 'error');
  expect(work()[0]!.memory!.summary).toContain('dropped most of the memory');
  expect(h.core.workforce.resident.brain(agent.id).memory).toBe(long);

  const runtime = await client.call('agents.runtime.get', { agentId: agent.id });
  expect(runtime.autoMemory).toBe(true);
  const profile = h.core.workforce.records.get('profile', agent.id);
  await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: profile.revision, config: { ...runtime, autoMemory: false } });
  await ask('And now?', 'shrink-question-2');
  await waitFor(() => work().filter(w => w.status === 'done').length === 2);
  await Bun.sleep(300);
  expect(work()[1]!.memory).toBeUndefined();
});

test('brains move to the folder the owner chooses, named after their agents, and back', async () => {
  script(() => 'SUMMARY: no change');
  const { h, client, agent } = await setup('Open Source');
  const twin = await client.call('agents.profile.save', { value: { ...agent, name: 'Open source' } as AgentProfile });
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
  await expect(client.call('agents.brain.root', { path: 'relative/brains' })).rejects.toThrow('absolute');
  await expect(client.call('agents.brain.root', { path: join(h.dataDir, 'inside') })).rejects.toThrow("core's own data");

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
  await expect(client.call('agents.brain.root', { path: busy })).resolves.toEqual({ path: busy, custom: true });
  expect(h.core.workforce.resident.brain(agent.id).path).toBe(join(busy, 'open-source-2'));

  expect(await client.call('agents.brain.root', { path: null })).toEqual({ path: join(h.dataDir, 'agent-workspaces'), custom: false });
  expect(h.core.workforce.resident.brain(agent.id).memory).toBe('Keep the prototype private.');
  expect(h.core.workforce.resident.brain(agent.id).path).toBe(before.path);
});

test('subagents are on by default on any granted model; listed profiles restrict them', async () => {
  script(() => 'SUMMARY: no change');
  const { h, client, agent, accountId } = await setup();
  const other = { ...agent.selection, model: 'echo-other' };
  expect(h.core.workforce.resident.config(agent.id).subagents).toMatchObject({ enabled: true, anyModel: true, profiles: [] });
  expect(h.core.workforce.resident.allowed(agent.id, other, true)).toBe(true);
  const runtime = await client.call('agents.runtime.get', { agentId: agent.id });
  const listed = await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision, config: { ...runtime, subagents: { ...runtime.subagents, profiles: [{ id: 'small', name: 'Small', providerId: 'echo', accountId, model: 'echo', effort: null }] } } });
  expect(h.core.workforce.resident.allowed(agent.id, other, true)).toBe(false);
  expect(h.core.workforce.resident.allowed(agent.id, { ...agent.selection, model: 'echo' }, true)).toBe(true);
  await client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: listed.revision, config: { ...runtime, subagents: { ...runtime.subagents, anyModel: false } } });
  expect(h.core.workforce.resident.allowed(agent.id, other, true)).toBe(false);
});
