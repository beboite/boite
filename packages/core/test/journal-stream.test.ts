import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

function storedParts(messageId: string): MessagePart[] {
  const row = journal.db.query('SELECT parts FROM messages WHERE id = ?').get(messageId) as { parts: string };
  return JSON.parse(row.parts) as MessagePart[];
}

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
    // The row itself caught up, so raw SQL readers see it too.
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

  test('a failed write of streaming parts is tried again, not forgotten', () => {
    journal.putMessage(streaming('msg_retry'));
    journal.appendDelta('thr_test', 'msg_retry', 0, 'must land');
    journal.flushDeltas();
    journal.db.exec("CREATE TRIGGER fail_parts BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'forced'); END");
    expect(() => journal.persistMessages()).toThrow('forced');
    journal.db.exec('DROP TRIGGER fail_parts');
    journal.persistMessages();
    expect(storedParts('msg_retry')).toEqual([{ type: 'text', text: 'must land' }]);
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
