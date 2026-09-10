import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message } from '@boite/contracts';
import { Journal, SCHEMA_VERSION } from '../src/journal.ts';

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
  test('corrupt JSON names its table, row and column', () => {
    journal.putMessage(sampleMessage('broken-message'));
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

  test('deltas are buffered into one event and one row', () => {
    journal.append({ type: 'message.started', threadId: 'thr_test', version: 1, payload: {} }, () => {
      journal.putMessage(sampleMessage('msg_1'));
    });
    journal.appendDelta('thr_test', 'msg_1', 0, 'he');
    journal.appendDelta('thr_test', 'msg_1', 0, 'llo ');
    journal.appendDelta('thr_test', 'msg_1', 0, 'world');
    expect(journal.countEvents('message.delta')).toBe(0);

    journal.flushDeltas();
    expect(journal.countEvents('message.delta')).toBe(1);
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
