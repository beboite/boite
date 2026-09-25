import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Message } from '@boite/contracts';
import { Journal, JournalTooNewError, SCHEMA_VERSION } from '../src/journal.ts';

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

describe('journal', () => {
  test('a history snapshot includes deltas already delivered to subscribers', () => {
    journal.putMessage(sampleMessage('streaming-snapshot'));
    journal.appendDelta('thr_test', 'streaming-snapshot', 0, 'already delivered');
    expect(journal.listMessagePage('thr_test', { limit: 120 }).messages[0]?.parts)
      .toEqual([{ type: 'text', text: 'already delivered' }]);
  });

  test('corrupt JSON names its table, row and column', () => {
    journal.putMessage({ ...sampleMessage('broken-message'), state: 'complete' });
    journal.db.query('UPDATE messages SET parts = ? WHERE id = ?').run('{', 'broken-message');
    expect(() => journal.getMessage('broken-message')).toThrow('messages.parts row broken-message');
    journal.db.query('INSERT INTO settings (key, value) VALUES (?, ?)').run('settings', '{');
    expect(() => journal.getSetting('settings')).toThrow('settings.value row settings');
  });
  test('the schema version is stamped and WAL is on', () => {
    const version = journal.db.query('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    const mode = journal.db.query('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
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
    journal.close();

    journal = new Journal(file);
    expect(journal.listProjects().map((project) => project.id)).toEqual(['prj_keep']);
    expect(journal.countEvents()).toBe(1);
  });
});
