import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, MessagePart } from '@boite/contracts';
import { Journal } from '../src/journal.ts';
import { nativeAgents } from '../src/native-agents.ts';

let dir: string, file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boite-native-agents-')); file = join(dir, 'journal.db'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tool = (name: string, toolId: string): MessagePart => ({ type: 'tool', toolId, name, input: { prompt: 'Review parsing' }, output: 'Checked', status: 'done' });
const message = (id: string, parts: MessagePart[]): Message => ({ id, threadId: 'thr_a', turnId: 'trn_a', role: 'assistant', parts, state: 'complete', createdAt: 1 });

test('a journal written before the native agent index finds its agent calls once migrated', () => {
  const old = new Journal(file);
  old.putTurn({ id: 'trn_a', threadId: 'thr_a', status: 'done', queuedAt: 1, startedAt: 1, finishedAt: 2, usage: null, error: null });
  old.putMessage(message('msg_shell', [tool('Bash', 'shell')]));
  old.putMessage(message('msg_agent', [{ type: 'text', text: 'Delegating' }, tool('task', 'review')]));
  expect(nativeAgents(old, 'thr_a').map(agent => agent.id)).toEqual(['trn_a:review']);
  // What schema 30 left on disk: the same rows, without the table.
  old.db.exec('DROP TABLE native_agent_messages; PRAGMA user_version = 30');
  old.close();

  const migrated = new Journal(file);
  try {
    expect(migrated.db.query('SELECT message_id, thread_id FROM native_agent_messages').all()).toEqual([{ message_id: 'msg_agent', thread_id: 'thr_a' }]);
    expect(nativeAgents(migrated, 'thr_a').map(agent => [agent.id, agent.task])).toEqual([['trn_a:review', 'Review parsing']]);
    // A rewind that removes the message takes its entry with it.
    migrated.truncateMessages('thr_a', migrated.messageRowid('thr_a', 'msg_agent')!);
    expect(migrated.db.query('SELECT COUNT(*) AS count FROM native_agent_messages').get()).toEqual({ count: 0 });
    expect(nativeAgents(migrated, 'thr_a')).toEqual([]);
  } finally { migrated.close(); }
});
