import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { crc32, deflateSync } from 'node:zlib';
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

/** A real PNG with noise in it, base64: past the inline limit, and Bun can decode and blur it. */
function png(width: number, height: number): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  let seed = width * 31 + height;
  for (let at = 0; at < rows.length; at += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rows[at] = at % (width * 3 + 1) === 0 ? 0 : seed >> 23;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const SHOT = png(320, 180);
const TALL = png(90, 160);

function seed(threadId: string): void {
  const message = (id: string, data: string, at: number): Message => ({
    id, threadId, turnId: 'trn_seed', role: 'user', state: 'complete', createdAt: at,
    parts: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data, alt: `${id}.png` }],
  });
  harness.core.journal.putMessage(message('msg_shot', SHOT, 1_000));
  harness.core.journal.putMessage(message('msg_tall', TALL, 1_001));
}

const previews = (threadId: string) =>
  (harness.core.journal.db.query('SELECT COUNT(*) AS n FROM media_previews WHERE thread_id = ?').get(threadId) as { n: number }).n;

describe('deferred pictures', () => {
  test('a light page gives each deferred picture its size and, from the first opening, its blur', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId);
    expect(SHOT.length).toBeGreaterThan(8 * 1024);

    const light = await client.call('threads.get', { threadId, compactImages: true });
    const shot = light.messages.find((message) => message.id === 'msg_shot')!.parts[1];
    expect(shot).toMatchObject({ type: 'image', data: '', dataDeferred: true, width: 320, height: 180, bytes: Buffer.from(SHOT, 'base64').length });
    expect(shot?.type === 'image' && shot.preview?.startsWith('data:image/png;base64,')).toBe(true);
    const tall = light.messages.find((message) => message.id === 'msg_tall')!.parts[1];
    expect(tall).toMatchObject({ width: 90, height: 160 });
    expect((await client.call('messages.attachment', { threadId, messageId: 'msg_shot', partIndex: 1 })).data).toBe(SHOT);

    // An older page of the same thread carries them too.
    const older = await client.call('messages.list', { threadId, before: 'msg_tall', compactImages: true });
    expect(older.messages[0]!.parts[1]).toMatchObject({ width: 320, height: 180, preview: (shot as { preview: string }).preview });
    // Without the flag nothing changes: the bytes, and no size or blur.
    const full = (await client.call('threads.get', { threadId })).messages.find((message) => message.id === 'msg_shot')!.parts[1];
    expect(full).toEqual({ type: 'image', mimeType: 'image/png', data: SHOT, alt: 'msg_shot.png' });
  });

  test('the blurs of a rewound message and of a deleted thread leave the journal with them', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId);
    await client.call('threads.get', { threadId, compactImages: true });
    // A blur per picture, and the mark that each message was looked at.
    expect(previews(threadId)).toBe(4);
    harness.core.journal.db.transaction(() => harness.core.journal.truncateMessages(threadId, harness.core.journal.messageRowid(threadId, 'msg_tall')!))();
    expect(previews(threadId)).toBe(2);
    harness.core.journal.deleteThreads([threadId]);
    expect(previews(threadId)).toBe(0);
  });
});
