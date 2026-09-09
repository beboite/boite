import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MESSAGE_PAGE, MESSAGE_PAGE_MAX } from '@boite/contracts';
import type { Message } from '@boite/contracts';
import { echoThread, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

/** `count` complete messages written straight into the journal, in order. */
function seed(threadId: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const message: Message = {
      id: `msg_${String(index).padStart(4, '0')}`,
      threadId,
      turnId: 'trn_seed',
      role: index % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `message ${index}` }],
      state: 'complete',
      createdAt: 1_000 + index,
    };
    harness.core.journal.putMessage(message);
  }
}

function ids(messages: Message[]): string[] {
  return messages.map((message) => message.id);
}

describe('message paging', () => {
  test('threads.get hands back the last page and the cursor above it', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId, 300);

    const thread = await client.call('threads.get', { threadId });

    expect(thread.messages).toHaveLength(MESSAGE_PAGE);
    expect(ids(thread.messages).at(0)).toBe('msg_0180');
    expect(ids(thread.messages).at(-1)).toBe('msg_0299');
    expect(thread.messagesBefore).toBe('msg_0180');
  });

  test('a thread shorter than a page comes whole, with no cursor', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId, 12);

    const thread = await client.call('threads.get', { threadId });

    expect(thread.messages).toHaveLength(12);
    expect(thread.messagesBefore).toBeNull();
  });

  test('messages.list walks back to the first message, oldest first, without a gap', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId, 300);

    const thread = await client.call('threads.get', { threadId });
    const walked: string[] = [...ids(thread.messages)];
    const counts: number[] = [thread.messages.length];
    let cursor = thread.messagesBefore;
    let pages = 0;

    while (cursor !== null) {
      const page = await client.call('messages.list', { threadId, before: cursor });
      // Oldest first inside the page, and it stops right where the window starts.
      const newest = ids(page.messages).at(-1) ?? '';
      const oldestHeld = walked[0] ?? '';
      expect(newest < oldestHeld).toBe(true);
      walked.unshift(...ids(page.messages));
      counts.unshift(page.messages.length);
      cursor = page.before;
      pages += 1;
      if (pages > 10) throw new Error('the cursor never reached the first message');
    }

    expect(pages).toBe(2);
    expect(counts).toEqual([60, 120, 120]);
    expect(walked).toHaveLength(300);
    expect(new Set(walked).size).toBe(300);
    expect(walked[0]).toBe('msg_0000');
    expect(walked.at(-1)).toBe('msg_0299');
    expect(walked).toEqual([...walked].sort());
  });

  test('a limit is honoured and never exceeds the maximum', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId, 300);

    const small = await client.call('messages.list', { threadId, before: 'msg_0299', limit: 5 });
    expect(ids(small.messages)).toEqual([
      'msg_0294',
      'msg_0295',
      'msg_0296',
      'msg_0297',
      'msg_0298',
    ]);
    expect(small.before).toBe('msg_0294');

    const greedy = await client.call('messages.list', { threadId, before: 'msg_0299', limit: 5000 });
    expect(greedy.messages).toHaveLength(MESSAGE_PAGE_MAX);
    expect(greedy.before).toBe('msg_0099');
  });

  test('a cursor that is not a message of that thread is refused by name', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const other = await echoThread(harness, client, 'other thread');
    seed(threadId, 5);
    seed(other.threadId, 0);

    let failure = 'none';
    try {
      await client.call('messages.list', { threadId, before: 'msg_nope' });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe(`message msg_nope is not a message of thread ${threadId}`);

    // A real message id, but of another thread: same refusal, not an empty page.
    let crossed = 'none';
    try {
      await client.call('messages.list', { threadId: other.threadId, before: 'msg_0003' });
    } catch (error) {
      crossed = (error as Error).message;
    }
    expect(crossed).toBe(`message msg_0003 is not a message of thread ${other.threadId}`);
  });

  test('an unknown thread is a not-found, not a refusal', async () => {
    const client = await harness.connect();
    let failure = 'none';
    try {
      await client.call('messages.list', { threadId: 'thr_nope', before: 'msg_0000' });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('unknown thread thr_nope');
  });

  test('a page is an index search on the thread, descending, with no sort step', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId, 300);

    const plan = harness.core.journal.db
      .query(
        'EXPLAIN QUERY PLAN SELECT * FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?',
      )
      .all(threadId, 500, 10) as { detail: string }[];
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toContain('USING INDEX messages_by_thread');
    expect(detail).not.toContain('SCAN');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  test('the journal still hands the whole thread to the core itself', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId, 300);

    expect(harness.core.journal.listMessages(threadId)).toHaveLength(300);
  });
});
