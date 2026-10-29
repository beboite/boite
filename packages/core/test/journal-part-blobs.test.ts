import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_OUTPUT_PREVIEW_CHARS, previewToolOutputs, type Message, type MessagePart } from '@boite/contracts';
import { Journal } from '../src/journal.ts';
import { SCHEMA_VERSION } from '../src/journal/schema.ts';
import { BLOB_MIN_CHARS, moveInlineOutputs, moveInlineValues, previewDigests, recodePartBlobs } from '../src/journal/part-blobs.ts';
import { compactAll, schema36Journal } from './fixtures/journal-schema36.ts';

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

test('a part changed beside an unchanged screenshot keeps its stored value in place', () => {
  journal.putMessage({ id: 'msg_a', threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts: [], state: 'streaming', createdAt: 1 });
  journal.setMessagePart('msg_a', 0, read(0));
  journal.persistMessages();
  const first = blobRows();
  expect(first).toHaveLength(1);
  // A tool summary arrives after the part was written: same output, one more small field.
  journal.setMessagePart('msg_a', 0, { ...read(0), summary: 'Read 0.png' });
  journal.persistMessages();
  expect(blobRows()).toEqual(first);
  journal.setMessageState('msg_a', 'complete');
  journal.setMessagePart('msg_a', 0, { ...read(0), summary: 'Read the first screenshot' });
  expect(blobRows()).toEqual(first);
  expect(journal.getMessage('msg_a')?.parts).toEqual([{ ...read(0), summary: 'Read the first screenshot' }]);
  // A changed value is written again.
  journal.setMessagePart('msg_a', 0, read(1));
  expect(blobRows()).not.toEqual(first);
  expect(journal.getMessage('msg_a')?.parts).toEqual([read(1)]);
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

test('a row written before part_blobs moves its large values out once, and reads the same', async () => {
  const insert = journal.db.query("INSERT INTO messages (id, thread_id, turn_id, role, parts, state, created_at) VALUES (?, 'thr_a', 'trn_a', 'assistant', ?, 'complete', 1)");
  const old: MessagePart[] = [read(0), { type: 'text', text: 'small' }, read(1)];
  insert.run('old', JSON.stringify(old));
  insert.run('small', JSON.stringify([{ type: 'text', text: 'hello' }]));
  journal.putMessage({ id: 'new', threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts: [read(2)], state: 'complete', createdAt: 1 });
  const newBlobs = blobRows();
  const isOpen = () => false;
  // A message still streaming waits for a later pass.
  expect(await moveInlineValues(journal.db, 0, () => true)).toBe(-1);
  expect(journal.db.query("SELECT parts FROM messages WHERE id = 'old'").get()).toEqual({ parts: JSON.stringify(old) });

  const first = (await moveInlineValues(journal.db, 0, isOpen))!;
  expect(first).toBe(journal.messageRowid('thr_a', 'old')!);
  expect(rowBytes('old')).toBeLessThan(2_000);
  expect(journal.getMessage('old')?.parts).toEqual(old);
  // Rows in the new shape are small and never picked; nothing is left.
  expect(await moveInlineValues(journal.db, first, isOpen)).toBeNull();
  expect(blobRows().filter(row => (row as { messageId: string }).messageId === 'new')).toEqual(newBlobs);
});

const codecs = () => journal.db.query(`SELECT message_id AS messageId, part_index AS partIndex, field, codec, typeof(data) AS type, preview IS NOT NULL AS preview, chars
  FROM part_blobs ORDER BY message_id, part_index, field`).all();
const toolPart = (output: string, status: 'done' | 'running' = 'done'): Extract<MessagePart, { type: 'tool' }> =>
  ({ type: 'tool', toolId: `t-${output.length}`, name: 'Bash', input: { command: 'ls' }, inputText: '{"command":"ls"}', output, status });

test('values are stored compressed or as text, and every read path gives them back whole', () => {
  const image: MessagePart = { type: 'image', mimeType: 'image/png', data: screenshot(9), alt: null };
  const parts: MessagePart[] = [read(0), image, { ...read(1), status: 'running' }];
  journal.putMessage({ id: 'msg_a', threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts, state: 'complete', createdAt: 1 });
  expect(codecs()).toEqual([
    { messageId: 'msg_a', partIndex: 0, field: 'output', codec: 1, type: 'blob', preview: 1, chars: screenshot(0).length },
    { messageId: 'msg_a', partIndex: 1, field: 'data', codec: 1, type: 'blob', preview: 0, chars: screenshot(9).length },
    { messageId: 'msg_a', partIndex: 2, field: 'output', codec: 1, type: 'blob', preview: 1, chars: screenshot(1).length },
  ]);
  const bytes = (journal.db.query('SELECT SUM(length(data)) AS n FROM part_blobs').get() as { n: number }).n;
  expect(bytes).toBeLessThan(screenshot(0).length / 10);

  const everyRead = (id: string) => {
    expect(journal.getMessage(id)?.parts).toEqual(parts);
    const page = journal.listMessagePage('thr_a', { limit: 10, toolPreviews: true }).messages.find(message => message.id === id)!;
    // A finished output reads as its preview, a running one whole, an image whole.
    expect(page.parts).toEqual([{ ...read(0), output: screenshot(0).slice(0, TOOL_OUTPUT_PREVIEW_CHARS), outputDeferred: true }, image, parts[2]!]);
    expect(journal.messagePart(id, 0)?.part).toEqual(parts[0]);
    expect(journal.messagePart(id, 1)?.part).toEqual(image);
  };
  everyRead('msg_a');
  // A value stored as text, as before schema 37, reads the same everywhere.
  for (const [index, value] of [[0, screenshot(0)], [1, screenshot(9)], [2, screenshot(1)]] as const) {
    journal.db.query('UPDATE part_blobs SET data = ?, codec = 0, preview = NULL, chars = NULL WHERE message_id = ? AND part_index = ?').run(value, 'msg_a', index);
  }
  everyRead('msg_a');
  // A copy keeps each value as it is stored.
  journal.db.query("UPDATE part_blobs SET data = ?, codec = 1, preview = ?, chars = ? WHERE message_id = 'msg_a' AND part_index = 0")
    .run(Bun.zstdCompressSync(Buffer.from(screenshot(0))), screenshot(0).slice(0, TOOL_OUTPUT_PREVIEW_CHARS), screenshot(0).length);
  journal.copyMessage('msg_a', { id: 'msg_b', threadId: 'thr_a', turnId: 'trn_b', state: 'complete' });
  expect((codecs() as { messageId: string; codec: number }[]).filter(row => row.messageId === 'msg_b').map(row => row.codec)).toEqual([1, 0, 0]);
  everyRead('msg_b');
});

test('a tool output moves out from 4 KiB, and a page reads it whole up to the inline size', () => {
  const small = toolPart('x'.repeat(3_000)), medium = toolPart('medium output line\n'.repeat(300)), large = toolPart('large output line\n'.repeat(1_200));
  journal.putMessage({ id: 'msg_a', threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts: [small, medium, large], state: 'complete', createdAt: 1 });
  expect((codecs() as { partIndex: number; field: string }[]).map(row => [row.partIndex, row.field])).toEqual([[1, 'output'], [2, 'output']]);
  expect(rowBytes('msg_a')).toBeLessThan(4_000);
  expect(journal.getMessage('msg_a')?.parts).toEqual([small, medium, large]);
  // Under `TOOL_OUTPUT_INLINE_CHARS` the page carries the output as an inline one would be; past it, the preview.
  const page = journal.listMessagePage('thr_a', { limit: 10, toolPreviews: true }).messages[0]!;
  expect(page.parts).toEqual([small, medium, { ...large, output: large.output!.slice(0, TOOL_OUTPUT_PREVIEW_CHARS), outputDeferred: true }]);
  expect(previewToolOutputs([page])).toEqual(previewToolOutputs([{ ...page, parts: [small, medium, large] }]));
});

test('a schema 36 journal reads the same before and after the background passes, which compress and move its values', async () => {
  journal.close();
  const file = join(dir, 'old.db');
  const old = schema36Journal(file);
  const big = read(0), medium = toolPart('medium output line\n'.repeat(300)), large = toolPart('large output line\n'.repeat(1_200));
  // The values of 32 KiB and more in part_blobs as text, smaller outputs inline.
  old.query("INSERT INTO part_blobs (message_id, part_index, field, thread_id, data, digest) VALUES ('old_a', 0, 'output', 'thr_a', ?, ?)")
    .run(big.output, Bun.hash(big.output!).toString(36));
  const insert = old.query("INSERT INTO messages (id, thread_id, turn_id, role, parts, state, created_at) VALUES (?, 'thr_a', 'trn_a', 'assistant', ?, 'complete', 1)");
  insert.run('old_a', JSON.stringify([{ ...big, output: '', $blob: ['output'] }, { type: 'text', text: 'done' }]));
  insert.run('old_b', JSON.stringify([medium, { type: 'text', text: 'between' }, large]));
  old.close();

  journal = new Journal(file);
  expect(journal.schema).toEqual({ from: 36, to: SCHEMA_VERSION });
  const before = journal.listMessages('thr_a');
  const pageBefore = journal.listMessagePage('thr_a', { limit: 10, toolPreviews: true }).messages;
  const proofBefore = previewDigests.get(pageBefore[0]!.parts[0]!);
  expect(before.map(message => message.parts)).toEqual([[big, { type: 'text', text: 'done' }], [medium, { type: 'text', text: 'between' }, large]]);
  expect(codecs()).toEqual([{ messageId: 'old_a', partIndex: 0, field: 'output', codec: 0, type: 'text', preview: 0, chars: null }]);

  await compactAll(journal);
  expect((codecs() as { messageId: string; partIndex: number; codec: number }[]).map(row => [row.messageId, row.partIndex, row.codec]))
    .toEqual([['old_a', 0, 1], ['old_b', 0, 1], ['old_b', 2, 1]]);
  expect(rowBytes('old_b')).toBeLessThan(2_000);
  expect(journal.listMessages('thr_a')).toEqual(before);
  const pageAfter = journal.listMessagePage('thr_a', { limit: 10, toolPreviews: true }).messages;
  expect(previewToolOutputs(pageAfter)).toEqual(previewToolOutputs(pageBefore));
  // The digest of the whole output is unchanged, and with it a resume proof.
  expect(previewDigests.get(pageAfter[0]!.parts[0]!)).toBe(proofBefore!);
  // Finished: a second run finds nothing to do.
  expect(await compactAll(journal)).toBe(0);
});

test('a message written while its values were compressed keeps that write, and the next pass moves the new values', async () => {
  const insert = journal.db.query("INSERT INTO messages (id, thread_id, turn_id, role, parts, state, created_at) VALUES ('msg_a', 'thr_a', 'trn_a', 'assistant', ?, 'complete', 1)");
  const first = toolPart('first output line\n'.repeat(400)), second = toolPart('second output line\n'.repeat(400));
  insert.run(JSON.stringify([first]));
  const pass = moveInlineOutputs(journal.db, 0, 1024 * 1024, () => false);
  // The pass awaits the thread pool; a core of the previous version rewrites the row meanwhile.
  journal.db.query("UPDATE messages SET parts = ? WHERE id = 'msg_a'").run(JSON.stringify([second]));
  expect(await pass).toBe(0);
  expect(journal.getMessage('msg_a')?.parts).toEqual([second]);
  expect(codecs()).toEqual([]);
  expect(await moveInlineOutputs(journal.db, 0, 1024 * 1024, () => false)).toBe(journal.messageRowid('thr_a', 'msg_a')!);
  expect(journal.getMessage('msg_a')?.parts).toEqual([second]);
  expect(codecs()).toHaveLength(1);
});

test('a journal closed while its values were compressed ends the pass without touching it', async () => {
  journal.db.query("INSERT INTO messages (id, thread_id, turn_id, role, parts, state, created_at) VALUES ('msg_a', 'thr_a', 'trn_a', 'assistant', ?, 'complete', 1)")
    .run(JSON.stringify([toolPart('closing output line\n'.repeat(400))]));
  // As the retention ticks pass it: a closed journal counts as an open message.
  const pass = moveInlineOutputs(journal.db, 0, 1024 * 1024, () => journal.isClosed());
  journal.close();
  // The cursor stays before the row, which the next start moves.
  expect(await pass).toBe(0);
});

test('a value that starts with a byte order mark keeps it, compressed or recoded', async () => {
  const output = `﻿${'BOM output line\n'.repeat(400)}`;
  const stored = () => (journal.getMessage('msg_a')?.parts[0] as { output: string }).output;
  journal.putMessage({ id: 'msg_a', threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts: [toolPart(output)], state: 'complete', createdAt: 1 });
  expect((codecs() as { codec: number }[]).map(row => row.codec)).toEqual([1]);
  expect(stored()).toBe(output);
  // Stored as text, as a value that does not compress is, it reads and is recoded the same.
  journal.db.query("UPDATE part_blobs SET data = CAST(? AS TEXT), codec = 0, preview = NULL, chars = NULL WHERE message_id = 'msg_a'").run(Buffer.from(output));
  expect(stored()).toBe(output);
  expect(await recodePartBlobs(journal.db, 0, 1024 * 1024)).toBeGreaterThan(0);
  expect((codecs() as { codec: number }[]).map(row => row.codec)).toEqual([1]);
  expect(stored()).toBe(output);
});

test('a message deleted while its values were compressed is never written into the copy that got its rowid', async () => {
  const insert = journal.db.query("INSERT INTO messages (id, thread_id, turn_id, role, parts, state, created_at) VALUES (?, ?, 'trn_a', 'assistant', ?, 'complete', 1)");
  const output = toolPart('shared output line\n'.repeat(400));
  insert.run('older', 'thr_kept', JSON.stringify([output]));
  insert.run('newer', 'thr_gone', JSON.stringify([output]));
  const newer = journal.messageRowid('thr_gone', 'newer')!;
  // The pass picks `newer` and awaits the thread pool; meanwhile its thread goes and a fork of `older`, same parts, takes its rowid.
  const pass = moveInlineOutputs(journal.db, journal.messageRowid('thr_kept', 'older')!, 1024 * 1024, () => false);
  journal.deleteThreads(['thr_gone']);
  journal.copyMessage('older', { id: 'fork', threadId: 'thr_fork', turnId: 'trn_f', state: 'complete' });
  expect(journal.messageRowid('thr_fork', 'fork')).toBe(newer);
  await pass;
  expect(journal.getMessage('fork')?.parts).toEqual([output]);
  expect(journal.db.query("SELECT message_id FROM part_blobs WHERE thread_id = 'thr_gone'").all()).toEqual([]);
});

test('a value UTF-8 cannot hold as it is stays inline, written or moved, and reads back the same', async () => {
  // An unpaired surrogate: JSON keeps it as an escape, UTF-8 would turn it into U+FFFD.
  const output = toolPart(`${'x'.repeat(5_000)}\ud800`);
  journal.putMessage({ id: 'msg_a', threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts: [output], state: 'complete', createdAt: 1 });
  journal.db.query("INSERT INTO messages (id, thread_id, turn_id, role, parts, state, created_at) VALUES ('old', 'thr_a', 'trn_a', 'assistant', ?, 'complete', 2)")
    .run(JSON.stringify([output]));
  await moveInlineOutputs(journal.db, 0, 1024 * 1024, () => false);
  expect(codecs()).toEqual([]);
  for (const id of ['msg_a', 'old']) expect(journal.getMessage(id)?.parts).toEqual([output]);
});
