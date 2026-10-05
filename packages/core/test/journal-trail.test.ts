import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, MessagePart } from '@boite/contracts';
import { Journal } from '../src/journal.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boite-trail-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('a tool output and a published file are stored once, in the message, not again in the event trail', () => {
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
    expect(rows.map(row => row.type)).toEqual(['message.started', 'message.part', 'artifact.published', 'question.asked']);
    for (const row of rows.slice(0, 3)) expect(row.payload.length).toBeLessThan(2_000);
    expect(JSON.parse(rows[1]!.payload)).toMatchObject({ messageId: 'msg_a', partIndex: 0, part: { type: 'tool', name: 'Read', status: 'done' } });
    expect(JSON.parse(rows[3]!.payload)).toEqual(question);
  } finally { journal.close(); }
});
