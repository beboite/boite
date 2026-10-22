import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RpcErrorCode } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let root: string;
let restore: (() => void) | undefined;
const body = 'Work through one task at a time.';
function skill(name: string, marker = '', content = body) {
  const path = join(root, 'skills', name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n${marker}---\n${content}`);
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

test('manual commands expose only metadata to phones and stop when the brain is disabled', async () => {
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
    expect(await device.call('brain.commands', {})).toEqual([]);
    expect(h.core.brain.expandPrompt('/focus')).toBe('/focus');
  } finally { device.close(); }
});

test('a malformed manual marker is reported and cannot invoke the skill', async () => {
  skill('invalid', 'disable-model-invocation: "true"\n');
  expect((await h.core.brain.status()).entries.find(entry => entry.name === 'invalid')?.error).toContain('must be a boolean');
  expect(h.core.brain.commands().map(command => command.name)).toEqual(['focus']);
  expect(h.core.brain.expandPrompt('/invalid')).toBe('/invalid');
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

test('live user steering expands manual skills before delivery and persistence', async () => {
  let received = '';
  restore = setDriver('echo', { protocol: 'echo', startTurn() {
    let finish!: (result: import('../src/drivers/types.ts').TurnResult) => void;
    return { done: new Promise(resolve => { finish = resolve; }),
      stop() { finish({ status: 'stopped', sessionId: null, usage: null }); },
      async steerUser(prompt) { received = prompt; return true; } };
  } });
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const turn = await owner.call('turns.start', { threadId, prompt: 'Start work' });
  await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'running');
  expect(await owner.call('turns.steer', { threadId, turnId: turn.id, prompt: '/focus next', clientRequestId: 'manual-live-steer' })).toEqual({ accepted: true });
  expect(received).toBe(`${body} next`);
  expect(h.core.journal.lastUserMessage(threadId, turn.id)?.parts).toEqual([{ type: 'text', text: `${body} next` }]);
});
