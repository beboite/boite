import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MESSAGE_PAGE, MESSAGE_PAGE_MAX, MESSAGE_PAGE_MAX_BYTES, RPC_MAX_FRAME_BYTES } from '@boite/contracts';
import type { Message, MessagePart } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
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
  harness.core.journal.db.transaction(() => {
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
  })();
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

  test('serialized UTF-8 bounds large pages and reconnect tails without losing messages over WsClient', async () => {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    // Each unit uses five UTF-16 code units but ten bytes after JSON escaping.
    const text = '\u{1f600}\n"\\'.repeat(512 * 1024);
    seed(threadId, 7);
    for (const message of harness.core.journal.listMessages(threadId)) {
      harness.core.journal.putMessage({ ...message, parts: [{ type: 'text', text }] });
    }
    const initial = harness.core.threads.get(threadId);
    expect(Buffer.byteLength(JSON.stringify(initial.messages))).toBeLessThanOrEqual(MESSAGE_PAGE_MAX_BYTES);
    expect(initial.messages).toHaveLength(2);
    // An untouched old row is not decoded while opening only the latest page.
    harness.core.journal.db.query('UPDATE messages SET parts = ? WHERE id = ?').run('{', 'msg_0000');
    expect(ids(harness.core.threads.get(threadId).messages)).toEqual(ids(initial.messages));
    harness.core.journal.db.query('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify([{ type: 'text', text }]), 'msg_0000');
    const fallback = harness.core.threads.get(threadId, 'msg_0000');
    expect(fallback.messagesFrom).toBeUndefined();
    expect(ids(fallback.messages)).toEqual(ids(initial.messages));
    const tail = harness.core.threads.get(threadId, 'msg_0005');
    expect(tail.messagesFrom).toBe('msg_0005');
    expect(ids(tail.messages)).toEqual(['msg_0005', 'msg_0006']);

    // Exercise the browser transport without adding DOM globals to the core's compiler.
    const { WsClient } = await import(new URL('../../ui/src/lib/client.ts', import.meta.url).href);
    const client: Pick<CoreClient, 'call' | 'close'> & { connect(): Promise<unknown> } =
      new WsClient({ url: harness.url, token: harness.token, reconnect: false });
    try {
      await client.connect();
      const first = await client.call('threads.get', { threadId, after: 'msg_0000' });
      expect(first.messagesFrom).toBeUndefined();
      const walked = ids(first.messages);
      let cursor = first.messagesBefore;
      let pages = 1;
      while (cursor !== null) {
        const page = await client.call('messages.list', { threadId, before: cursor, limit: MESSAGE_PAGE_MAX });
        expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(MESSAGE_PAGE_MAX_BYTES);
        expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 999, result: page }))).toBeLessThan(RPC_MAX_FRAME_BYTES);
        for (const message of page.messages) {
          expect(message.parts[0]?.type).toBe('text');
          expect(message.parts[0]?.type === 'text' && message.parts[0].text === text).toBe(true);
        }
        walked.unshift(...ids(page.messages));
        cursor = page.before;
        expect(++pages).toBeLessThan(10);
      }
      expect(walked).toEqual(Array.from({ length: 7 }, (_, i) => `msg_${String(i).padStart(4, '0')}`));
      expect(pages).toBe(4);
      const attached = await echoThread(harness, owner, 'Complete bundle');
      const data = 'A'.repeat(Math.ceil(5 * 1024 * 1024 / 3) * 4 - 1) + '=';
      harness.core.journal.putMessage({ id: 'msg_bundle', threadId: attached.threadId, turnId: 'trn_bundle', role: 'user', state: 'complete', createdAt: 1,
        parts: ['first.bin', 'second.bin'].map(name => ({ type: 'file', name, mimeType: 'application/octet-stream', data })) });
      const bundle = await client.call('threads.get', { threadId: attached.threadId, after: 'msg_bundle' });
      expect(bundle.messagesFrom).toBeUndefined();
      expect(bundle.messages).toHaveLength(1);
      expect(bundle.messagesBefore).toBeNull();
      expect(Buffer.byteLength(JSON.stringify(bundle.messages))).toBeGreaterThan(MESSAGE_PAGE_MAX_BYTES);
      expect(bundle.messages[0]?.parts.filter(part => part.type === 'file').every(part => part.data === data)).toBe(true);
    } finally { client.close(); }
  }, 60_000);

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

  test('threads.get carries the turns of its page and the ones in flight, not every turn', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    // One finished turn per message pair, in journal order, then a queued one with no message yet.
    harness.core.journal.db.transaction(() => {
      for (let index = 0; index < 150; index += 1) {
        harness.core.journal.putTurn({
          id: `trn_${String(index).padStart(4, '0')}`,
          threadId,
          status: 'done',
          queuedAt: 1_000 + index,
          startedAt: 1_000 + index,
          finishedAt: 1_001 + index,
          usage: null,
          error: null,
        });
      }
      for (let index = 0; index < 300; index += 1) {
        harness.core.journal.putMessage({
          id: `msg_${String(index).padStart(4, '0')}`,
          threadId,
          turnId: `trn_${String(Math.floor(index / 2)).padStart(4, '0')}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          parts: [{ type: 'text', text: `message ${index}` }],
          state: 'complete',
          createdAt: 1_000 + index,
        });
      }
      harness.core.journal.putTurn({
        id: 'trn_queued',
        threadId,
        status: 'queued',
        queuedAt: 5_000,
        startedAt: null,
        finishedAt: null,
        usage: null,
        error: null,
      });
    })();

    const thread = await client.call('threads.get', { threadId });
    const turnIds = thread.turns.map((turn) => turn.id);
    // 120 messages over 60 turns: trn_0090 to trn_0149, then the queued one.
    expect(turnIds).toHaveLength(61);
    expect(turnIds[0]).toBe('trn_0090');
    expect(turnIds[59]).toBe('trn_0149');
    expect(turnIds.at(-1)).toBe('trn_queued');
    expect(new Set(thread.messages.map((message) => message.turnId)).size).toBe(60);
    expect(harness.core.journal.listTurns(threadId)).toHaveLength(151);
  });

  test('the journal still hands the whole thread to the core itself', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId, 300);

    expect(harness.core.journal.listMessages(threadId)).toHaveLength(300);
  });
});

/** A failed call's message, or 'none'. */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return 'none';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('opening where the reader was', () => {
  test('around a message far up, the page is centred on it and pages down to the end without a gap', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId, 300);

    const thread = await client.call('threads.get', { threadId, around: 'msg_0100' });
    const half = Math.floor(MESSAGE_PAGE / 2);
    expect(thread.messages).toHaveLength(MESSAGE_PAGE);
    expect(ids(thread.messages).at(0)).toBe(`msg_${String(100 - half).padStart(4, '0')}`);
    expect(ids(thread.messages)).toContain('msg_0100');
    expect(thread.messagesBefore).toBe(ids(thread.messages)[0]!);
    expect(thread.messagesAfter).toBe(ids(thread.messages).at(-1)!);

    const single = await client.call('threads.get', { threadId, around: 'msg_0100', limit: 1 });
    expect(ids(single.messages)).toEqual(['msg_0100']);
    expect(single.messagesBefore).toBe('msg_0100');
    expect(single.messagesAfter).toBe('msg_0100');

    const walked = [...ids(thread.messages)];
    let cursor = thread.messagesAfter ?? null;
    while (cursor !== null) {
      const page = await client.call('messages.list', { threadId, after: cursor });
      expect(page.before).toBeNull();
      walked.push(...ids(page.messages));
      cursor = page.after ?? null;
    }
    expect(walked.at(-1)).toBe('msg_0299');
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked).toEqual([...walked].sort());
    expect(walked).toHaveLength(300 - (100 - half));
  });

  test('a message the last page holds, or one the thread does not, opens on the last page', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId, 300);

    for (const around of ['msg_0250', 'msg_nope']) {
      const thread = await client.call('threads.get', { threadId, around });
      expect(ids(thread.messages).at(-1)).toBe('msg_0299');
      expect(thread.messagesBefore).toBe('msg_0180');
      expect(thread.messagesAfter).toBeUndefined();
    }
  });

  test('messages.list takes exactly one cursor', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId, 5);
    const expected = 'messages.list takes exactly one cursor: before, for older messages, or after, for newer ones';
    expect(await refusal(client.call('messages.list', { threadId, before: 'msg_0003', after: 'msg_0001' }))).toBe(expected);
    expect(await refusal(client.call('messages.list', { threadId }))).toBe(expected);
    expect(await refusal(client.call('messages.list', { threadId, after: 'msg_nope' }))).toBe(`message msg_nope is not a message of thread ${threadId}`);
  });

  test('compactImages leaves a large picture on the core with its size, and messages.attachment reads it back', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const big = 'A'.repeat(12_000);
    const parts: MessagePart[] = [
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', data: big, alt: null },
      { type: 'image', mimeType: 'image/png', data: 'B'.repeat(16), alt: 'icon' },
    ];
    harness.core.journal.putMessage({ id: 'msg_pictures', threadId, turnId: 'trn_seed', role: 'user', parts, state: 'complete', createdAt: 5_000 });

    const light = (await client.call('threads.get', { threadId, compactImages: true })).messages.find((message) => message.id === 'msg_pictures')!;
    expect(light.parts[1]).toEqual({ type: 'image', mimeType: 'image/png', data: '', alt: null, bytes: 9_000, dataDeferred: true });
    expect(light.parts[2]).toEqual(parts[2]!);
    expect((await client.call('messages.attachment', { threadId, messageId: 'msg_pictures', partIndex: 1 })).data).toBe(big);
    // Without the flag the page is what it always was.
    expect((await client.call('threads.get', { threadId })).messages.find((message) => message.id === 'msg_pictures')!.parts).toEqual(parts);
  });
});

