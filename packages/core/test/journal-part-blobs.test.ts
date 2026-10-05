import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_OUTPUT_PREVIEW_CHARS, type Message, type MessagePart } from '@boite/contracts';
import { Journal } from '../src/journal.ts';
import { BLOB_MIN_CHARS, moveInlineValues } from '../src/journal/part-blobs.ts';

let dir: string, journal: Journal;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boite-part-blobs-')); journal = new Journal(join(dir, 'journal.db')); });
afterEach(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });

const screenshot = (n: number) => `${n}:${'iVBORw0KGgo'.repeat(BLOB_MIN_CHARS / 8)}`;
const read = (n: number): Extract<MessagePart, { type: 'tool' }> => ({ type: 'tool', toolId: `read-${n}`, name: 'Read', input: { file_path: `${n}.png` }, output: screenshot(n), status: 'done' });
const rowBytes = (id: string) => (journal.db.query('SELECT length(parts) AS n FROM messages WHERE id = ?').get(id) as { n: number }).n;
const blobRows = () => journal.db.query('SELECT rowid, message_id AS messageId, part_index AS partIndex FROM part_blobs ORDER BY rowid').all();

test('a streaming turn of screenshots writes each one once, outside its message row, and reads back whole', () => {
  const message: Message = { id: 'msg_a', threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts: [], state: 'streaming', createdAt: 1 };
  journal.putMessage(message);
  for (let n = 0; n < 3; n++) journal.setMessagePart('msg_a', n, read(n));
  journal.appendDelta('thr_a', 'msg_a', 3, 'Looking');
  journal.persistMessages();
  const first = blobRows();
  expect(first).toHaveLength(3);
  expect(rowBytes('msg_a')).toBeLessThan(2_000);
  // More text later rewrites a small row and none of the screenshots.
  journal.appendDelta('thr_a', 'msg_a', 3, ' at them');
  journal.persistMessages();
  expect(blobRows()).toEqual(first);
  journal.setMessageState('msg_a', 'complete');
  expect(blobRows()).toEqual(first);

  const stored = journal.getMessage('msg_a')!;
  expect(stored.parts).toEqual([read(0), read(1), read(2), { type: 'text', text: 'Looking at them' }]);
  expect(journal.listMessages('thr_a')[0]).toEqual(stored);
  // A page that previews tools reads only the start of each output.
  const page = journal.listMessagePage('thr_a', { limit: 10, toolPreviews: true }).messages[0]!;
  expect(page.parts[1]).toEqual({ ...read(1), output: screenshot(1).slice(0, TOOL_OUTPUT_PREVIEW_CHARS), outputDeferred: true });
  expect(journal.messagePart('msg_a', part => part.type === 'tool' && part.toolId === 'read-2')?.part).toEqual(read(2));

  // A later change to one stored part leaves the other screenshots where they are.
  journal.setMessagePart('msg_a', 0, { ...read(0), output: 'small now' });
  expect(blobRows()).toEqual(first.slice(1));
  expect(journal.getMessage('msg_a')!.parts.slice(0, 2)).toEqual([{ ...read(0), output: 'small now' }, read(1)]);
});

test('copies, rewinds and deletions carry or remove the stored values with their message', () => {
  const message: Message = { id: 'msg_a', threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts: [read(0), read(1)], state: 'complete', createdAt: 1 };
  journal.putMessage(message);
  journal.copyMessage('msg_a', { id: 'msg_b', threadId: 'thr_b', turnId: 'trn_b', state: 'complete' });
  expect(journal.getMessage('msg_b')?.parts).toEqual(message.parts);
  journal.truncateMessages('thr_a', journal.messageRowid('thr_a', 'msg_a')!);
  expect(blobRows().map(row => (row as { messageId: string }).messageId)).toEqual(['msg_b', 'msg_b']);
  journal.deleteThreads(['thr_b']);
  expect(blobRows()).toEqual([]);
});

test('a row written before part_blobs keeps its values inline and reads as it was', () => {
  const parts = [read(0)];
  journal.db.query("INSERT INTO messages (id, thread_id, turn_id, role, parts, state, created_at) VALUES ('old', 'thr_a', 'trn_a', 'assistant', ?, 'complete', 1)")
    .run(JSON.stringify(parts));
  expect(journal.getMessage('old')?.parts).toEqual(parts);
  expect(journal.listMessagePage('thr_a', { limit: 10, toolPreviews: true }).messages[0]?.parts).toEqual(parts);
  expect(blobRows()).toEqual([]);
});

test('a row written before part_blobs moves its large values out once, and reads the same', () => {
  const insert = journal.db.query("INSERT INTO messages (id, thread_id, turn_id, role, parts, state, created_at) VALUES (?, 'thr_a', 'trn_a', 'assistant', ?, 'complete', 1)");
  const old: MessagePart[] = [read(0), { type: 'text', text: 'small' }, read(1)];
  insert.run('old', JSON.stringify(old));
  insert.run('small', JSON.stringify([{ type: 'text', text: 'hello' }]));
  journal.putMessage({ id: 'new', threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts: [read(2)], state: 'complete', createdAt: 1 });
  const newBlobs = blobRows();
  const isOpen = () => false;
  // A message still streaming waits for a later pass.
  expect(moveInlineValues(journal.db, 0, () => true)).toBe(-1);
  expect(journal.db.query("SELECT parts FROM messages WHERE id = 'old'").get()).toEqual({ parts: JSON.stringify(old) });

  const first = moveInlineValues(journal.db, 0, isOpen)!;
  expect(first).toBe(journal.messageRowid('thr_a', 'old')!);
  expect(rowBytes('old')).toBeLessThan(2_000);
  expect(journal.getMessage('old')?.parts).toEqual(old);
  // Rows in the new shape are small and never picked; nothing is left.
  expect(moveInlineValues(journal.db, first, isOpen)).toBeNull();
  expect(blobRows().filter(row => (row as { messageId: string }).messageId === 'new')).toEqual(newBlobs);
});
