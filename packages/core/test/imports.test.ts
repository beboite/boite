import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Account, MessagePart } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { claudeProjectFolder } from '../src/imports/claude.ts';
import { claudeSessionFixture, FIXTURE_SESSION_ID } from './fixtures/claude-session.ts';
import { startTestCore, testProject } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

/** An isolated claude account and a transcript filed where the CLI would file it. */
async function seeded(
  client: CoreClient,
  options: { aiTitle?: string; sessionId?: string; body?: string } = {},
): Promise<{ projectId: string; account: Account; file: string }> {
  const project = await testProject(harness, client);
  const account = await client.call('accounts.add', { providerId: 'claude', label: 'imports' });
  if (account.isolationDir === null) throw new Error('the account must be isolated');
  const folder = join(account.isolationDir, 'projects', claudeProjectFolder(project.path));
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${options.sessionId ?? FIXTURE_SESSION_ID}.jsonl`);
  writeFileSync(file, options.body ?? claudeSessionFixture(project.path, options));
  return { projectId: project.id, account, file };
}

test('the folder name is the working directory with every other character turned into a dash', () => {
  expect(claudeProjectFolder('C:\\src\\boite')).toBe('C--src-boite');
  expect(claudeProjectFolder('/home/me/my app')).toBe('-home-me-my-app');
});

test('a transcript is listed from its head, imported whole, and never twice', async () => {
  const client = await harness.connect();
  const { projectId, account, file } = await seeded(client);

  const listed = await client.call('imports.list', { projectId });
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    providerId: 'claude',
    accountId: account.id,
    sessionId: FIXTURE_SESSION_ID,
    file,
    title: 'List the files of this folder, then say hello',
    startedAt: Date.parse('2026-09-10T08:00:01.000Z'),
    threadId: null,
  });
  expect(listed[0]!.bytes).toBeGreaterThan(0);

  const created = client.next('thread.created', (summary) => summary.projectId === projectId);
  const summary = await client.call('imports.run', { projectId, accountId: account.id, sessionId: FIXTURE_SESSION_ID });
  expect((await created).id).toBe(summary.id);
  expect(summary).toMatchObject({
    title: 'List the files of this folder, then say hello',
    titleSource: 'prompt',
    sessionId: FIXTURE_SESSION_ID,
    model: 'claude-sonnet-5',
    status: 'idle',
    createdAt: Date.parse('2026-09-10T08:00:01.000Z'),
    updatedAt: Date.parse('2026-09-10T08:01:02.000Z'),
  });

  const thread = await client.call('threads.get', { threadId: summary.id });
  expect(thread.turns).toHaveLength(2);
  expect(thread.turns.every((turn) => turn.status === 'done')).toBe(true);
  expect(thread.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  const answer = thread.messages[1]!;
  expect(answer.turnId).toBe(thread.turns[0]!.id);
  expect(answer.parts.map((part) => part.type)).toEqual(['thinking', 'tool', 'text']);
  const tool = answer.parts[1] as Extract<MessagePart, { type: 'tool' }>;
  expect(tool).toMatchObject({ toolId: 'toolu_1', name: 'Bash', input: { command: 'ls' }, output: 'README.md\npackage.json', status: 'done' });
  // The two text records of one message are one part; the sidechain never shows.
  expect(answer.parts[2]).toEqual({ type: 'text', text: 'Two files. Hello.' });
  expect(JSON.stringify(thread.messages)).not.toContain('Explored');
  expect(thread.messages[3]!.parts).toEqual([{ type: 'text', text: 'Bye.' }]);

  const again = await client.call('imports.list', { projectId });
  expect(again[0]!.threadId).toBe(summary.id);
  await expect(client.call('imports.run', { projectId, accountId: account.id, sessionId: FIXTURE_SESSION_ID })).rejects.toThrow(
    'already a thread',
  );
});

test('two runs fired at once import the session once, the second refused by name', async () => {
  const client = await harness.connect();
  const { projectId, account } = await seeded(client);

  // A double click: the server dispatches the second frame without waiting for
  // the first, and both used to pass the "already a thread" check while the
  // transcript was still being read, which made two threads of one session.
  const params = { projectId, accountId: account.id, sessionId: FIXTURE_SESSION_ID };
  const results = await Promise.allSettled([client.call('imports.run', params), client.call('imports.run', params)]);
  const done = results.filter((result) => result.status === 'fulfilled');
  const refused = results.filter((result) => result.status === 'rejected');
  expect(done).toHaveLength(1);
  expect(refused).toHaveLength(1);
  // Whichever way the two frames interleave, the second is told why by name.
  expect(['this session is already being imported', 'this session is already a thread']).toContain(
    (refused[0] as PromiseRejectedResult).reason.message,
  );
  expect(await client.call('threads.list', { projectId })).toHaveLength(1);
});

test('the agent title wins over the prompt, and is marked as the agent\'s', async () => {
  const client = await harness.connect();
  const { projectId, account } = await seeded(client, { aiTitle: 'Folder listing' });
  const listed = await client.call('imports.list', { projectId });
  expect(listed[0]!.title).toBe('Folder listing');
  const summary = await client.call('imports.run', { projectId, accountId: account.id, sessionId: FIXTURE_SESSION_ID });
  expect(summary).toMatchObject({ title: 'Folder listing', titleSource: 'agent' });
});

test('refused by name: another provider, a bad id, a missing file, a transcript with no prompt', async () => {
  const client = await harness.connect();
  const { projectId, account } = await seeded(client);
  const accounts = await client.call('accounts.list', {});
  const echo = accounts.find((entry) => entry.providerId === 'echo');
  if (echo === undefined) throw new Error('no echo account');

  await expect(client.call('imports.run', { projectId, accountId: echo.id, sessionId: FIXTURE_SESSION_ID })).rejects.toThrow(
    'only a Claude account',
  );
  await expect(client.call('imports.run', { projectId, accountId: account.id, sessionId: '../escape' })).rejects.toThrow(
    'letters, digits, dashes and underscores',
  );
  await expect(client.call('imports.run', { projectId, accountId: account.id, sessionId: 'nope' })).rejects.toThrow(
    'no transcript at',
  );

  const { projectId: emptyProject } = await seeded(client, {
    sessionId: 'empty',
    body: `${JSON.stringify({ type: 'queue-operation' })}\n${JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'sub' } })}\n`,
  });
  const listed = await client.call('imports.list', { projectId: emptyProject });
  expect(listed.map((session) => session.sessionId)).toEqual([FIXTURE_SESSION_ID]);
});
