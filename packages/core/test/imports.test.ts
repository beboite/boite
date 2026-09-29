import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Account, MessagePart } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { LISTING_TAIL_BYTES, claudeProjectFolder, listTranscript } from '../src/imports/claude.ts';
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

/** Assistant records of accented text, so a byte offset can fall inside a character. */
function padding(bytes: number): string {
  const record = JSON.stringify({ type: 'assistant', uuid: 'pad', message: { role: 'assistant', content: [{ type: 'text', text: 'été "summary" '.repeat(40) }] } });
  return `${record}\n`.repeat(Math.ceil(bytes / Buffer.byteLength(`${record}\n`)));
}

function title(text: string): string {
  return `${JSON.stringify({ type: 'ai-title', aiTitle: text, sessionId: FIXTURE_SESSION_ID })}\n`;
}

test('a long transcript is listed from its head and its tail, and gives the last title a full read gives', async () => {
  const client = await harness.connect();
  const project = await testProject(harness, client);
  const head = claudeSessionFixture(project.path, { aiTitle: 'Early title' });
  const dir = join(harness.dataDir, 'transcripts');
  mkdirSync(dir, { recursive: true });

  // The last title sits in the tail, past a megabyte the listing never reads.
  const late = join(dir, 'late.jsonl');
  writeFileSync(late, `${head}${padding(1024 * 1024)}${title('Late title')}${padding(4096)}`);
  expect(await listTranscript(late)).toEqual({
    prompt: 'List the files of this folder, then say hello',
    promptAt: Date.parse('2026-09-10T08:00:01.000Z'),
    cwd: project.path,
    agentTitle: 'Late title',
  });

  // Every offset around the window's first byte: a cut line or character never parses.
  for (let shift = 0; shift < 4; shift += 1) {
    const cut = join(dir, `cut-${shift}.jsonl`);
    const tail = `${title('Right at the edge')}${'x'.repeat(shift)}\n`;
    const body = `${head}${padding(LISTING_TAIL_BYTES)}${tail}${padding(LISTING_TAIL_BYTES - Buffer.byteLength(tail) - 8)}`;
    writeFileSync(cut, body);
    expect((await listTranscript(cut))?.agentTitle).toBe('Right at the edge');
  }

  // An old transcript with one summary near its head: the empty tail falls back to a full read.
  const summary = join(dir, 'summary.jsonl');
  writeFileSync(summary, `${JSON.stringify({ type: 'summary', summary: 'Old summary', leafUuid: 'x' })}\n${claudeSessionFixture(project.path)}${padding(LISTING_TAIL_BYTES * 2)}`);
  expect((await listTranscript(summary))?.agentTitle).toBe('Old summary');

  // A short file the head read to its end, one with no title at all, one with no prompt.
  const short = join(dir, 'short.jsonl');
  writeFileSync(short, claudeSessionFixture(project.path, { aiTitle: 'Short title' }));
  expect((await listTranscript(short))?.agentTitle).toBe('Short title');
  const none = join(dir, 'none.jsonl');
  writeFileSync(none, `${claudeSessionFixture(project.path)}${padding(LISTING_TAIL_BYTES * 2)}`);
  expect((await listTranscript(none))?.agentTitle).toBeNull();
  const empty = join(dir, 'empty.jsonl');
  writeFileSync(empty, `${JSON.stringify({ type: 'queue-operation' })}\n`);
  expect(await listTranscript(empty)).toBeNull();
});

test('an unchanged transcript is listed from memory, a changed one read again, and one listing is shared', async () => {
  const client = await harness.connect();
  const { projectId, file } = await seeded(client, { aiTitle: 'First title' });
  // A whole second, which the file system keeps exactly.
  const mtime = new Date('2026-09-20T10:00:00.000Z');
  utimesSync(file, mtime, mtime);
  expect((await client.call('imports.list', { projectId }))[0]!.title).toBe('First title');

  // Same size, same modification time: the listing does not open the file again.
  writeFileSync(file, readFileSync(file, 'utf8').replace('First title', 'Other title'));
  utimesSync(file, mtime, mtime);
  expect((await client.call('imports.list', { projectId }))[0]!.title).toBe('First title');

  utimesSync(file, mtime, new Date(mtime.getTime() + 5000));
  expect((await client.call('imports.list', { projectId }))[0]!.title).toBe('Other title');

  const first = harness.core.imports.list(projectId);
  expect(harness.core.imports.list(projectId)).toBe(first);
  await first;
  expect(harness.core.imports.list(projectId)).not.toBe(first);
});
