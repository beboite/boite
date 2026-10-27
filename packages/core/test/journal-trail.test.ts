import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
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

test('a trail event written under an id freed by a deletion is still pruned after three days', () => {
  const journal = new Journal(join(dir, 'journal.db'));
  try {
    const day = 86_400_000, now = 100 * day;
    const insert = journal.db.query('INSERT INTO events (thread_id, ts, type, version, payload) VALUES (?, ?, ?, 1, \'{}\')');
    const trail = () => (journal.db.query("SELECT id FROM events WHERE type = 'message.started' ORDER BY id").all() as { id: number }[]).map(row => row.id);
    for (let id = 1; id <= 5; id++) insert.run('thr_a', now - 10 * day, 'turn.finished');
    // The newest events belong to a thread removed after the walk passed them.
    for (let id = 6; id <= 10; id++) insert.run('thr_b', now - 10 * day, 'turn.finished');
    while (pruneEventsOnce(journal, now));
    expect(journal.getSetting('events:trail-pruned-through')).toBe(10);
    journal.deleteThreads(['thr_b']);
    // SQLite hands ids 6 to 8 out again.
    for (let n = 0; n < 3; n++) insert.run('thr_a', now - day, 'message.started');
    expect(trail()).toEqual([6, 7, 8]);
    while (pruneEventsOnce(journal, now + 3 * day));
    expect(trail()).toEqual([]);

    // The walk itself deleting the newest events leaves the cursor on the last id.
    for (let n = 0; n < 3; n++) insert.run('thr_a', now, 'message.started');
    while (pruneEventsOnce(journal, now + 4 * day));
    expect(journal.getSetting('events:trail-pruned-through')).toBe(5);
    insert.run('thr_a', now + 4 * day, 'message.started');
    while (pruneEventsOnce(journal, now + 8 * day));
    expect(trail()).toEqual([]);
  } finally { journal.close(); }
});

test('opening a journal builds no planner statistics; the retention ticks build them one ANALYZE at a time', () => {
  const journal = new Journal(join(dir, 'journal.db'));
  try {
    for (let n = 0; n < 50; n++) journal.db.query("INSERT INTO events (thread_id, ts, type, version, payload) VALUES ('thr_a', ?, 'turn.finished', 1, '{}')").run(n);
    const stats = () => journal.db.query("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'").get() === null
      ? [] : (journal.db.query('SELECT DISTINCT tbl FROM sqlite_stat1 ORDER BY tbl').all() as { tbl: string }[]).map(row => row.tbl);
    expect(stats()).toEqual([]);
    const pending = journal.staleStatistics(true);
    expect(pending).toContain('ANALYZE "main"."events"');
    expect(pending).not.toContain('ANALYZE "main"."shared_project_outbox"');
    expect(() => journal.analyze('DROP TABLE events')).toThrow('expected an ANALYZE statement');
    for (const statement of pending) journal.analyze(statement);
    expect(stats()).toContain('events');
    // Nothing left stale, after the migration or after a quiet day.
    expect(journal.staleStatistics(true)).toEqual([]);
    expect(journal.staleStatistics()).toEqual([]);
    // An empty outbox cannot retain statistics, but its first row must make it eligible.
    journal.db.query("INSERT INTO shared_project_outbox(contact_id, association_id, data) VALUES ('fixture', 'fixture', '{}')").run();
    // Older system SQLite does not list never-analyzed tables in PRAGMA optimize.
    const query = journal.db.query.bind(journal.db);
    const legacy = spyOn(journal.db, 'query').mockImplementation(sql =>
      query(sql.startsWith('PRAGMA optimize=') ? 'SELECT NULL WHERE 0' : sql));
    let populated: string[];
    try { populated = journal.staleStatistics(true); } finally { legacy.mockRestore(); }
    expect(populated).toContain('ANALYZE "main"."shared_project_outbox"');
    for (const statement of populated) journal.analyze(statement);
    expect(stats()).toContain('shared_project_outbox');
    expect(journal.staleStatistics(true)).toEqual([]);
  } finally { journal.close(); }
});
