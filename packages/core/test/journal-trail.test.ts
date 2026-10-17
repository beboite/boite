import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, MessagePart } from '@boite/contracts';
import { Journal } from '../src/journal.ts';
import { pruneEventsOnce } from '../src/journal/retention.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boite-trail-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('a tool output and a published file are stored once, in the message, and no event repeats them', () => {
  const journal = new Journal(join(dir, 'journal.db'));
  try {
    const screenshot = 'iVBORw0KGgo'.repeat(60_000);
    const message: Message = { id: 'msg_a', threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts: [], state: 'complete', createdAt: 1 };
    journal.append({ type: 'message.started', threadId: 'thr_a', version: 1, payload: message }, () => journal.putMessage(message));
    const part: MessagePart = { type: 'tool', toolId: 'read', name: 'Read', input: { file_path: 'shot.png' }, output: screenshot, status: 'done' };
    journal.append({ type: 'message.part', threadId: 'thr_a', version: 1, payload: { messageId: 'msg_a', partIndex: 0, part } }, () => journal.setMessagePart('msg_a', 0, part));
    const file: Message = { ...message, id: 'msg_b', parts: [{ type: 'file', name: 'shot.png', mimeType: 'image/png', data: screenshot }] };
    journal.append({ type: 'artifact.published', threadId: 'thr_a', version: 1, payload: file }, () => journal.putMessage(file));
    // A question is read back at startup and keeps its whole payload.
    const question = { id: 'q', threadId: 'thr_a', async: true, text: 'Which one? '.repeat(200) };
    journal.append({ type: 'question.asked', threadId: 'thr_a', version: 1, payload: question }, () => undefined);

    expect(journal.getMessage('msg_a')?.parts[0]).toMatchObject({ output: screenshot });
    expect(journal.getMessage('msg_b')?.parts[0]).toMatchObject({ data: screenshot });
    const rows = journal.db.query('SELECT type, payload FROM events ORDER BY id').all() as { type: string; payload: string }[];
    expect(rows.map(row => row.type)).toEqual(['message.started', 'question.asked']);
    expect(rows[0]!.payload.length).toBeLessThan(2_000);
    expect(JSON.parse(rows[1]!.payload)).toEqual(question);
  } finally { journal.close(); }
});

test('trail events already stored are kept three days, every other event thirty, walked forward without going back', () => {
  const journal = new Journal(join(dir, 'journal.db'));
  try {
    const day = 86_400_000, now = 100 * day;
    const insert = journal.db.query("INSERT INTO events (thread_id, ts, type, version, payload) VALUES ('thr_a', ?, ?, 1, '{}')");
    const written: [number, string][] = [];
    for (let age = 40; age >= 0; age--) {
      for (const type of ['message.part', 'artifact.published', 'message.started', 'turn.finished']) {
        insert.run(now - age * day, type);
        written.push([age, type]);
      }
    }
    while (pruneEventsOnce(journal, now));
    const left = (journal.db.query('SELECT ts, type FROM events ORDER BY id').all() as { ts: number; type: string }[])
      .map(row => [(now - row.ts) / day, row.type]);
    const trail = ['message.part', 'artifact.published', 'message.started'];
    expect(left).toEqual(written.filter(([age, type]) => trail.includes(type) ? age <= 3 : age <= 30));
    // The next day's pass starts where this one stopped.
    expect(journal.getSetting('events:trail-pruned-through')).toBe(written.findLastIndex(([age]) => age > 3) + 1);
  } finally { journal.close(); }
});
