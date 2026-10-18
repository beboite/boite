import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { Message, MessagePart } from '@boite/contracts';
import { Journal } from '../src/journal.ts';

let dir: string;
let file: string;
let journal: Journal;

function streaming(id: string, turnId = 'trn_test'): Message {
  return { id, threadId: 'thr_test', turnId, role: 'assistant', parts: [], state: 'streaming', createdAt: Date.now() };
}

function toolPart(index: number, bytes: number): MessagePart {
  return { type: 'tool', toolId: `call_${index}`, name: 'Read', input: { file: `f${index}` }, status: 'done', output: 'x'.repeat(bytes) };
}

/** The message row alone. */
function rowParts(messageId: string): MessagePart[] {
  const row = journal.db.query('SELECT parts FROM messages WHERE id = ?').get(messageId) as { parts: string };
  return JSON.parse(row.parts) as MessagePart[];
}

/** What a restart reads: the row with the parts a stream wrote beside it. */
function storedParts(messageId: string): MessagePart[] {
  const parts = rowParts(messageId);
  const side = journal.db.query('SELECT part_index AS partIndex, json FROM streaming_parts WHERE message_id = ?').all(messageId) as { partIndex: number; json: string }[];
  for (const { partIndex, json } of side) parts[partIndex] = JSON.parse(json) as MessagePart;
  return parts;
}

/** Counts writes to message rows and to `streaming_parts`. */
function countWrites(): () => { rows: number; side: number } {
  journal.db.exec(`CREATE TABLE IF NOT EXISTS test_writes (kind TEXT);
    CREATE TRIGGER count_rows AFTER UPDATE OF parts ON messages BEGIN INSERT INTO test_writes VALUES ('rows'); END;
    CREATE TRIGGER count_side_insert AFTER INSERT ON streaming_parts BEGIN INSERT INTO test_writes VALUES ('side'); END;
    CREATE TRIGGER count_side_update AFTER UPDATE ON streaming_parts BEGIN INSERT INTO test_writes VALUES ('side'); END;`);
  const count = (kind: string) => (journal.db.query('SELECT count(*) AS n FROM test_writes WHERE kind = ?').get(kind) as { n: number }).n;
  return () => ({ rows: count('rows'), side: count('side') });
}

const FAIL_WRITES = `CREATE TRIGGER fail_parts BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'forced'); END;
  CREATE TRIGGER fail_side BEFORE INSERT ON streaming_parts BEGIN SELECT RAISE(ABORT, 'forced'); END;`;
const PASS_WRITES = 'DROP TRIGGER fail_parts; DROP TRIGGER fail_side;';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boite-journal-stream-'));
  file = join(dir, 'journal.db');
  journal = new Journal(file);
});

afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('journal streaming', () => {
  test('reading one thread returns current parts without writing any streaming rows', () => {
    journal.putMessage(streaming('msg_read', 'trn_read'));
    journal.putMessage({ ...streaming('msg_other', 'trn_other'), threadId: 'thr_other' });
    journal.putMessage({ ...streaming('msg_user', 'trn_read'), role: 'user', state: 'complete', parts: [{ type: 'text', text: 'request' }] });
    let current = 'current';
    const rowid = journal.messageRowid('thr_test', 'msg_read')!;
    const readers = [
      () => journal.getMessage('msg_read'),
      () => journal.listMessages('thr_test')[0],
      () => journal.listMessagePage('thr_test', { limit: 10 }).messages[0],
      () => journal.listMessagesFrom('thr_test', rowid, 10)?.messages[0],
      () => [...journal.walkMessages('thr_test')][0],
      () => [...journal.walkTurnMessages('thr_test', 'trn_read')][0],
    ];
    const read = (): void => {
      for (const reader of readers) {
        journal.appendDelta('thr_test', 'msg_read', 0, ' next');
        current += ' next';
        expect(reader()?.parts).toEqual([{ type: 'text', text: current }]);
      }
      expect(journal.lastUserMessage('thr_test', 'trn_read')?.parts).toEqual([{ type: 'text', text: 'request' }]);
      expect(journal.messageIdsFrom('thr_test', rowid).messageIds).toEqual(['msg_read', 'msg_user']);
    };
    journal.appendDelta('thr_test', 'msg_read', 0, 'current');
    journal.appendDelta('thr_other', 'msg_other', 0, 'unrelated');
    read();
    expect(storedParts('msg_read')).toEqual([]);
    expect(storedParts('msg_other')).toEqual([]);
    // Read overlays cannot consume dirty state, even under an aborted transaction.
    expect(() => journal.db.transaction(() => { read(); throw new Error('conflict'); })()).toThrow('conflict');
    journal.close();
    journal = new Journal(file);
    expect(storedParts('msg_read')).toEqual([{ type: 'text', text: current }]);
    expect(storedParts('msg_other')).toEqual([{ type: 'text', text: 'unrelated' }]);
  });

  test('a delta flush costs the same on a 2 MB message as on an empty one', () => {
    journal.putMessage(streaming('msg_big'));
    let index = 0;
    for (; index < 140; index++) journal.setMessagePart('msg_big', index, toolPart(index, 15_000));
    journal.persistMessages();
    expect(storedParts('msg_big').length).toBe(140);
    const started = performance.now();
    for (let round = 0; round < 60; round++) {
      journal.appendDelta('thr_test', 'msg_big', index, `word ${round} `);
      journal.flushDeltas();
      if (round % 10 === 9) journal.setMessagePart('msg_big', ++index, toolPart(index, 15_000));
    }
    const perFlush = (performance.now() - started) / 60;
    // A whole-row rewrite of 2 MB took 20 to 50 ms per flush on a Ryzen 9800X3D.
    expect(perFlush).toBeLessThan(2);
    const parts = journal.getMessage('msg_big')?.parts ?? [];
    expect(parts.length).toBe(index + 1);
  });

  test('a reload mid-stream returns every part written so far', () => {
    journal.putMessage(streaming('msg_live'));
    journal.appendDelta('thr_test', 'msg_live', 0, 'hello ');
    journal.flushDeltas();
    journal.setMessagePart('msg_live', 1, toolPart(1, 10));
    journal.appendDelta('thr_test', 'msg_live', 2, 'after');
    const page = journal.listMessagePage('thr_test', { limit: 10 }).messages;
    expect(page[0]?.parts.map((part) => part.type)).toEqual(['text', 'tool', 'text']);
    expect(page[0]?.parts[2]).toEqual({ type: 'text', text: 'after' });
    // Explicit persistence also makes the current parts available to raw SQL readers.
    journal.persistMessages();
    expect(storedParts('msg_live').length).toBe(3);
  });

  test('completing a message writes its parts and forgets it', () => {
    journal.putMessage(streaming('msg_done'));
    journal.appendDelta('thr_test', 'msg_done', 0, 'final answer');
    journal.flushDeltas();
    journal.setMessageState('msg_done', 'complete');
    expect(storedParts('msg_done')).toEqual([{ type: 'text', text: 'final answer' }]);
    // A later write to a completed message goes straight to its row.
    journal.setMessagePart('msg_done', 1, { type: 'error', message: 'late' });
    expect(storedParts('msg_done').length).toBe(2);
  });

  test('the parts reach the row on their own within the persist window', async () => {
    journal.putMessage(streaming('msg_timer'));
    journal.appendDelta('thr_test', 'msg_timer', 0, 'streamed');
    journal.flushDeltas();
    expect(storedParts('msg_timer')).toEqual([]);
    await Bun.sleep(700);
    expect(storedParts('msg_timer')).toEqual([{ type: 'text', text: 'streamed' }]);
  });

  test('closing the journal keeps what was streamed', () => {
    journal.putMessage(streaming('msg_close'));
    journal.appendDelta('thr_test', 'msg_close', 0, 'kept');
    journal.close();
    journal = new Journal(file);
    expect(journal.getMessage('msg_close')?.parts).toEqual([{ type: 'text', text: 'kept' }]);
  });

  test('releasing a turn writes and forgets the messages a driver left open', () => {
    journal.putMessage(streaming('msg_open', 'trn_a'));
    journal.putMessage(streaming('msg_other', 'trn_b'));
    journal.appendDelta('thr_test', 'msg_open', 0, 'left open');
    journal.appendDelta('thr_test', 'msg_other', 0, 'still going');
    journal.flushDeltas();
    journal.releaseTurn('trn_a');
    expect(storedParts('msg_open')).toEqual([{ type: 'text', text: 'left open' }]);
    expect(storedParts('msg_other')).toEqual([]);
  });

  test('a failed write of streaming parts is tried again, not forgotten', async () => {
    journal.putMessage(streaming('msg_retry'));
    journal.appendDelta('thr_test', 'msg_retry', 0, 'must land');
    journal.flushDeltas();
    journal.db.exec(FAIL_WRITES);
    expect(() => journal.persistMessages()).toThrow('forced');
    journal.db.exec(PASS_WRITES);
    journal.persistMessages();
    expect(storedParts('msg_retry')).toEqual([{ type: 'text', text: 'must land' }]);

    const errors: string[] = [];
    journal.close();
    journal = new Journal(file, { onError: (message) => errors.push(message) });
    journal.putMessage(streaming('msg_background_retry'));
    journal.appendDelta('thr_test', 'msg_background_retry', 0, 'quiet stream');
    journal.flushDeltas();
    journal.db.exec(FAIL_WRITES);
    try {
      const deadline = performance.now() + 2_000;
      while (errors.length === 0 && performance.now() < deadline) await Bun.sleep(25);
      expect(errors.some((message) => message.includes('journal message write: forced'))).toBe(true);
      expect(storedParts('msg_background_retry')).toEqual([]);
    } finally { journal.db.exec(PASS_WRITES); }

    // Only transcript reads follow recovery: an idle stream must persist without another mutation.
    const deadline = performance.now() + 2_500;
    while (storedParts('msg_background_retry').length === 0 && performance.now() < deadline) {
      expect(journal.listMessagePage('thr_test', { limit: 10 }).messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'quiet stream' }]);
      await Bun.sleep(25);
    }
    expect(storedParts('msg_background_retry')).toEqual([{ type: 'text', text: 'quiet stream' }]);
  });

  test('a write that an outer transaction rolls back does not lose the streamed parts', () => {
    journal.putMessage(streaming('msg_rolled', 'trn_a'));
    journal.appendDelta('thr_test', 'msg_rolled', 0, 'streamed answer');
    journal.flushDeltas();
    // Another turn is read inside a caller's transaction, which then rolls back.
    expect(() =>
      journal.db.transaction(() => {
        Array.from(journal.walkTurnMessages('thr_other', 'trn_other'));
        throw new Error('conflict');
      })(),
    ).toThrow('conflict');
    expect(storedParts('msg_rolled')).toEqual([]);
    journal.setMessageState('msg_rolled', 'complete');
    expect(storedParts('msg_rolled')).toEqual([{ type: 'text', text: 'streamed answer' }]);
  });

  test('releasing a turn after a rolled-back write keeps the streamed parts', () => {
    journal.putMessage(streaming('msg_left', 'trn_a'));
    journal.appendDelta('thr_test', 'msg_left', 0, 'left open');
    journal.flushDeltas();
    expect(() =>
      journal.db.transaction(() => {
        journal.persistMessages();
        throw new Error('conflict');
      })(),
    ).toThrow('conflict');
    journal.releaseTurn('trn_a');
    expect(storedParts('msg_left')).toEqual([{ type: 'text', text: 'left open' }]);
  });

  test('a rolled-back write is written again by the timer', async () => {
    journal.putMessage(streaming('msg_again'));
    journal.appendDelta('thr_test', 'msg_again', 0, 'kept');
    journal.flushDeltas();
    expect(() =>
      journal.db.transaction(() => {
        journal.persistMessages();
        throw new Error('conflict');
      })(),
    ).toThrow('conflict');
    expect(storedParts('msg_again')).toEqual([]);
    await Bun.sleep(700);
    expect(storedParts('msg_again')).toEqual([{ type: 'text', text: 'kept' }]);
  });

  test('a streaming write stores only the changed parts beside the row, and the row is written whole on release', () => {
    const writes = countWrites();
    journal.putMessage(streaming('msg_side', 'trn_a'));
    for (let index = 0; index < 20; index++) journal.setMessagePart('msg_side', index, toolPart(index, 8_000));
    journal.appendDelta('thr_test', 'msg_side', 20, 'first');
    journal.flushDeltas();
    journal.persistMessages();
    expect(writes()).toEqual({ rows: 0, side: 21 });
    expect(rowParts('msg_side')).toEqual([]);
    journal.appendDelta('thr_test', 'msg_side', 20, ' second');
    journal.flushDeltas();
    journal.persistMessages();
    // One growing text part is one side row, not a rewrite of the 160 KB row.
    expect(writes()).toEqual({ rows: 0, side: 22 });
    expect(storedParts('msg_side')[20]).toEqual({ type: 'text', text: 'first second' });
    journal.releaseTurn('trn_a');
    expect(writes().rows).toBe(1);
    expect(rowParts('msg_side')).toHaveLength(21);
    expect(rowParts('msg_side')[20]).toEqual({ type: 'text', text: 'first second' });
    expect(journal.db.query('SELECT count(*) AS n FROM streaming_parts').get()).toEqual({ n: 0 });
  });

  test('the row of a message streaming for 30 seconds is written whole', () => {
    try {
      journal.putMessage(streaming('msg_long'));
      journal.appendDelta('thr_test', 'msg_long', 0, 'early');
      journal.flushDeltas();
      journal.persistMessages();
      expect(rowParts('msg_long')).toEqual([]);
      setSystemTime(new Date(Date.now() + 31_000));
      journal.appendDelta('thr_test', 'msg_long', 0, ' late');
      journal.flushDeltas();
      journal.persistMessages();
      expect(rowParts('msg_long')).toEqual([{ type: 'text', text: 'early late' }]);
      expect(journal.db.query('SELECT count(*) AS n FROM streaming_parts').get()).toEqual({ n: 0 });
    } finally { setSystemTime(); }
  });

  test('parts a stopped core left beside the row are folded into it at startup', () => {
    journal.putMessage(streaming('msg_crash'));
    journal.setMessagePart('msg_crash', 0, toolPart(0, 40_000));
    journal.appendDelta('thr_test', 'msg_crash', 1, 'before the crash');
    journal.flushDeltas();
    journal.persistMessages();
    expect(rowParts('msg_crash')).toEqual([]);
    // A killed core never runs close(): its memory copy is simply gone.
    (journal as unknown as { stream: { clear(): void } }).stream.clear();
    journal.close();
    journal = new Journal(file);
    expect(rowParts('msg_crash')).toHaveLength(2);
    expect(journal.getMessage('msg_crash')?.parts).toEqual([toolPart(0, 40_000), { type: 'text', text: 'before the crash' }]);
    expect(journal.db.query('SELECT count(*) AS n FROM streaming_parts').get()).toEqual({ n: 0 });
  });

  test('deleting, truncating and staging a thread leave no streamed parts behind', () => {
    journal.putMessage(streaming('msg_gone'));
    journal.putMessage({ ...streaming('msg_staged'), threadId: 'thr_staged' });
    journal.appendDelta('thr_test', 'msg_gone', 0, 'gone');
    journal.appendDelta('thr_staged', 'msg_staged', 0, 'kept for a restore');
    journal.flushDeltas();
    journal.persistMessages();
    journal.truncateMessages('thr_test', journal.messageRowid('thr_test', 'msg_gone')!);
    expect(journal.db.query("SELECT count(*) AS n FROM streaming_parts WHERE message_id = 'msg_gone'").get()).toEqual({ n: 0 });
    journal.stageThreadDeletion('thr_staged', [{ id: 'thr_staged', archived: false } as Parameters<Journal['stageThreadDeletion']>[1][number]]);
    expect(rowParts('msg_staged')).toEqual([{ type: 'text', text: 'kept for a restore' }]);
    journal.putMessage({ ...streaming('msg_deleted'), threadId: 'thr_deleted' });
    journal.appendDelta('thr_deleted', 'msg_deleted', 0, 'deleted');
    journal.flushDeltas();
    journal.persistMessages();
    journal.deleteThreads(['thr_deleted']);
    expect(journal.db.query('SELECT count(*) AS n FROM streaming_parts').get()).toEqual({ n: 0 });
  });

  test('a part sent again unchanged writes nothing', () => {
    const writes = countWrites();
    journal.putMessage(streaming('msg_same'));
    journal.setMessagePart('msg_same', 0, toolPart(0, 100));
    journal.persistMessages();
    expect(writes()).toEqual({ rows: 0, side: 1 });
    journal.setMessagePart('msg_same', 0, toolPart(0, 100));
    journal.persistMessages();
    expect(writes()).toEqual({ rows: 0, side: 1 });
    journal.setMessageState('msg_same', 'complete');
    expect(writes().rows).toBe(1);
    // A completed message is not rewritten either.
    journal.setMessagePart('msg_same', 0, toolPart(0, 100));
    expect(writes().rows).toBe(1);
    journal.setMessagePart('msg_same', 0, { ...toolPart(0, 100), summary: 'Read f0' } as MessagePart);
    expect(writes().rows).toBe(2);
  });

  test('a large part is compared by its fields: one changed character of an output of the same length is written', () => {
    const output = 'x'.repeat(1 << 20);
    const part = (text: string, extra = {}) => ({ type: 'tool', toolId: 't', name: 'Bash', input: {}, output: text, status: 'done', ...extra }) as MessagePart;
    journal.putMessage(streaming('msg_big'));
    journal.setMessagePart('msg_big', 0, part(output));
    journal.persistMessages();
    const writes = countWrites();
    // Equal copies, not the same object: nothing to write.
    journal.setMessagePart('msg_big', 0, part(output.split('').join('')));
    journal.persistMessages();
    expect(writes()).toEqual({ rows: 0, side: 0 });
    journal.setMessagePart('msg_big', 0, part(`${output.slice(0, -1)}y`));
    journal.persistMessages();
    expect(writes()).toEqual({ rows: 0, side: 1 });
    journal.setMessagePart('msg_big', 0, part(`${output.slice(0, -1)}y`, { summary: 'ran' }));
    journal.persistMessages();
    expect(writes()).toEqual({ rows: 0, side: 2 });
    expect(journal.streamingMessage('msg_big')?.parts[0]).toEqual(part(`${output.slice(0, -1)}y`, { summary: 'ran' }));
  });

  test('schema 35 adds streaming_parts and drops the background index its longer siblings cover', () => {
    journal.db.exec(`DROP TABLE streaming_parts;
      CREATE INDEX background_observations_thread ON background_observations(thread_id);
      PRAGMA user_version = 34;`);
    journal.close();
    journal = new Journal(file);
    const names = (journal.db.query("SELECT name FROM sqlite_master WHERE name IN ('streaming_parts', 'background_observations_thread')").all() as { name: string }[]).map(row => row.name);
    expect(names).toEqual(['streaming_parts']);
  });

  test('streamed text writes no message.delta event', () => {
    journal.putMessage(streaming('msg_events'));
    for (let i = 0; i < 5; i++) {
      journal.appendDelta('thr_test', 'msg_events', 0, `${i}`);
      journal.flushDeltas();
    }
    expect(journal.countEvents('message.delta')).toBe(0);
  });

  test('a failing flush from the timer is reported, not thrown, and retried', async () => {
    const errors: string[] = [];
    journal.close();
    journal = new Journal(file, { onError: (message) => errors.push(message) });
    // A completed message is written straight to its row, so a trigger can make that write fail.
    journal.putMessage({ ...streaming('msg_fail'), state: 'complete' });
    journal.db.exec("CREATE TRIGGER fail_parts BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'forced'); END");
    journal.appendDelta('thr_test', 'msg_fail', 0, 'kept ');
    await Bun.sleep(60);
    expect(errors.some((message) => message.includes('forced'))).toBe(true);
    journal.db.exec('DROP TRIGGER fail_parts');
    journal.appendDelta('thr_test', 'msg_fail', 0, 'after');
    await Bun.sleep(60);
    expect(storedParts('msg_fail')).toEqual([{ type: 'text', text: 'kept after' }]);
  });
});
