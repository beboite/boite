import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { CoreClient } from '../src/client.ts';
import { claudeProjectFolder } from '../src/imports/claude.ts';
import { claudeSessionFixture, FIXTURE_SESSION_ID } from './fixtures/claude-session.ts';
import { echoThread, startTestCore, testProject } from './harness.ts';
import type { TestCore } from './harness.ts';

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
