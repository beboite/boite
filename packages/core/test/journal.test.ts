import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Message } from '@boite/contracts';
import { MESSAGE_PAGE_MAX_BYTES, RPC_MAX_FRAME_BYTES } from '@boite/contracts';
import { Journal } from '../src/journal.ts';
import { JournalTooNewError, SCHEMA_VERSION } from '../src/journal/schema.ts';

let dir: string;
let file: string;
let journal: Journal;

function sampleMessage(id: string): Message {
  return {
    id,
    threadId: 'thr_test',
    turnId: 'trn_test',
    role: 'assistant',
    parts: [],
    state: 'streaming',
    createdAt: Date.now(),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boite-journal-'));
  process.env.BOITE_DATA_DIR = dir;
  file = join(dir, 'journal.db');
  journal = new Journal(file);
});

afterEach(() => {
  journal.close();
  delete process.env.BOITE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** A read bound for a client that compacts nothing: measured and bounded as sent. */
const sent = (message: Message): Message => message;

describe('journal', () => {
  test('legacy input receipts bind only exact unique messages and ambiguous cuts retain replay protection after reopen', () => {
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const input = (id: string, text: string): Message => ({ ...sampleMessage(id), role: 'user', state: 'complete', parts: [{ type: 'text', text }] });
    journal.putMessage(input('held-answer', 'An earlier held answer'));
    journal.putMessage(input('original', 'Original prompt'));
    journal.putMessage(input('kept-steer', 'Kept follow-up'));
    journal.putMessage(input('unique-cut-steer', 'Removed follow-up'));
    journal.putMessage(input('cut-steer', 'Ambiguous follow-up'));
    journal.putMessage(input('other-cut-steer', 'Ambiguous follow-up'));
    journal.putTurnRequest('thr_test', 'original_request', hash(['Original prompt', []]), 'trn_test');
    journal.putTurnRequest('thr_test', 'kept_request', `steer:accepted:${hash(['trn_test', 'Kept follow-up', [], []])}`, 'trn_test');
    journal.putTurnRequest('thr_test', 'removed_request', `steer:accepted:${hash(['trn_test', 'Removed follow-up', [], []])}`, 'trn_test');
    const ambiguous = hash(['trn_test', 'Ambiguous follow-up', [], []]);
    journal.putTurnRequest('thr_test', 'ambiguous_request', `steer:accepted:${ambiguous}`, 'trn_test');
    journal.putTurnRequest('thr_test', 'uncertain_request', 'steer:pending:uncertain', 'trn_test');
    journal.putTurnRequest('thr_test', 'unknown_start', 'unrecoverable-start-fingerprint', 'trn_test');
    if (journal.db.query("SELECT name FROM pragma_table_info('turn_requests') WHERE name = 'message_id'").get()) journal.db.exec('ALTER TABLE turn_requests DROP COLUMN message_id');
    journal.db.exec('PRAGMA user_version = 26');
    journal.close(); journal = new Journal(file);
    const bindings = journal.db.query('SELECT request_id, message_id FROM turn_requests ORDER BY request_id').all();
    expect(bindings).toEqual([
      { request_id: 'ambiguous_request', message_id: null }, { request_id: 'kept_request', message_id: 'kept-steer' },
      { request_id: 'original_request', message_id: 'original' }, { request_id: 'removed_request', message_id: 'unique-cut-steer' },
      { request_id: 'uncertain_request', message_id: null },
      { request_id: 'unknown_start', message_id: null },
    ]);
    const cut = journal.db.query('SELECT rowid FROM messages WHERE id = ?').get('unique-cut-steer') as { rowid: number };
    journal.append({ type: 'thread.rewound', threadId: 'thr_test', version: 1, payload: {} }, () => journal.truncateMessages('thr_test', cut.rowid));
    journal.close(); journal = new Journal(file);
    expect(journal.turnRequest('thr_test', 'original_request')?.fingerprint).toBe(hash(['Original prompt', []]));
    expect(journal.turnRequest('thr_test', 'kept_request')?.fingerprint).toBe(`steer:accepted:${hash(['trn_test', 'Kept follow-up', [], []])}`);
    expect(journal.turnRequest('thr_test', 'removed_request')).toBeNull();
    expect(journal.turnRequest('thr_test', 'ambiguous_request')?.fingerprint).toBe(`steer:pending:${ambiguous}`);
    expect(journal.turnRequest('thr_test', 'uncertain_request')?.fingerprint).toBe('steer:pending:uncertain');
    expect(journal.turnRequest('thr_test', 'unknown_start')?.fingerprint).toBe('start:pending:unrecoverable-start-fingerprint');
    journal.append({ type: 'thread.rewound', threadId: 'thr_test', version: 1, payload: {} }, () => journal.truncateMessages('thr_test', 0));
    expect(journal.turnRequest('thr_test', 'original_request')).toBeNull();
    expect(journal.turnRequest('thr_test', 'kept_request')).toBeNull();
    expect(journal.turnRequest('thr_test', 'unknown_start')).toBeNull();
    expect(journal.turnRequest('thr_test', 'ambiguous_request')?.fingerprint).toBe(`steer:pending:${ambiguous}`);
    expect(journal.turnRequest('thr_test', 'uncertain_request')?.fingerprint).toBe('steer:pending:uncertain');
  });

  test.each([0, 25])('index failure rolls back schema %i and a later open retries the entire migration', (version) => {
    const target = join(dir, 'index-failure.db');
    const indexes = ['thread_deletions_by_date', 'processes_by_started', 'turns_by_status', 'messages_by_turn', 'turns_by_finished'];
    if (version === 25) {
      const previous = new Journal(target);
      try {
        previous.putProject({ id: 'kept', name: 'kept', path: dir, createdAt: 1 });
        for (const name of indexes) previous.db.exec(`DROP INDEX ${name}`);
        previous.db.exec('ALTER TABLE threads DROP COLUMN branch_naming_pending; PRAGMA user_version = 25');
      } finally {
        previous.close();
      }
    }
    const failure = new Error('maintenance index failed');
    const original = Database.prototype.exec;
    const mock = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
      if (sql.includes('CREATE INDEX IF NOT EXISTS messages_by_turn')) throw failure;
      return original.call(this, sql);
    });
    try {
      expect(() => new Journal(target)).toThrow(failure);
    } finally {
      mock.mockRestore();
    }
    const raw = new Database(target);
    try {
      expect(raw.query('PRAGMA user_version').get()).toEqual({ user_version: version });
      expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'index'").all()
        .filter(row => indexes.includes((row as { name: string }).name))).toEqual([]);
      expect(raw.query("SELECT name FROM pragma_table_info('threads') WHERE name = 'branch_naming_pending'").get()).toBeNull();
      if (version === 0) expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
      else expect(raw.query('SELECT id FROM projects').all()).toEqual([{ id: 'kept' }]);
    } finally {
      raw.close();
    }
    const retried = new Journal(target);
    try {
      expect(retried.db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
      expect(retried.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all()
        .filter(row => indexes.includes((row as { name: string }).name))).toHaveLength(indexes.length);
      if (version === 25) expect(retried.getProject('kept')?.name).toBe('kept');
    } finally {
      retried.close();
    }
  });

  test.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('schema %i retains rows, applies historical defaults and repairs old thread ownership', (version) => {
    journal.putProject({ id: 'kept', name: 'kept', path: dir, createdAt: 1 });
    journal.putThread({ id: 'old', projectId: 'kept', title: 'existing', titleSource: 'user', providerId: 'echo', accountId: 'acc', model: null, effort: 'high', cwd: dir, branch: 'kept-branch', permissionMode: 'default', status: 'idle', unread: false, archived: false, pinned: true, sessionId: null, load: null, context: null, createdAt: 1, updatedAt: 2 });
    journal.putMessage({ ...sampleMessage('kept-message'), threadId: 'old', state: 'complete' });
    if (version >= 4) journal.db.exec("INSERT INTO sessions VALUES ('paired', 'hash', 'phone', '1', 1, 2, 'owner')");
    // Restore the old NOT NULL ownership constraint without losing newer columns or indexes.
    const definition = journal.db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get() as { sql: string };
    const indexes = journal.db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'threads' AND sql IS NOT NULL").all() as { sql: string }[];
    journal.db.exec(definition.sql.replace(/CREATE TABLE (?:IF NOT EXISTS )?["`\[]?threads["`\]]?/i, 'CREATE TABLE threads_legacy')
      .replace(/project_id TEXT/i, 'project_id TEXT NOT NULL'));
    journal.db.exec('INSERT INTO threads_legacy SELECT * FROM threads; DROP TABLE threads; ALTER TABLE threads_legacy RENAME TO threads');
    for (const index of indexes) journal.db.exec(index.sql);
    journal.db.exec('DROP INDEX threads_done_expiry');
    const addedColumns = [[2, 'threads', 'effort'], [3, 'threads', 'pinned'], [5, 'threads', 'branch'], [6, 'threads', 'title_source'], [7, 'threads', 'context'], [9, 'threads', 'session_generation'], [9, 'threads', 'selection_version'], [9, 'turns', 'execution'], [10, 'threads', 'speed'], [15, 'threads', 'agent_session_id'], [29, 'threads', 'done_at']] as const;
    for (const [since, table, column] of addedColumns) {
      if (version < since) journal.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    if (version < 4) journal.db.exec('DROP TABLE sessions');
    else if (version < 8) journal.db.exec('ALTER TABLE sessions DROP COLUMN role');
    journal.db.exec(`DROP TABLE turn_requests; DROP TABLE coordination_letters; DROP TABLE coordination_wakes; PRAGMA user_version = ${version}`);
    journal.close();
    journal = new Journal(file);
    expect(journal.db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(journal.getProject('kept')?.name).toBe('kept');
    expect(journal.getThread('old')).toMatchObject({ title: 'existing', projectId: 'kept', effort: version >= 2 ? 'high' : null,
      pinned: version >= 3, branch: version >= 5 ? 'kept-branch' : null, titleSource: version >= 6 ? 'user' : 'prompt' });
    expect(journal.listMessages('old').map(message => message.id)).toEqual(['kept-message']);
    expect(journal.db.query("SELECT name, \"notnull\" FROM pragma_table_info('threads') WHERE name = 'project_id'").get())
      .toEqual({ name: 'project_id', notnull: 0 });
    expect(journal.db.query('SELECT agent_session_id, session_generation, selection_version FROM threads WHERE id = ?').get('old'))
      .toEqual({ agent_session_id: null, session_generation: 0, selection_version: 0 });
    if (version >= 4) expect(journal.db.query('SELECT role FROM sessions WHERE id = ?').get('paired'))
      .toEqual({ role: version >= 8 ? 'owner' : 'device' });
    journal.close();
    journal = new Journal(file);
    expect(journal.getThread('old')?.title).toBe('existing');
  });

  test('schema 24 projects migrate with worktree defaults off and retain enabled defaults after reopen', () => {
    journal.putProject({ id: 'prj_default', name: 'test', path: dir, createdAt: 1 });
    journal.db.exec('ALTER TABLE projects DROP COLUMN worktree_default; PRAGMA user_version = 24');
    journal.close();
    journal = new Journal(file);
    expect(journal.getProject('prj_default')?.worktreeDefault).toBeUndefined();
    expect(journal.db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    journal.putProject({ ...journal.getProject('prj_default')!, worktreeDefault: true });
    journal.close();
    journal = new Journal(file);
    expect(journal.getProject('prj_default')?.worktreeDefault).toBe(true);
  });

  test('an existing journal indexes newest process traces without sorting its whole history', () => {
    journal.db.exec('DROP INDEX IF EXISTS processes_by_started');
    journal.close();
    journal = new Journal(file);
    for (const [pid, at] of [[100, 3], [101, 1], [100, 5], [102, 2]] as const) {
      journal.putProcess({ threadId: 'trace', pid, parentPid: null, exe: 'agent', commandLine: null,
        startedAt: at, exitedAt: at + 1, exitCode: 0, cpuMs: 1, peakMemoryBytes: 1, ioBytes: null });
    }
    expect(journal.listProcesses('trace', 2).map(record => record.startedAt)).toEqual([5, 3]);
    const plan = journal.db.query('EXPLAIN QUERY PLAN SELECT * FROM processes WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?')
      .all('trace', 2) as { detail: string }[];
    expect(plan.some(row => row.detail.includes('USE TEMP B-TREE'))).toBe(false);
    expect(plan.some(row => row.detail.includes('processes_by_started'))).toBe(true);
  });

  test('a history snapshot includes deltas already delivered to subscribers', () => {
    journal.putMessage(sampleMessage('streaming-snapshot'));
    journal.appendDelta('thr_test', 'streaming-snapshot', 0, 'already delivered');
    expect(journal.listMessagePage('thr_test', { limit: 120, project: sent }).messages[0]?.parts)
      .toEqual([{ type: 'text', text: 'already delivered' }]);
    journal.putMessage({ ...sampleMessage('older-large'), state: 'complete', parts: [{ type: 'text', text: 'x'.repeat(7 * 1024 * 1024) }] });
    journal.putMessage(sampleMessage('latest-live'));
    journal.appendDelta('thr_test', 'latest-live', 0, 'y'.repeat(7 * 1024 * 1024));
    const page = journal.listMessagePage('thr_test', { limit: 120, project: sent });
    expect(page.messages.map(message => message.id)).toEqual(['latest-live']);
    expect(page.before).toBe('latest-live');
    expect((page.messages[0]?.parts[0] as { text: string }).text.length).toBe(7 * 1024 * 1024);
    expect(journal.listMessagesFrom('thr_test', journal.messageRowid('thr_test', 'older-large')!, 120, sent) === null).toBe(true);
    const delta = journal.listMessagesFrom('thr_test', journal.messageRowid('thr_test', 'latest-live')!, 120, sent);
    expect(delta?.messages[0]?.parts).toEqual(page.messages[0]?.parts);
    const older = { ...journal.getMessage('older-large')!, parts: [{ type: 'text' as const, text: '' }] };
    const padding = 'a'.repeat(MESSAGE_PAGE_MAX_BYTES - Buffer.byteLength(JSON.stringify([older, delta!.messages[0]])));
    journal.db.query('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify([{ type: 'text', text: padding }]), older.id);
    const exact = journal.listMessagesFrom('thr_test', journal.messageRowid('thr_test', older.id)!, 120, sent);
    expect(exact?.messages.length).toBe(2);
    expect(Buffer.byteLength(JSON.stringify(exact?.sent))).toBe(MESSAGE_PAGE_MAX_BYTES);
    journal.appendDelta('thr_test', 'latest-live', 0, '!');
    expect(journal.listMessagesFrom('thr_test', journal.messageRowid('thr_test', older.id)!, 120, sent) === null).toBe(true);
    const resized = journal.listMessagePage('thr_test', { limit: 120, project: sent }).messages;
    expect(resized.map(message => message.id)).toEqual(['latest-live']);
    expect(resized[0]?.parts[0]?.type === 'text' && resized[0].parts[0].text.endsWith('!')).toBe(true);
  });

  test('a single message can exceed the page budget for progress but an untransportable message is refused by name', () => {
    const data = 'A'.repeat(Math.ceil(5 * 1024 * 1024 / 3) * 4 - 1) + '=';
    journal.putMessage({ ...sampleMessage('legal-attachment'), state: 'complete', parts: ['first.bin', 'second.bin'].map(name => ({ type: 'file', name, mimeType: 'application/octet-stream', data })) });
    const page = journal.listMessagePage('thr_test', { limit: 120, project: sent });
    expect(page.messages.map(message => message.id)).toEqual(['legal-attachment']);
    expect(page.before).toBeNull();
    const bytes = Buffer.byteLength(JSON.stringify(page.messages));
    expect(bytes).toBeGreaterThan(MESSAGE_PAGE_MAX_BYTES);
    expect(bytes).toBeLessThan(RPC_MAX_FRAME_BYTES);
    const tailTooLarge = journal.listMessagesFrom('thr_test', journal.messageRowid('thr_test', 'legal-attachment')!, 120, sent) === null;
    journal.putMessage({ ...sampleMessage('oversized-message'), state: 'complete', parts: [{ type: 'text', text: 'x'.repeat(RPC_MAX_FRAME_BYTES) }] });
    expect(() => journal.listMessagePage('thr_test', { limit: 120, project: sent })).toThrow('message oversized-message');
    try { journal.listMessagePage('thr_test', { limit: 120, project: sent }); }
    catch (error) { expect(error).toMatchObject({ data: { field: 'messages', messageId: 'oversized-message', expected: `a complete message below ${RPC_MAX_FRAME_BYTES} serialized UTF-8 bytes` } }); }
    expect(tailTooLarge).toBe(true);
    // An internal read (a fork's boundary, a memory notice's anchor) sends nothing and is never refused.
    expect(journal.listMessagePage('thr_test', { limit: 1 }).messages.map(message => message.id)).toEqual(['oversized-message']);
  });

  test('corrupt JSON names its table, row and column', () => {
    journal.putMessage({ ...sampleMessage('broken-message'), state: 'complete' });
    journal.db.query('UPDATE messages SET parts = ? WHERE id = ?').run('{', 'broken-message');
    expect(() => journal.getMessage('broken-message')).toThrow('messages.parts row broken-message');
    journal.db.query('INSERT INTO settings (key, value) VALUES (?, ?)').run('settings', '{');
    expect(() => journal.getSetting('settings')).toThrow('settings.value row settings');
  });
  test('a schema 21 journal gains the project icon table and keeps its projects', () => {
    journal.putProject({ id: 'prj_old', name: 'old', path: dir, createdAt: 1 });
    journal.db.exec('DROP TABLE project_icons; ALTER TABLE threads DROP COLUMN branch_naming_pending; PRAGMA user_version = 21;');
    journal.close();
    journal = new Journal(file);
    expect(journal.db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(journal.listProjects().map((p) => p.id)).toEqual(['prj_old']);
    expect(journal.projectIcons().size).toBe(0);
    expect(journal.db.query("SELECT name FROM pragma_table_info('threads') WHERE name = 'branch_naming_pending'").get()).toEqual({ name: 'branch_naming_pending' });
    journal.putProjectIcon('prj_old', { kind: 'tech', id: 'go' }, 2);
    expect(journal.projectIcons().get('prj_old')).toEqual({ kind: 'tech', tech: 'go', version: null });
  });

  test('a schema 23 journal retains existing titles and persists new refinement state across opens', () => {
    const thread = { id: 'thr_title', projectId: 'prj', title: 'My title', titleSource: 'user', providerId: 'echo', accountId: 'acc', model: null, effort: null, cwd: dir, branch: null, permissionMode: 'default', status: 'idle', unread: false, archived: false, pinned: false, sessionId: null, load: null, context: null, createdAt: 1, updatedAt: 1 } as const;
    journal.putThread(thread);
    journal.db.exec('ALTER TABLE threads DROP COLUMN title_state; PRAGMA user_version = 23;');
    journal.close();
    journal = new Journal(file);
    expect(journal.getThread(thread.id)).toMatchObject({ title: 'My title', titleSource: 'user' });
    expect(journal.getThread(thread.id)?.titleState).toBeUndefined();
    journal.putThread({ ...thread, titleState: { version: 4, needsRefinement: true } });
    journal.close();
    journal = new Journal(file);
    expect(journal.getThread(thread.id)?.titleState).toEqual({ version: 4, needsRefinement: true });
    expect(journal.db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
  });

  test('the schema version is stamped and WAL is on', () => {
    const version = journal.db.query('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    const mode = journal.db.query('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
  });

  test('deletion survives shutdown and hard stops, retaining archive state and history until purge', () => {
    const thread = { id: 'thr_undo', projectId: 'prj', title: 'undo', titleSource: 'prompt', providerId: 'echo', accountId: 'acc', model: null, effort: null, speed: null, cwd: dir, branch: null, permissionMode: 'default', status: 'idle', unread: false, archived: true, pinned: false, sessionId: null, load: null, context: null, createdAt: 1, updatedAt: 1 } as const;
    for (const id of ['thr_undo', 'thr_gone']) {
      journal.putThread({ ...thread, id });
      journal.putMessage({ ...sampleMessage(`msg_${id}`), threadId: id, state: 'complete' });
      journal.stageThreadDeletion(id, [{ ...thread, id }]);
    }
    expect(journal.listThreads()).toEqual([]);
    expect(journal.archivedThreadCounts().size).toBe(0);
    expect(journal.listDeletedThreads().map(t => t.id).sort()).toEqual(['thr_gone', 'thr_undo']);
    journal.restoreDeletedThreads('thr_undo');
    expect(journal.getThread('thr_undo')?.archived).toBe(true);
    expect(journal.archivedThreadCounts().get('prj')).toEqual({ archived: 1, done: 0 });
    expect(journal.listMessages('thr_undo')).toHaveLength(1);
    journal.close();
    journal = new Journal(file);
    expect(journal.getThread('thr_undo')).not.toBeNull();
    expect(journal.getThread('thr_gone')).toBeNull();
    expect(journal.listMessages('thr_gone')).toHaveLength(1);
    expect(journal.listDeletedThreads().map(t => t.id)).toEqual(['thr_gone']);
    // Simulate a hard stop: bypass Journal.close, leaving the pending rows on disk.
    journal.stageThreadDeletion('thr_undo', [journal.getThread('thr_undo')!]);
    journal.db.close();
    journal = new Journal(file);
    expect(journal.listThreads()).toEqual([]);
    expect(journal.listMessages('thr_undo')).toHaveLength(1);
    expect(journal.listDeletedThreads().map(t => t.id).sort()).toEqual(['thr_gone', 'thr_undo']);
    journal.restoreDeletedThreads('thr_undo');
    expect(journal.getThread('thr_undo')?.archived).toBe(true);
    expect(journal.listMessages('thr_undo')).toHaveLength(1);
  });

  test('purge uses the root deletion date and erases its whole family only at the deadline', () => {
    const root = { id: 'root', projectId: 'prj', title: 'old conversation', titleSource: 'user', providerId: 'echo', accountId: 'acc', model: null, effort: null, cwd: dir, branch: null, permissionMode: 'default', status: 'idle', unread: false, archived: false, pinned: false, sessionId: null, load: null, context: null, createdAt: 1, updatedAt: 1 } as const;
    const child = { ...root, id: 'child', parentThreadId: root.id };
    const kept = { ...root, id: 'kept' };
    for (const thread of [root, child, kept]) {
      journal.putThread(thread);
      journal.putMessage({ ...sampleMessage(`msg_${thread.id}`), threadId: thread.id, state: 'complete' });
      journal.setSetting(`activity:${thread.id}`, { tasks: [] });
    }
    journal.stageThreadDeletion(root.id, [root, child]);
    journal.stageThreadDeletion(kept.id, [kept]);
    const deletedAt = journal.listDeletedThreads().find(t => t.id === root.id)!.deletedAt;
    // Child markers cannot split a family, and a freshly deleted old thread survives.
    journal.db.query('UPDATE thread_deletions SET deleted_at = ? WHERE thread_id != ?').run(deletedAt + 1000, root.id);
    expect(journal.purgeDeletedThreads(deletedAt - 1)).toBe(0);
    expect(journal.purgeDeletedThreads(deletedAt)).toBe(2);
    for (const id of [root.id, child.id]) {
      expect(journal.listMessages(id)).toEqual([]);
      expect(journal.getSetting(`activity:${id}`)).toBeUndefined();
    }
    expect(journal.listDeletedThreads().map(t => t.id)).toEqual([kept.id]);
    expect(journal.listMessages(kept.id)).toHaveLength(1);
    expect(journal.restoreDeletedThreads(kept.id)).toEqual([kept.id]);
    expect(journal.getThread(kept.id)?.createdAt).toBe(1);
  });

  test('append writes the event and the projection in one call', () => {
    journal.append({ type: 'project.added', threadId: null, version: 1, payload: { id: 'prj_1' } }, () => {
      journal.putProject({ id: 'prj_1', name: 'one', path: 'D:/one', createdAt: 1 });
    });
    expect(journal.listProjects()).toHaveLength(1);
    expect(journal.countEvents('project.added')).toBe(1);
  });

  test('deltas are buffered into the message, with no event of their own', () => {
    journal.append({ type: 'message.started', threadId: 'thr_test', version: 1, payload: {} }, () => {
      journal.putMessage(sampleMessage('msg_1'));
    });
    journal.appendDelta('thr_test', 'msg_1', 0, 'he');
    journal.appendDelta('thr_test', 'msg_1', 0, 'llo ');
    journal.appendDelta('thr_test', 'msg_1', 0, 'world');

    journal.flushDeltas();
    expect(journal.countEvents('message.delta')).toBe(0);
    const message = journal.getMessage('msg_1');
    expect(message?.parts).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  test('a part write flushes the deltas that came before it', () => {
    journal.append({ type: 'message.started', threadId: 'thr_test', version: 1, payload: {} }, () => {
      journal.putMessage(sampleMessage('msg_2'));
    });
    journal.appendDelta('thr_test', 'msg_2', 0, 'before');
    journal.append({ type: 'message.part', threadId: 'thr_test', version: 1, payload: {} }, () => {
      journal.setMessagePart('msg_2', 1, { type: 'error', message: 'boom' });
    });
    const message = journal.getMessage('msg_2');
    expect(message?.parts).toEqual([
      { type: 'text', text: 'before' },
      { type: 'error', message: 'boom' },
    ]);
  });

  test('a journal from a newer release is refused before anything is written', () => {
    journal.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    journal.close();
    let refused: unknown;
    try {
      new Journal(file);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(JournalTooNewError);
    expect(String(refused)).toContain(`journal schema ${SCHEMA_VERSION + 1}`);
    const raw = new Database(file);
    expect((raw.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION + 1);
    raw.close();
    journal = new Journal(join(dir, 'other.db'));
  });

  test('removing a project clears every row its threads left, with foreign keys off', () => {
    const count = (sql: string) => (journal.db.query(sql).get() as { n: number }).n;
    const thread = { id: 'thr_gone', projectId: 'prj_gone', title: 't', titleSource: 'prompt', providerId: 'echo', accountId: 'acc', model: null, effort: null, speed: null, cwd: 'D:/x', branch: null, permissionMode: 'default', status: 'idle', unread: false, archived: false, pinned: false, sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, createdAt: 1, updatedAt: 1 } as const;
    journal.append({ type: 'thread.created', threadId: 'thr_gone', version: 1, payload: {} }, () => journal.putThread({ ...thread }));
    journal.db.query("INSERT INTO coordination_letters (id, thread_id, direction, status, created_at, data) VALUES ('l', 'thr_gone', 'in', 'received', 1, '{}')").run();
    journal.db.query("INSERT INTO coordination_wakes VALUES ('thr_gone', 1)").run();
    journal.setSetting('activity:thr_gone', { tasks: [] });
    journal.deleteThreadsOfProject('prj_gone');
    expect(count("SELECT COUNT(*) AS n FROM coordination_letters WHERE thread_id = 'thr_gone'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM coordination_wakes WHERE thread_id = 'thr_gone'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE thread_id = 'thr_gone'")).toBe(0);
    expect(journal.getSetting('activity:thr_gone')).toBeUndefined();
    expect((journal.db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(0);
  });

  test('removing a project drops its todos and workflow templates and keeps another project and a global template', () => {
    journal.putProject({ id: 'prj_gone', name: 'gone', path: dir, createdAt: 1 });
    journal.putProject({ id: 'prj_keep', name: 'keep', path: dir, createdAt: 1 });
    journal.setSetting('todos:prj_gone', [{ id: 'a' }]);
    journal.setSetting('todos:prj_keep', [{ id: 'b' }]);
    journal.db.query('INSERT INTO workflow_templates VALUES (?, ?, ?, ?, ?, ?)').run('tpl_gone', 'prj_gone', 'gone', 1, 1, '{}');
    journal.db.query('INSERT INTO workflow_templates VALUES (?, ?, ?, ?, ?, ?)').run('tpl_global', null, 'global', 1, 1, '{}');
    journal.deleteProject('prj_gone');
    expect(journal.getSetting('todos:prj_gone')).toBeUndefined();
    expect(journal.getSetting('todos:prj_keep')).toEqual([{ id: 'b' }]);
    expect(journal.db.query('SELECT id FROM workflow_templates ORDER BY id').all()).toEqual([{ id: 'tpl_global' }]);
    expect(journal.getProject('prj_keep')?.id).toBe('prj_keep');
  });

  test('thread deletion commits delegated and workflow history without removal listeners, or rolls everything back', () => {
    const thread = { id: 'thr_gone', projectId: 'prj', title: 't', titleSource: 'prompt', providerId: 'echo', accountId: 'acc', model: null, effort: null, speed: null, cwd: dir, branch: null, permissionMode: 'default', status: 'idle', unread: false, archived: false, pinned: false, sessionId: null, load: null, context: null, createdAt: 1, updatedAt: 1 } as const;
    for (const id of ['gone', 'keep']) {
      journal.putThread({ ...thread, id: `thr_${id}` });
      journal.db.query('INSERT INTO delegated_agents VALUES (?, ?, ?, ?, ?, ?)').run(`child_${id}`, `thr_${id}`, id, id, 'worker', 'delegated task');
      journal.db.query('INSERT INTO delegation_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, `thr_${id}`, `thr_${id}`, `child_${id}`, id, id, 'received', 1, '{"text":"delegated message"}');
      journal.db.query('INSERT INTO workflow_runs VALUES (?, ?, ?, ?, ?, ?)').run(id, `thr_${id}`, 'stopped', 1, 1, '{"task":"workflow prompt"}');
      journal.db.query('INSERT INTO workflow_steps VALUES (?, ?, ?)').run(`step_${id}`, id, 'step');
      journal.db.query('INSERT INTO workflow_requests VALUES (?, ?, ?, ?)').run(`thr_${id}`, id, id, id);
    }
    const counts = () => ['threads', 'delegated_agents', 'delegation_messages', 'workflow_runs', 'workflow_steps', 'workflow_requests']
      .map(table => (journal.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    // Refuse the last delete to prove earlier dependent deletes cannot commit alone.
    journal.setSetting('spawn-origin:thr_gone', { reported: false });
    journal.setSetting('spawns:thr_gone', { at: 1 });
    journal.setSetting('spawn-origin:thr_keep', { reported: true });
    journal.db.exec("CREATE TRIGGER interrupt_delete BEFORE DELETE ON threads BEGIN SELECT RAISE(ABORT, 'interrupted removal'); END");
    expect(() => journal.deleteThreads(['thr_gone'])).toThrow('interrupted removal');
    expect(counts()).toEqual([2, 2, 2, 2, 2, 2]);
    expect(journal.getSetting('spawn-origin:thr_gone')).toEqual({ reported: false });
    journal.db.exec('DROP TRIGGER interrupt_delete');
    journal.deleteThreads(['thr_gone']);
    journal.close();
    journal = new Journal(file);
    expect(counts()).toEqual([1, 1, 1, 1, 1, 1]);
    expect(journal.getThread('thr_gone')).toBeNull();
    expect(journal.getThread('thr_keep')).not.toBeNull();
    expect(journal.getSetting('spawn-origin:thr_gone')).toBeUndefined();
    expect(journal.getSetting('spawns:thr_gone')).toBeUndefined();
    expect(journal.getSetting('spawn-origin:thr_keep')).toEqual({ reported: true });
  });

  test('event retention deletes old events from the front and keeps the agents revision', () => {
    const now = Date.now();
    const old = now - 40 * 86_400_000;
    for (let i = 0; i < 5; i++) journal.append({ type: 'thread.updated', threadId: 't', version: 1, payload: {}, ts: old }, () => undefined);
    journal.append({ type: 'agents.record', threadId: null, version: 1, payload: {}, ts: old }, () => undefined);
    const revision = (journal.db.query("SELECT MAX(id) AS id FROM events WHERE type = 'agents.record'").get() as { id: number }).id;
    for (let i = 0; i < 3; i++) journal.append({ type: 'thread.updated', threadId: 't', version: 1, payload: {}, ts: now }, () => undefined);
    const cutoff = now - 30 * 86_400_000;
    expect(journal.pruneEvents(cutoff, 3)).toBe(3);
    expect(journal.pruneEvents(cutoff, 3)).toBe(2);
    expect(journal.pruneEvents(cutoff, 3)).toBe(0);
    expect(journal.countEvents()).toBe(4);
    expect((journal.db.query("SELECT MAX(id) AS id FROM events WHERE type = 'agents.record'").get() as { id: number }).id).toBe(revision);
  });

  test('reopening the file keeps the data', () => {
    journal.append({ type: 'project.added', threadId: null, version: 1, payload: {} }, () => {
      journal.putProject({ id: 'prj_keep', name: 'keep', path: 'D:/keep', createdAt: 2 });
    });
    journal.putThread({ id: 'thr_pending', projectId: 'prj_keep', title: 'keep', titleSource: 'prompt', providerId: 'echo', accountId: 'acc', model: null, effort: null, cwd: dir, branch: 'boite/wt-12345678', branchNamingPending: true, permissionMode: 'default', status: 'idle', unread: false, archived: false, pinned: false, sessionId: null, load: null, context: null, createdAt: 1, updatedAt: 1 });
    journal.close();

    journal = new Journal(file);
    expect(journal.listProjects().map((project) => project.id)).toEqual(['prj_keep']);
    expect(journal.countEvents()).toBe(1);
    expect(journal.getThread('thr_pending')?.branchNamingPending).toBe(true);
    expect(journal.listThreads()[0]?.branchNamingPending).toBe(true);
  });
});
