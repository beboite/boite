import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { RpcErrorCode, type Message, type MessagePart } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

/** A real PNG of a horizontal gradient, base64, so Bun can decode and blur it. */
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
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      rows[at] = Math.round((x / width) * 255);
      rows[at + 1] = 80;
      rows[at + 2] = Math.round((y / height) * 255);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const SHOT = png(320, 180);
const FILE = Buffer.from('a plain text file the user attached').toString('base64');

/** A user prompt with a picture and a file, then an answer whose tool call made a picture. */
function seed(threadId: string): void {
  const user: Message = {
    id: 'msg_user',
    threadId,
    turnId: 'trn_seed',
    role: 'user',
    parts: [
      { type: 'text', text: 'look at this' },
      { type: 'image', mimeType: 'image/png', data: SHOT, alt: 'shot.png' },
      { type: 'file', mimeType: 'text/plain', data: FILE, name: 'notes.txt' },
    ],
    state: 'complete',
    createdAt: 1_000,
  };
  const tool: MessagePart = {
    type: 'tool',
    toolId: 'tool_1',
    name: 'screenshot',
    input: {},
    output: 'done',
    status: 'done',
    documents: [{ kind: 'image', mimeType: 'image/png', data: png(64, 128), alt: null }],
  };
  const answer: Message = { id: 'msg_answer', threadId, turnId: 'trn_seed', role: 'assistant', parts: [tool], state: 'complete', createdAt: 1_001 };
  harness.core.journal.putMessage(user);
  harness.core.journal.putMessage(answer);
}

async function failure(call: Promise<unknown>): Promise<{ code: number; data: Record<string, unknown> }> {
  try {
    await call;
  } catch (error) {
    return (error as { rpc: { code: number; data: Record<string, unknown> } }).rpc;
  }
  throw new Error('the call was expected to fail');
}

