import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RpcErrorCode } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let root: string;
let restore: (() => void) | undefined;
const body = 'Work through one task at a time.';
function skill(name: string, marker = '', content = body, givenName = name) {
  const path = join(root, 'skills', name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), `---\nname: ${JSON.stringify(givenName)}\ndescription: ${name} description\n${marker}---\n${content}`);
}
beforeEach(async () => {
  h = await startTestCore();
  root = join(h.dataDir, 'brain');
  mkdirSync(root);
  root = realpathSync(root);
  skill('focus', 'disable-model-invocation: true\n');
  skill('review');
  await h.core.brain.configure({ path: root, enabled: true });
});
afterEach(async () => { restore?.(); restore = undefined; await h.stop(); });

test.each([
  ['/focus', body],
  ['/focus do this', `${body} do this`],
  ['/focus\nkeep these lines', `${body}\nkeep these lines`],
  ['/review', '/review'],
  ['/missing hello', '/missing hello'],
  ['/focus-extra', '/focus-extra'],
  ['before /focus', 'before /focus'],
  [' /focus', ' /focus'],
  ['/FOCUS', '/FOCUS'],
  ['Hello', 'Hello'],
])('manual skill expansion reaches the driver and transcript: %j', async (prompt, expected) => {
  let received = '';
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    received = ctx.prompt;
    return { done: Promise.resolve({ status: 'done', sessionId: null, usage: null }), stop() {} };
  } });
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const turn = await owner.call('turns.start', { threadId, prompt });
  await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
  expect(received.endsWith(expected)).toBe(true);
  expect(h.core.journal.lastUserMessage(threadId, turn.id)?.parts).toEqual([{ type: 'text', text: expected }]);
  if (!expected.trimStart().startsWith('/')) expect(received).toContain('review description');
  expect(received).not.toContain('focus description');
});

test('manual skills stay out of the model catalog while normal skills remain available', () => {
  const catalog = h.core.brain.instructions();
  expect(catalog).not.toContain('focus');
  expect(catalog).not.toContain(body);
  expect(catalog).toContain('review: review description');
  expect(catalog).toContain(join(root, 'skills/review/SKILL.md'));
  skill('allowed', 'disable-model-invocation: false\n');
  expect(h.core.brain.instructions()).toContain('allowed description');
});

test('a driver command with the same name wins over a manual skill', async () => {
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  h.core.threads.agentState.noteCommands(threadId, [{ name: 'focus', description: 'Native focus', hint: null }]);
  const turn = await owner.call('turns.start', { threadId, prompt: '/focus hello' });
  expect(h.core.journal.lastUserMessage(threadId, turn.id)?.parts).toEqual([{ type: 'text', text: '/focus hello' }]);
});

test('manual expansion preserves browser mention positions in the transcript', async () => {
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const reference = { id: 'save', url: 'https://example.test', selector: '#save', text: 'Save', bounds: { x: 0, y: 0, width: 80, height: 30 }, mention: { start: 7, end: 12 } };
  const turn = await owner.call('turns.start', { threadId, prompt: '/focus @Save', previewReferences: [reference] });
  const part = h.core.journal.lastUserMessage(threadId, turn.id)?.parts[0];
  expect(part?.type).toBe('text');
  if (part?.type !== 'text') throw new Error('expected a text part');
  expect(part.displayText).toBe(`${body} @Save`);
  expect(part.previewReferences?.[0]?.mention).toEqual({ start: body.length + 1, end: body.length + 6 });
  expect(part.text).toContain(body);
  expect(part.text).not.toContain('/focus');
});

test('manual commands expose only metadata to phones until the brain is disconnected', async () => {
  const owner = await h.connect();
  const expected = [{ name: 'focus', description: 'focus description', hint: null }];
  expect(await owner.call('brain.commands', {})).toEqual(expected);
  const { grant } = await owner.call('pairing.grant', {});
  const device = await connect(h.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    expect(await device.call('brain.commands', {})).toEqual(expected);
    expect(await device.call('brain.status', {}).catch(error => error)).toMatchObject({ rpc: { code: RpcErrorCode.Refused } });
    skill('focus', 'disable-model-invocation: true\n', 'Updated body');
    expect(h.core.brain.expandPrompt('/focus')).toBe('Updated body');
    await h.core.brain.configure({ path: root, enabled: false });
    expect(await device.call('brain.commands', {})).toEqual(expected);
    expect(h.core.brain.expandPrompt('/focus')).toBe('Updated body');
    expect(h.core.brain.instructions()).toBe('');
    await h.core.brain.configure({ path: null, enabled: false });
    expect(await device.call('brain.commands', {})).toEqual([]);
    expect(h.core.brain.expandPrompt('/focus')).toBe('/focus');
  } finally { device.close(); }
});

