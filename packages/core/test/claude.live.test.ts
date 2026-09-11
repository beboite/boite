import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, RpcEvents } from '@boite/contracts';
import { removeDir, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

const TURN_TIMEOUT_MS = 120_000;

/** The one test allowed to touch the user's own login, and it only reads it. */
const live = process.env['BOITE_E2E_CLAUDE'] === '1' ? describe : describe.skip;

function assistantText(messages: Message[]): string {
  const assistants = messages.filter((message) => message.role === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last === undefined) return '';
  return last.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

live('claude driver, live', () => {
  let harness: TestCore;
  let projectDir: string;

  beforeEach(async () => {
    harness = await startTestCore();
    projectDir = mkdtempSync(join(tmpdir(), 'boite-live-'));
  });

  afterEach(async () => {
    await harness.stop();
    await removeDir(projectDir);
  });

  test(
    'a real turn answers, traces its process, and the next turn resumes it',
    async () => {
      const client = await harness.connect();
      const project = await client.call('projects.add', { path: projectDir, name: 'live' });
      const accounts = await client.call('accounts.list', {});
      const account = accounts.find((entry) => entry.providerId === 'claude' && entry.label === 'Default');
      if (account === undefined) throw new Error('no default claude account on this machine');
      expect(account.isolationDir).toBeNull();
      expect(account.status).toBe('ok');

      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'claude',
        accountId: account.id,
        cwd: projectDir,
        permissionMode: 'default',
        title: 'live claude',
      });
      const threadId = thread.id;
      await client.call('threads.subscribe', { threadId });

      const started: RpcEvents['process.started'][] = [];
      client.on('process.started', (record) => {
        if (record.threadId === threadId) started.push(record);
      });
      const exited = client.next('process.exited', (record) => record.threadId === threadId, TURN_TIMEOUT_MS);
      const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, TURN_TIMEOUT_MS);
      // The first finished turn sends one short call to the small model for the title.
      const titled = client.next(
        'thread.updated',
        (summary) => summary.id === threadId && summary.titleSource === 'agent',
        TURN_TIMEOUT_MS,
      );

      await client.call('turns.start', { threadId, prompt: 'Reply with exactly the word: pong' });
      const done = await finished;
      expect(done.error).toBeNull();
      expect(done.status).toBe('done');
      expect(done.usage?.outputTokens).toBeGreaterThan(0);
      expect(started.length).toBeGreaterThan(0);
      expect((await exited).threadId).toBe(threadId);

      const withTitle = await titled;
      expect(withTitle.title.length).toBeGreaterThan(0);
      expect(withTitle.title).not.toBe('live claude');
      console.log(`claude wrote the title: ${JSON.stringify(withTitle.title)}`);

      const first = await client.call('threads.get', { threadId });
      expect(first.sessionId).not.toBeNull();
      expect(assistantText(first.messages).toLowerCase()).toContain('pong');

      const resumed = client.next('turn.finished', (turn) => turn.threadId === threadId, TURN_TIMEOUT_MS);
      await client.call('turns.start', { threadId, prompt: 'Repeat the word you just said, nothing else.' });
      expect((await resumed).status).toBe('done');

      const second = await client.call('threads.get', { threadId });
      expect(second.sessionId).not.toBeNull();
      expect(assistantText(second.messages).toLowerCase()).toContain('pong');
    },
    TURN_TIMEOUT_MS,
  );

  test(
    'a session the CLI kept is listed for the folder, imported into a new thread, and resumed there',
    async () => {
      const client = await harness.connect();
      const project = await client.call('projects.add', { path: projectDir, name: 'live import' });
      const accounts = await client.call('accounts.list', {});
      const account = accounts.find((entry) => entry.providerId === 'claude' && entry.label === 'Default');
      if (account === undefined) throw new Error('no default claude account on this machine');

      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'claude',
        accountId: account.id,
        cwd: projectDir,
        permissionMode: 'default',
        title: 'live import',
      });
      await client.call('threads.update', { threadId: thread.id, title: 'live import' });
      const finished = client.next('turn.finished', (turn) => turn.threadId === thread.id, TURN_TIMEOUT_MS);
      await client.call('turns.start', { threadId: thread.id, prompt: 'Reply with exactly the word: pong' });
      expect((await finished).status).toBe('done');
      const sessionId = (await client.call('threads.get', { threadId: thread.id })).sessionId;
      if (sessionId === null) throw new Error('the turn left no session id');

      // The session is the thread's until the thread goes: removing the project takes it.
      const before = await client.call('imports.list', { projectId: project.id });
      expect(before.find((session) => session.sessionId === sessionId)?.threadId).toBe(thread.id);
      await client.call('projects.remove', { projectId: project.id });
      const again = await client.call('projects.add', { path: projectDir, name: 'live import again' });
      const listed = await client.call('imports.list', { projectId: again.id });
      const mine = listed.find((session) => session.sessionId === sessionId);
      expect(mine).toMatchObject({ accountId: account.id, threadId: null });
      console.log(`the CLI filed the session as: ${JSON.stringify(mine?.title)} in ${mine?.file}`);

      const imported = await client.call('imports.run', { projectId: again.id, accountId: account.id, sessionId });
      expect(imported.sessionId).toBe(sessionId);
      const history = await client.call('threads.get', { threadId: imported.id });
      expect(history.turns).toHaveLength(1);
      expect(assistantText(history.messages).toLowerCase()).toContain('pong');

      // The resumed turn runs on the CLI's own session: it remembers the word.
      await client.call('threads.subscribe', { threadId: imported.id });
      const resumed = client.next('turn.finished', (turn) => turn.threadId === imported.id, TURN_TIMEOUT_MS);
      await client.call('turns.start', { threadId: imported.id, prompt: 'Repeat the word you said before, nothing else.' });
      expect((await resumed).status).toBe('done');
      const full = await client.call('threads.get', { threadId: imported.id });
      expect(assistantText(full.messages).toLowerCase()).toContain('pong');
    },
    TURN_TIMEOUT_MS * 2,
  );

  test(
    'a warm thread answers two turns on one CLI process',
    async () => {
      const client = await harness.connect();
      await client.call('settings.set', { warmProcessMinutes: 2 });
      const project = await client.call('projects.add', { path: projectDir, name: 'live warm' });
      const accounts = await client.call('accounts.list', {});
      const account = accounts.find((entry) => entry.providerId === 'claude' && entry.label === 'Default');
      if (account === undefined) throw new Error('no default claude account on this machine');

      const thread = await client.call('threads.create', {
        projectId: project.id,
        providerId: 'claude',
        accountId: account.id,
        cwd: projectDir,
        permissionMode: 'default',
        title: 'live warm claude',
      });
      const threadId = thread.id;
      // A title the user typed: no title call after the first turn, so the only
      // CLI this thread ever starts is the one the warm window keeps.
      await client.call('threads.update', { threadId, title: 'live warm claude' });
      await client.call('threads.subscribe', { threadId });

      const started: RpcEvents['process.started'][] = [];
      const exited: RpcEvents['process.exited'][] = [];
      client.on('process.started', (record) => {
        if (record.threadId === threadId) started.push(record);
      });
      client.on('process.exited', (record) => {
        if (record.threadId === threadId) exited.push(record);
      });

      const first = client.next('turn.finished', (turn) => turn.threadId === threadId, TURN_TIMEOUT_MS);
      await client.call('turns.start', { threadId, prompt: 'Reply with exactly the word: ping' });
      expect((await first).status).toBe('done');
      // The first process of the thread is the CLI the core spawned; the rest are its own helpers,
      // dozens of them, short-lived, so only the CLI itself is what the warm window keeps.
      const cli = started[0];
      if (cli === undefined) throw new Error('no process started for the thread');
      const isCli = (record: RpcEvents['process.started']): boolean =>
        record.exe === cli.exe && record.parentPid === cli.parentPid;
      expect(started.filter(isCli).length).toBe(1);
      expect(exited.some((record) => record.pid === cli.pid)).toBe(false);

      const second = client.next('turn.finished', (turn) => turn.threadId === threadId, TURN_TIMEOUT_MS);
      await client.call('turns.start', { threadId, prompt: 'Repeat the word you just said, nothing else.' });
      expect((await second).status).toBe('done');
      // Same CLI: the core spawned no second one, and the first never exited.
      expect(started.filter(isCli).length).toBe(1);
      expect(exited.some((record) => record.pid === cli.pid)).toBe(false);

      const full = await client.call('threads.get', { threadId });
      expect(full.sessionId).not.toBeNull();
      expect(assistantText(full.messages).toLowerCase()).toContain('ping');
    },
    TURN_TIMEOUT_MS * 2,
  );
});
