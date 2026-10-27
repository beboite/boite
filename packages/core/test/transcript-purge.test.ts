import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { CoreClient } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { newToken } from '../src/ids.ts';
import { claudeProjectFolder } from '../src/imports/claude.ts';
import { claudeSessionFixture, FIXTURE_SESSION_ID } from './fixtures/claude-session.ts';
import { removeTranscripts } from '../src/threads/transcript-purge.ts';
import { echoThread, startTestCore, testProject } from './harness.ts';
import type { TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore;
let client: CoreClient;

beforeEach(async () => {
  harness = await startTestCore();
  client = await harness.connect();
});

afterEach(async () => {
  await client.close();
  await harness.stop();
});

const EARLIER = '7c1d2e3f-2222-4aaa-8bbb-0123456789ab';
const SHARED = '9e8d7c6b-3333-4ccc-8ddd-0123456789ab';
const STRANGER = 'a1b2c3d4-4444-4eee-8fff-0123456789ab';

/** A session's transcript and its sidechain folder, as Claude Code files them. */
function transcript(folder: string, sessionId: string, cwd: string): { file: string; side: string } {
  mkdirSync(join(folder, sessionId, 'subagents'), { recursive: true });
  const file = join(folder, `${sessionId}.jsonl`);
  writeFileSync(file, claudeSessionFixture(cwd, { sessionId }));
  writeFileSync(join(folder, sessionId, 'subagents', 'agent-1.jsonl'), '{}\n');
  return { file, side: join(folder, sessionId) };
}

/** Imports the fixture session into a thread of the account. */
async function importSession(accountId: string, projectId: string): Promise<string> {
  const summary = await client.call('imports.run', { projectId, accountId, sessionId: FIXTURE_SESSION_ID });
  expect(summary.sessionId).toBe(FIXTURE_SESSION_ID);
  return summary.id;
}

/** Deletes the thread, ages the deletion past retention and runs one purge pass. */
async function purge(threadId: string): Promise<string[]> {
  await client.call('settings.set', { threadDeletionRetentionDays: 1 });
  await client.call('threads.remove', { threadId });
  harness.core.journal.db.query('UPDATE thread_deletions SET deleted_at = ? WHERE root_id = ?').run(Date.now() - 2 * 86_400_000, threadId);
  harness.core.threads.purgeDeleted();
  expect(harness.core.journal.getThread(threadId)).toBeNull();
  return harness.core.threads.transcriptPurge;
}

test('a purge removes every session the thread kept in an isolated account, sidechains included, and keeps what another thread names', async () => {
  const project = await testProject(harness, client);
  const account = await client.call('accounts.add', { providerId: 'claude', label: 'isolated' });
  if (account.isolationDir === null) throw new Error('the account must be isolated');
  const folder = join(account.isolationDir, 'projects', claudeProjectFolder(project.path));
  // The thread moved folders once: an earlier session sits under another project folder.
  const elsewhere = join(account.isolationDir, 'projects', claudeProjectFolder(join(project.path, 'old-worktree')));
  const current = transcript(folder, FIXTURE_SESSION_ID, project.path);
  const earlier = transcript(elsewhere, EARLIER, project.path);
  const shared = transcript(folder, SHARED, project.path);
  const stranger = transcript(folder, STRANGER, project.path);

  const threadId = await importSession(account.id, project.id);
  const turns = harness.core.journal.db.query('SELECT id FROM turns WHERE thread_id = ? ORDER BY queued_at').all(threadId) as { id: string }[];
  expect(turns.length).toBeGreaterThanOrEqual(2);
  // An account change or a fresh retry leaves earlier sessions in the turns only.
  harness.core.journal.db.query('UPDATE turns SET checkpoint = ? WHERE id = ?').run(JSON.stringify({ sessionId: EARLIER, entry: 'u1' }), turns[0]!.id);
  harness.core.journal.db.query('UPDATE turns SET execution = json_set(COALESCE(execution, \'{}\'), \'$.sessionId\', ?, \'$.accountId\', ?) WHERE id = ?').run(SHARED, account.id, turns[1]!.id);
  // A fork resumes its source's session: that transcript is still in use.
  const { threadId: forkId } = await echoThread(harness, client, 'fork');
  harness.core.journal.db.query('UPDATE threads SET session_id = ? WHERE id = ?').run(SHARED, forkId);

  const removed = await purge(threadId);

  expect(existsSync(current.file)).toBe(false);
  expect(existsSync(current.side)).toBe(false);
  expect(existsSync(earlier.file)).toBe(false);
  expect(existsSync(earlier.side)).toBe(false);
  expect(existsSync(shared.file)).toBe(true);
  expect(existsSync(shared.side)).toBe(true);
  expect(existsSync(stranger.file)).toBe(true);
  expect(removed.sort()).toEqual([current.file, current.side, earlier.file, earlier.side].sort());
});

test('a purge never touches transcripts outside a directory Boite made for the account', async () => {
  const project = await testProject(harness, client);
  const account = await client.call('accounts.add', { providerId: 'claude', label: 'chosen' });
  // A directory the user pointed the account at, not `<dataDir>/accounts/<id>`.
  const chosen = mkdtempSync(join(tmpdir(), 'boite-user-claude-'));
  try {
    harness.core.journal.db.query('UPDATE accounts SET isolation_dir = ? WHERE id = ?').run(chosen, account.id);
    const folder = join(chosen, 'projects', claudeProjectFolder(project.path));
    const current = transcript(folder, FIXTURE_SESSION_ID, project.path);
    const threadId = await importSession(account.id, project.id);

    const removed = await purge(threadId);

    expect(removed).toEqual([]);
    expect(existsSync(current.file)).toBe(true);
    expect(existsSync(current.side)).toBe(true);
  } finally {
    rmSync(chosen, { recursive: true, force: true });
  }
});

test('an import admitted after journal expiry keeps its transcript through cleanup, and none starts while one is removed', async () => {
  const project = await testProject(harness, client);
  const account = await client.call('accounts.add', { providerId: 'claude', label: 'isolated' });
  if (account.isolationDir === null) throw new Error('the account must be isolated');
  const folder = join(account.isolationDir, 'projects', claudeProjectFolder(project.path));
  const current = transcript(folder, FIXTURE_SESSION_ID, project.path);
  const threadId = await importSession(account.id, project.id);
  await client.call('settings.set', { threadDeletionRetentionDays: 1 });
  await client.call('threads.remove', { threadId });
  harness.core.journal.db.query('UPDATE thread_deletions SET deleted_at = ? WHERE root_id = ?').run(Date.now() - 2 * 86_400_000, threadId);

  // Expire the journal reservation before cleanup starts reading the disk.
  // A recoverable deletion now refuses reimport; a fully expired one does not.
  expect(harness.core.journal.purgeDeletedThreads(Date.now())).toBe(1);
  const importing = harness.core.imports.run({ projectId: project.id, accountId: account.id, sessionId: FIXTURE_SESSION_ID });
  expect(await removeTranscripts(harness.core, [{ accountId: account.id, sessionId: FIXTURE_SESSION_ID }])).toEqual([]);
  const again = await importing;
  expect(existsSync(current.file)).toBe(true);
  expect(existsSync(current.side)).toBe(true);

  // Deleted again, a purge that is removing the session refuses an import of it.
  await client.call('threads.remove', { threadId: again.id });
  harness.core.journal.db.query('UPDATE thread_deletions SET deleted_at = ? WHERE root_id = ?').run(Date.now() - 2 * 86_400_000, again.id);
  harness.core.threads.purgeDeleted();
  const refusal = harness.core.imports.run({ projectId: project.id, accountId: account.id, sessionId: FIXTURE_SESSION_ID });
  expect(await thrown(refusal)).toThrow(/being removed/);
  await harness.core.threads.transcriptPurge;
  expect(existsSync(current.file)).toBe(false);
});

test('a projects folder that cannot be read is one warning of the pass, and the purge still goes', async () => {
  if (process.platform !== 'win32' && process.getuid?.() === 0) return; // root reads through any mode
  const project = await testProject(harness, client);
  const account = await client.call('accounts.add', { providerId: 'claude', label: 'isolated' });
  if (account.isolationDir === null) throw new Error('the account must be isolated');
  const projects = join(account.isolationDir, 'projects');
  const current = transcript(join(projects, claudeProjectFolder(project.path)), FIXTURE_SESSION_ID, project.path);
  const threadId = await importSession(account.id, project.id);
  const warnings: string[] = [];
  const log = spyOn(harness.core, 'log').mockImplementation((level, message) => {
    if (level === 'warn') warnings.push(message);
  });
  const deny = (on: boolean): void => {
    if (process.platform !== 'win32') return chmodSync(projects, on ? 0o000 : 0o755);
    const result = Bun.spawnSync(['icacls', projects, ...(on ? ['/deny', '*S-1-1-0:(RD)'] : ['/remove:d', '*S-1-1-0'])], { stdout: 'ignore', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(`icacls ${projects}: ${result.stderr.toString()}`);
  };
  deny(true);
  try {
    expect(await purge(threadId)).toEqual([]);
  } finally {
    deny(false);
    log.mockRestore();
  }
  expect(warnings.filter((message) => message.startsWith('thread purge:'))).toEqual([expect.stringContaining(projects)]);
  expect(existsSync(current.file)).toBe(true);
});

/** A core of its own on `dataDir`, as `main` runs one, for a test that stops and starts it again. */
function coreOn(dataDir: string): Core {
  const core = new Core({ dataDir, token: newToken() });
  core.settings.set({ asyncQuestions: false, shortAnswers: false });
  return core;
}

test('an incognito conversation leaves no transcript when the core stops, nor when the next core finds it after a crash', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-incognito-'));
  const work = join(dataDir, 'work');
  mkdirSync(work);
  try {
    let core = coreOn(dataDir);
    const project = core.projects.add(work, 'work');
    const account = core.accounts.add({ providerId: 'claude', label: 'isolated' });
    if (account.isolationDir === null) throw new Error('the account must be isolated');
    const folder = join(account.isolationDir, 'projects', claudeProjectFolder(project.path));
    const run = { projectId: project.id, accountId: account.id, sessionId: FIXTURE_SESSION_ID };

    // Open when the core stops: the shutdown erases it.
    const atShutdown = transcript(folder, FIXTURE_SESSION_ID, project.path);
    const held = await core.imports.run(run);
    core.journal.db.query('UPDATE threads SET incognito = 1 WHERE id = ?').run(held.id);
    await core.close();
    expect(existsSync(atShutdown.file)).toBe(false);
    expect(existsSync(atShutdown.side)).toBe(false);

    // Open when the core died: the journal still has it, and the next core erases it.
    core = coreOn(dataDir);
    const atCrash = transcript(folder, FIXTURE_SESSION_ID, project.path);
    const crashed = await core.imports.run(run);
    await core.close();
    const journal = new Database(join(dataDir, 'journal.db'));
    journal.query('UPDATE threads SET incognito = 1 WHERE id = ?').run(crashed.id);
    journal.close();
    expect(existsSync(atCrash.file)).toBe(true);
    core = coreOn(dataDir);
    try {
      await core.threads.transcriptPurge;
      expect(existsSync(atCrash.file)).toBe(false);
      expect(existsSync(atCrash.side)).toBe(false);
    } finally {
      await core.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