test('manual skills reach the driver without injecting shared instructions when sharing is off', async () => {
  writeFileSync(join(root, 'AGENTS.md'), 'Shared rules sentinel');
  await h.core.brain.configure({ path: root, enabled: false });
  const received: string[] = [];
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    received.push(ctx.prompt);
    return { done: Promise.resolve({ status: 'done', sessionId: null, usage: null }), stop() {} };
  } });
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  for (const [prompt, expected] of [['Hello', 'Hello'], ['/focus next', `${body} next`]] as const) {
    const turn = await owner.call('turns.start', { threadId, prompt });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    expect(received.at(-1)?.endsWith(expected)).toBe(true);
    expect(h.core.journal.lastUserMessage(threadId, turn.id)?.parts).toEqual([{ type: 'text', text: expected }]);
  }
  for (const prompt of received) {
    expect(prompt).not.toContain('Shared agent brain:');
    expect(prompt).not.toContain('Shared rules sentinel');
    expect(prompt).not.toContain('review description');
  }
});

test('a malformed manual marker is reported and cannot invoke the skill', async () => {
  skill('invalid', 'disable-model-invocation: "true"\n');
  expect((await h.core.brain.status()).entries.find(entry => entry.name === 'invalid')?.error).toContain('must be a boolean');
  expect(h.core.brain.commands().map(command => command.name)).toEqual(['focus']);
  expect(h.core.brain.expandPrompt('/invalid')).toBe('/invalid');
});

test('manual names are normalized before listing and expansion, and invalid tokens are diagnosed', async () => {
  skill('padded', 'disable-model-invocation: true\n', body, ' /custom ');
  skill('slashes', 'disable-model-invocation: true\n', body, '//custom2');
  skill('words', 'disable-model-invocation: true\n', body, 'my skill');
  skill('slash', 'disable-model-invocation: true\n', body, '/');
  expect(h.core.brain.commands().map(command => command.name).sort()).toEqual(['custom', 'custom2', 'focus']);
  expect(h.core.brain.expandPrompt('/custom hello')).toBe(`${body} hello`);
  expect(h.core.brain.expandPrompt('/custom2 hello')).toBe(`${body} hello`);
  expect(h.core.brain.expandPrompt('/my skill')).toBe('/my skill');
  const status = await h.core.brain.status();
  expect(status.entries.find(entry => entry.path === 'skills/padded/SKILL.md')?.name).toBe('custom');
  expect(status.entries.find(entry => entry.path === 'skills/slashes/SKILL.md')?.name).toBe('custom2');
  for (const folder of ['words', 'slash']) {
    expect(status.entries.find(entry => entry.path === `skills/${folder}/SKILL.md`)?.error).toContain('command token');
  }
});

test('an empty manual body keeps the original command and following text', () => {
  skill('empty', 'disable-model-invocation: true\n', '');
  expect(h.core.brain.expandPrompt('/empty')).toBe('/empty');
  expect(h.core.brain.expandPrompt('/empty hello')).toBe('/empty hello');
});

test('an accepted command retry keeps the original expansion after the skill changes', async () => {
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const params = { threadId, prompt: '/focus', clientRequestId: 'manual-command-retry' };
  const turn = await owner.call('turns.start', params);
  skill('focus', 'disable-model-invocation: true\n', 'Changed after acceptance');
  expect((await owner.call('turns.start', params)).id).toBe(turn.id);
  expect(h.core.journal.lastUserMessage(threadId, turn.id)?.parts).toEqual([{ type: 'text', text: body }]);
});

test('a brain folder that disappears leaves the menu empty and the prompt untouched', () => {
  rmSync(root, { recursive: true, force: true });
  expect(h.core.brain.commands()).toEqual([]);
  expect(h.core.brain.expandPrompt('/focus hello')).toBe('/focus hello');
});

test('live user steering expands manual skills before delivery and persistence', async () => {
  let received = '';
  const trackerPrompts: string[] = [];
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    if (h.core.activity.ownsTracker(ctx.thread.id)) {
      trackerPrompts.push(ctx.prompt);
      const id = ctx.emit.startMessage('assistant');
      const result = trackerPrompts.length === 1
        ? { items: [{ text: 'Initial task', source: 'Initial task' }] }
        : { add: [{ text: 'Follow-up task', source: 'next' }] };
      ctx.emit.part(id, 0, { type: 'text', text: JSON.stringify(result) });
      ctx.emit.complete(id, 'complete');
      return { done: Promise.resolve({ status: 'done', sessionId: null, usage: null }), stop() {} };
    }
    let finish!: (result: import('../src/drivers/types.ts').TurnResult) => void;
    return { done: new Promise(resolve => { finish = resolve; }),
      stop() { finish({ status: 'stopped', sessionId: null, usage: null }); },
      async steerUser(prompt) { received = prompt; return true; } };
  } });
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const turn = await owner.call('turns.start', { threadId, prompt: 'Start work' });
  await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'running');
  h.core.activity.set({ threadId, goal: { objective: 'Initial task', review: true } });
  await waitFor(() => h.core.activity.get(threadId).goal?.checklist?.items.length === 1);
  expect(await owner.call('turns.steer', { threadId, turnId: turn.id, prompt: '/focus next', clientRequestId: 'manual-live-steer' })).toEqual({ accepted: true });
  expect(received).toBe(`${body} next`);
  expect(h.core.journal.lastUserMessage(threadId, turn.id)?.parts).toEqual([{ type: 'text', text: `${body} next` }]);
  await waitFor(() => h.core.activity.get(threadId).goal?.checklist?.items.length === 2);
  expect(trackerPrompts[1]).toContain(JSON.stringify(`${body} next`));
  expect(trackerPrompts[1]).not.toContain('/focus next');
});