describe('media references', () => {
  test('a media client opens a thread on references with the size and a blur, and reads the bytes on demand', async () => {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    seed(threadId);
    const client = await harness.connect({ media: 'ref' });

    const thread = await client.call('threads.get', { threadId });
    const [, image, file] = thread.messages[0]!.parts;
    // The first opening already has the blur: the page waited for it.
    expect(image).toMatchObject({ type: 'image', data: '', alt: 'shot.png', media: { slot: 'p1', width: 320, height: 180, bytes: Buffer.from(SHOT, 'base64').length } });
    expect(image?.type === 'image' && image.media?.preview?.startsWith('data:image/png;base64,')).toBe(true);
    expect(file).toEqual({ type: 'file', mimeType: 'text/plain', data: '', name: 'notes.txt', media: { slot: 'p2', bytes: 35, width: null, height: null, preview: null } });
    const tool = thread.messages[1]!.parts[0];
    expect(tool?.type === 'tool' && tool.documents?.[0]).toMatchObject({ kind: 'image', data: '', media: { slot: 'p0d0', width: 64, height: 128 } });

    expect(await client.call('messages.media', { threadId, messageId: 'msg_user', slot: 'p1' })).toEqual({ mimeType: 'image/png', data: SHOT });
    expect(await client.call('messages.media', { threadId, messageId: 'msg_user', slot: 'p2' })).toEqual({ mimeType: 'text/plain', data: FILE });
    expect((await client.call('messages.media', { threadId, messageId: 'msg_answer', slot: 'p0d0' })).data).toBe(png(64, 128));

    // The journal is untouched, and a client that did not ask still gets the bytes.
    const plain = await owner.call('threads.get', { threadId });
    expect(plain.messages[0]!.parts[1]).toEqual({ type: 'image', mimeType: 'image/png', data: SHOT, alt: 'shot.png' });
    const older = await client.call('messages.list', { threadId, before: 'msg_answer' });
    expect(older.messages[0]!.parts[1]).toMatchObject({ data: '', media: { slot: 'p1' } });
  });

  test('messages.media refuses a slot, a message or a thread that holds no bytes, by field', async () => {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const other = await echoThread(harness, owner, 'other');
    seed(threadId);
    const client = await harness.connect({ media: 'ref' });

    const shape = await failure(client.call('messages.media', { threadId, messageId: 'msg_user', slot: '../p1' }));
    expect(shape).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { field: 'slot' } });
    const text = await failure(client.call('messages.media', { threadId, messageId: 'msg_user', slot: 'p0' }));
    expect(text).toMatchObject({ code: RpcErrorCode.NotFound, data: { field: 'slot' } });
    const elsewhere = await failure(client.call('messages.media', { threadId: other.threadId, messageId: 'msg_user', slot: 'p1' }));
    expect(elsewhere).toMatchObject({ code: RpcErrorCode.NotFound, data: { field: 'messageId' } });
  });

  test('a prompt sent with a picture reaches a media client as a reference, and its blur follows on the next read', async () => {
    const client = await harness.connect({ media: 'ref' });
    const { threadId } = await echoThread(harness, client);
    await client.call('threads.subscribe', { threadId });
    const started: Message[] = [];
    client.on('message.started', (payload) => started.push(payload as Message));

    const turn = await client.call('turns.start', { threadId, prompt: 'see', attachments: [{ kind: 'image', mimeType: 'image/png', data: SHOT, name: 'shot.png' }] });
    await waitFor(() => harness.core.journal.getTurn(turn.id)?.finishedAt != null);

    const prompt = started.find((message) => message.role === 'user');
    const image = prompt?.parts.find((part) => part.type === 'image');
    expect(image).toMatchObject({ data: '', media: { slot: expect.stringMatching(/^p\d+$/), width: 320, height: 180 } });
    await waitFor(() => harness.core.journal.mediaPreviews(prompt!.id).size === 1);
    const thread = await client.call('threads.get', { threadId });
    const read = thread.messages.find((message) => message.id === prompt!.id)?.parts.find((part) => part.type === 'image');
    expect(read?.type === 'image' && read.media?.preview?.startsWith('data:image/png;base64,')).toBe(true);
  });

  test('the blurs of a rewound message and of a deleted thread leave the journal with them', async () => {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    seed(threadId);
    const client = await harness.connect({ media: 'ref' });
    await client.call('threads.get', { threadId });
    const count = () => (harness.core.journal.db.query('SELECT COUNT(*) AS n FROM media_previews WHERE thread_id = ?').get(threadId) as { n: number }).n;
    // A blur per picture, and the mark that each message was looked at.
    expect(count()).toBe(4);

    harness.core.journal.db.transaction(() => harness.core.journal.truncateMessages(threadId, harness.core.journal.messageRowid(threadId, 'msg_answer')!))();
    expect(count()).toBe(2);
    harness.core.journal.deleteThreads([threadId]);
    expect(count()).toBe(0);
  });

  test('an agent connection is never given references', async () => {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    await Bun.write(join(harness.dataDir, 'report.txt'), 'the report');
    const turn = await owner.call('turns.start', { threadId, prompt: 'write the report' });
    await waitFor(() => harness.core.journal.getTurn(turn.id)?.finishedAt != null);
    const agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { media: 'ref' });
    try {
      const published = await agent.call('artifacts.publish', { threadId, path: 'report.txt' });
      expect(published.parts[0]).toMatchObject({ type: 'file', data: Buffer.from('the report').toString('base64') });
      expect(published.parts[0]).not.toHaveProperty('media');
    } finally {
      agent.close();
    }
    // The same answer to the owner's media client is a reference.
    const client = await harness.connect({ media: 'ref' });
    const again = await client.call('artifacts.publish', { threadId, path: 'report.txt' });
    expect(again.parts[0]).toMatchObject({ type: 'file', data: '', media: { slot: 'p0', bytes: 10 } });
  });
});
