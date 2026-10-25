import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { crc32, deflateSync } from 'node:zlib';
import { INITIAL_PAGE_BYTES, type Message, type RpcResult } from '@boite/contracts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';
import { thrown } from './settle.ts';

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

/** A screenshot-like PNG: a gradient with grain, which compresses badly as PNG and well as WebP. */
function grainy(width: number, height: number): string {
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
  let seed = 7;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const grain = (seed >> 16) % 32;
      rows[at] = Math.min(255, Math.round((x / width) * 220) + grain);
      rows[at + 1] = Math.min(255, 90 + grain);
      rows[at + 2] = Math.min(255, Math.round((y / height) * 220) + grain);
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
const SCREEN = grainy(1600, 900);
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
  for (const method of ['threads.get', 'messages.list'] as const) {
    test(`${method} answers while image previews are still being prepared`, async () => {
      const client = await harness.connect();
      const { threadId } = await echoThread(harness, client);
      seed(threadId);
      const placeholder = Bun.Image.prototype.placeholder;
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      Bun.Image.prototype.placeholder = async function () {
        entered = true;
        await gate;
        return placeholder.call(this);
      };
      try {
        const page = method === 'threads.get'
          ? client.call(method, { threadId, compactImages: true, open: {} })
          : client.call(method, { threadId, from: 0, compactImages: true });
        await waitFor(() => entered);
        // Another RPC can complete while the worker is held. The page must already be available too.
        const first = await Promise.race([page.then(() => 'page'), client.call('settings.get', {}).then(() => 'barrier')]);
        expect(first).toBe('page');
        const shot = (await page).messages.find(message => message.id === 'msg_shot')!.parts[1];
        expect(shot).toMatchObject({ data: '', dataDeferred: true, width: 320, height: 180 });
        expect(shot).not.toHaveProperty('preview');
      } finally {
        release();
        Bun.Image.prototype.placeholder = placeholder;
        await waitFor(() => previews(threadId) >= 2);
      }
    });
  }

  test('video and audio bytes stay out of light pages and live events', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const data = Buffer.alloc(2 * 1024 * 1024, 97).toString('base64');
    const parts: Message['parts'] = [
      { type: 'text', text: 'The conversation is readable before the media arrives.' },
      { type: 'file', mimeType: 'video/mp4', data, name: 'walkthrough.mp4' },
      { type: 'file', mimeType: 'audio/mpeg', data, name: 'notes.mp3' },
    ];
    harness.core.journal.putMessage({ id: 'msg_media', threadId, turnId: 'trn_seed', role: 'assistant', state: 'complete', createdAt: 2_000, parts });
    const page = await client.call('threads.get', { threadId, compactFiles: true, compactImages: true, open: {} });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(INITIAL_PAGE_BYTES);
    expect(page.messages[0]!.parts[0]).toEqual(parts[0]);
    for (const partIndex of [1, 2]) {
      const part = parts[partIndex]!;
      expect(page.messages[0]!.parts[partIndex]).toMatchObject({ data: '', dataDeferred: true, bytes: 2 * 1024 * 1024 });
      const event = client.next('message.part', event => event.messageId === 'msg_live_media');
      harness.core.bus.emit('message.part', { threadId, messageId: 'msg_live_media', partIndex, part });
      expect((await event).part).toMatchObject({ data: '', dataDeferred: true });
      const ticket = await client.call('messages.attachment', { threadId, messageId: 'msg_media', partIndex, ticket: true });
      expect(ticket.data).toBe('');
      expect(ticket.url).toMatch(/^\/file\//);
      const response = await fetch(`${harness.url}${ticket.url}`);
      expect(response.headers.get('content-type')).toBe(part.type === 'file' ? part.mimeType : '');
      expect(Buffer.from(await response.arrayBuffer()).toString('base64')).toBe(data);
      const range = await fetch(`${harness.url}${ticket.url}`, { headers: { range: 'bytes=100-199' } });
      expect(range.status).toBe(206);
      expect(range.headers.get('content-range')).toBe('bytes 100-199/2097152');
      expect((await range.arrayBuffer()).byteLength).toBe(100);
      const tail = await fetch(`${harness.url}${ticket.url}`, { headers: { range: 'bytes=-64' } });
      expect(tail.status).toBe(206);
      expect((await tail.arrayBuffer()).byteLength).toBe(64);
      const invalid = await fetch(`${harness.url}${ticket.url}`, { headers: { range: 'bytes=2097152-' } });
      expect(invalid.status).toBe(416);
    }
  });

  test('a light page gives each deferred picture its size, and later reads reuse its background blur', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId);
    expect(SHOT.length).toBeGreaterThan(8 * 1024);

    const light = await client.call('threads.get', { threadId, compactImages: true });
    const shot = light.messages.find((message) => message.id === 'msg_shot')!.parts[1];
    expect(shot).toMatchObject({ type: 'image', data: '', dataDeferred: true, width: 320, height: 180, bytes: Buffer.from(SHOT, 'base64').length });
    const tall = light.messages.find((message) => message.id === 'msg_tall')!.parts[1];
    expect(tall).toMatchObject({ width: 90, height: 160 });
    expect((await client.call('messages.attachment', { threadId, messageId: 'msg_shot', partIndex: 1 })).data).toBe(SHOT);

    await waitFor(() => previews(threadId) === 2);
    const ready = await client.call('threads.get', { threadId, compactImages: true });
    const blurred = ready.messages.find(message => message.id === 'msg_shot')!.parts[1];
    expect(blurred?.type === 'image' && blurred.preview?.startsWith('data:image/png;base64,')).toBe(true);

    // An older page of the same thread carries them too.
    const older = await client.call('messages.list', { threadId, before: 'msg_tall', compactImages: true });
    expect(older.messages[0]!.parts[1]).toMatchObject({ width: 320, height: 180, preview: (blurred as { preview: string }).preview });
    // Without the flag nothing changes: the bytes, and no size or blur.
    const full = (await client.call('threads.get', { threadId })).messages.find((message) => message.id === 'msg_shot')!.parts[1];
    expect(full).toEqual({ type: 'image', mimeType: 'image/png', data: SHOT, alt: 'msg_shot.png' });
  });

  test("an agent's picture and video are deferred, with a background blur kept for later picture reads", async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const video = Buffer.from('a short clip').toString('base64');
    harness.core.journal.putMessage({
      id: 'msg_attached', threadId, turnId: 'trn_seed', role: 'assistant', state: 'complete', createdAt: 2_000,
      parts: [
        { type: 'file', mimeType: 'image/png', data: SHOT, name: 'street.png' },
        { type: 'file', mimeType: 'video/mp4', data: video, name: 'drive.mp4' },
      ],
    });
    const light = await client.call('threads.get', { threadId, compactFiles: true, compactImages: true });
    const [picture, clip] = light.messages.find((message) => message.id === 'msg_attached')!.parts;
    expect(picture).toMatchObject({ type: 'file', name: 'street.png', data: '', dataDeferred: true, width: 320, height: 180, bytes: Buffer.from(SHOT, 'base64').length });
    expect(clip).toEqual({ type: 'file', mimeType: 'video/mp4', data: '', dataDeferred: true, bytes: 12, name: 'drive.mp4' });
    await waitFor(() => previews(threadId) === 1);
    const ready = await client.call('threads.get', { threadId, compactFiles: true, compactImages: true });
    expect(ready.messages[0]!.parts[0]).toMatchObject({ preview: expect.stringContaining('data:image/png;base64,') });
    expect((await client.call('messages.attachment', { threadId, messageId: 'msg_attached', partIndex: 0 })).data).toBe(SHOT);
  });

  test('a live prompt and agent part reach a window opened light as its pages do, and the blur is queued', async () => {
    const light = await harness.connect();
    const whole = await harness.connect();
    const { threadId } = await echoThread(harness, light);
    await light.call('threads.get', { threadId, compactFiles: true, compactImages: true, open: {} });
    await whole.call('threads.get', { threadId, open: {} });
    const notes = Buffer.from('notes '.repeat(64)).toString('base64');
    const lightStarted = light.next('message.started', message => message.role === 'user');
    const wholeStarted = whole.next('message.started', message => message.role === 'user');
    await light.call('turns.start', { threadId, prompt: 'look', attachments: [
      { kind: 'image', mimeType: 'image/png', data: SHOT, name: 'shot.png' },
      { kind: 'file', mimeType: 'text/plain', data: notes, name: 'notes.txt' },
    ] });
    const sent = await lightStarted;
    const image = sent.parts.find(part => part.type === 'image');
    const file = sent.parts.find(part => part.type === 'file');
    expect(image).toMatchObject({ data: '', dataDeferred: true, width: 320, height: 180, bytes: Buffer.from(SHOT, 'base64').length });
    expect(file).toMatchObject({ name: 'notes.txt', data: '', dataDeferred: true, bytes: Buffer.from(notes, 'base64').length });
    // The other window asked for whole pages, and gets the whole prompt.
    const full = await wholeStarted;
    expect(full.parts.find(part => part.type === 'image')).toMatchObject({ data: SHOT });
    expect(full.parts.find(part => part.type === 'file')).toMatchObject({ data: notes });
    // The blur it went without is made for the next page.
    await waitFor(() => previews(threadId) > 0);
    const page = await light.call('threads.get', { threadId, compactFiles: true, compactImages: true });
    const paged = page.messages.find(message => message.id === sent.id)!.parts.find(part => part.type === 'image');
    expect(paged?.type === 'image' && paged.preview?.startsWith('data:image/png;base64,')).toBe(true);
    expect((await light.call('messages.attachment', { threadId, messageId: sent.id, partIndex: sent.parts.indexOf(image!) })).data).toBe(SHOT);

    // An agent's picture and video are deferred in live events too.
    const video = Buffer.from('a short clip').toString('base64');
    const parts = [
      { type: 'file' as const, mimeType: 'image/png', data: SHOT, name: 'street.png' },
      { type: 'file' as const, mimeType: 'video/mp4', data: video, name: 'drive.mp4' },
    ];
    for (const [partIndex, part] of parts.entries()) {
      const lightPart = light.next('message.part', event => event.partIndex === partIndex && event.messageId === 'msg_agent');
      const wholePart = whole.next('message.part', event => event.partIndex === partIndex && event.messageId === 'msg_agent');
      harness.core.bus.emit('message.part', { threadId, messageId: 'msg_agent', partIndex, part });
      expect((await wholePart).part).toEqual(part);
      if (partIndex === 0) expect((await lightPart).part).toMatchObject({ data: '', dataDeferred: true, width: 320, height: 180 });
      else expect((await lightPart).part).toMatchObject({ ...part, data: '', dataDeferred: true, bytes: 12 });
    }
  });

  test('messages.attachment with display hands back a lighter WebP made once, and the original without it', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId);
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary').toString('base64');
    harness.core.journal.putMessage({ id: 'msg_gif', threadId, turnId: 'trn_seed', role: 'user', state: 'complete', createdAt: 3_000, parts: [{ type: 'image', mimeType: 'image/gif', data: gif, alt: null }] });
    harness.core.journal.putMessage({ id: 'msg_screen', threadId, turnId: 'trn_seed', role: 'assistant', state: 'complete', createdAt: 3_001, parts: [{ type: 'file', mimeType: 'image/png', data: SCREEN, name: 'screen.png' }] });

    const copy = await client.call('messages.attachment', { threadId, messageId: 'msg_screen', partIndex: 0, display: true });
    expect(copy.mimeType).toBe('image/webp');
    const bytes = Buffer.from(copy.data, 'base64');
    expect(bytes.subarray(8, 12).toString()).toBe('WEBP');
    expect(bytes.length * 5).toBeLessThan(Buffer.from(SCREEN, 'base64').length);
    // At most 1280 px on its longer side, at the picture's proportions.
    expect(await new Bun.Image(bytes).metadata()).toMatchObject({ width: 1280, height: 720, format: 'webp' });
    // Kept: the second read is the same copy, from the journal.
    const kept = harness.core.journal.db.query('SELECT length(data) AS n FROM media_displays WHERE message_id = ?').get('msg_screen') as { n: number };
    expect(kept.n).toBe(bytes.length);
    // The kept copy answers without reading the message, and only for the message's own thread.
    const journal = harness.core.journal;
    const messagePart = journal.messagePart.bind(journal);
    let reads = 0;
    journal.messagePart = (...args) => { reads += 1; return messagePart(...args); };
    expect((await client.call('messages.attachment', { threadId, messageId: 'msg_screen', partIndex: 0, display: true })).data).toBe(copy.data);
    expect(reads).toBe(0);
    const other = await echoThread(harness, client, 'other thread');
    expect(await thrown(client.call('messages.attachment', { threadId: other.threadId, messageId: 'msg_screen', partIndex: 0, display: true }))).toThrow('is not a message of thread');
    journal.messagePart = messagePart;
    // The original is still what a plain read gives; a copy heavier than its PNG is not sent; a GIF stays a GIF.
    expect(await client.call('messages.attachment', { threadId, messageId: 'msg_screen', partIndex: 0 })).toEqual({ data: SCREEN });
    expect(await client.call('messages.attachment', { threadId, messageId: 'msg_shot', partIndex: 1, display: true })).toEqual({ data: SHOT });
    expect(await client.call('messages.attachment', { threadId, messageId: 'msg_gif', partIndex: 0, display: true })).toEqual({ data: gif });
  });

  test('with ticket a copy and an original come as a cached file route address, the same one while it lives', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    harness.core.journal.putMessage({ id: 'msg_screen', threadId, turnId: 'trn_seed', role: 'assistant', state: 'complete', createdAt: 3_001, parts: [{ type: 'file', mimeType: 'image/png', data: SCREEN, name: 'screen.png' }] });
    const asked = { threadId, messageId: 'msg_screen', partIndex: 0 };

    const copy = await client.call('messages.attachment', { ...asked, display: true, ticket: true });
    expect(copy).toMatchObject({ data: '', mimeType: 'image/webp' });
    expect(copy.url).toMatch(/^\/file\/[A-Za-z0-9_-]+$/);
    const served = await fetch(`${harness.url}${copy.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect(served.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(bytes.length).toBe(copy.bytes!);
    // The same bytes the base64 answer an older client asks for carries, and the same address asked again.
    expect(Buffer.from(bytes).toString('base64')).toBe((await client.call('messages.attachment', { ...asked, display: true })).data);
    expect((await client.call('messages.attachment', { ...asked, display: true, ticket: true })).url).toBe(copy.url);

    const original = await client.call('messages.attachment', { ...asked, ticket: true });
    expect(original).toMatchObject({ data: '', mimeType: 'image/png', bytes: Buffer.from(SCREEN, 'base64').length });
    expect(original.url).not.toBe(copy.url);
    const whole = await fetch(`${harness.url}${original.url}`);
    expect(Buffer.from(await whole.arrayBuffer()).toString('base64')).toBe(SCREEN);
    expect(whole.headers.get('content-disposition')).toContain('screen.png');
    // Without ticket, the base64 answer is unchanged.
    expect(await client.call('messages.attachment', asked)).toEqual({ data: SCREEN });
  });

  test('a thumbnail copy is made once at 320 px from the kept large copy, and leaves with its thread', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    harness.core.journal.putMessage({ id: 'msg_screen', threadId, turnId: 'trn_seed', role: 'assistant', state: 'complete', createdAt: 3_001, parts: [{ type: 'file', mimeType: 'image/png', data: SCREEN, name: 'screen.png' }] });
    const asked = { threadId, messageId: 'msg_screen', partIndex: 0, display: true };
    const large = await client.call('messages.attachment', asked);

    // Once the large copy is kept, the thumbnail is made from it: the original is never read again.
    const journal = harness.core.journal;
    const messagePart = journal.messagePart.bind(journal);
    let reads = 0;
    journal.messagePart = (...args) => { reads += 1; return messagePart(...args); };
    const made = Bun.Image.prototype.webp;
    let encodes = 0;
    Bun.Image.prototype.webp = function (...args) { encodes += 1; return made.apply(this, args); };
    let thumb: RpcResult<'messages.attachment'>;
    let again: string;
    try {
      thumb = await client.call('messages.attachment', { ...asked, thumb: true, ticket: true });
      expect(encodes).toBe(1);
      again = (await client.call('messages.attachment', { ...asked, thumb: true })).data;
    } finally {
      Bun.Image.prototype.webp = made;
    }
    // Asked again it is the same copy, kept, not made again.
    expect(encodes).toBe(1);
    expect(reads).toBe(0);
    journal.messagePart = messagePart;
    expect(thumb.mimeType).toBe('image/webp');
    const bytes = new Uint8Array(await (await fetch(`${harness.url}${thumb.url}`)).arrayBuffer());
    expect(Buffer.from(bytes).toString('base64')).toBe(again);
    expect(await new Bun.Image(bytes).metadata()).toMatchObject({ width: 320, height: 180, format: 'webp' });
    expect(bytes.length * 4).toBeLessThan(Buffer.from(large.data, 'base64').length);

    // Kept beside the large one, under the part's thumbnail slot.
    const kept = () => journal.db.query('SELECT part_index AS part, length(data) AS n FROM media_displays WHERE thread_id = ? ORDER BY part_index').all(threadId) as { part: number; n: number }[];
    expect(kept()).toEqual([{ part: -2, n: bytes.length }, { part: 0, n: Buffer.from(large.data, 'base64').length }]);

    // A thumbnail asked first, with no large copy yet, is made from the original.
    harness.core.journal.putMessage({ id: 'msg_fresh', threadId, turnId: 'trn_seed', role: 'user', state: 'complete', createdAt: 3_002, parts: [{ type: 'image', mimeType: 'image/png', data: SCREEN, alt: null }] });
    const fresh = await client.call('messages.attachment', { threadId, messageId: 'msg_fresh', partIndex: 0, display: true, thumb: true });
    expect(await new Bun.Image(Buffer.from(fresh.data, 'base64')).metadata()).toMatchObject({ width: 320, height: 180 });

    // The thread goes, and its copies and their addresses with it.
    journal.deleteThreads([threadId]);
    expect(kept()).toEqual([]);
    expect((await fetch(`${harness.url}${thumb.url}`)).status).toBe(404);
  });

  test('a picture already smaller than the thumbnail is sent as its larger copy or as it is', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId);
    // A 320 by 180 PNG of noise: no copy is lighter, so the original comes.
    expect(await client.call('messages.attachment', { threadId, messageId: 'msg_shot', partIndex: 1, display: true, thumb: true })).toEqual({ data: SHOT });

    // A thumbnail kept as not lighter than its source sends that source: the kept large copy,
    // or the original when no large copy is kept, without making one.
    const journal = harness.core.journal;
    const rows = () => journal.db.query('SELECT part_index AS part FROM media_displays WHERE message_id = ? ORDER BY part_index').all('msg_tall') as { part: number }[];
    journal.db.query('INSERT INTO media_displays (message_id, part_index, thread_id, data) VALUES (?, ?, ?, ?)').run('msg_tall', -3, threadId, new Uint8Array(0));
    expect(await client.call('messages.attachment', { threadId, messageId: 'msg_tall', partIndex: 1, display: true, thumb: true })).toEqual({ data: TALL });
    expect(rows()).toEqual([{ part: -3 }]);
    journal.db.query('INSERT INTO media_displays (message_id, part_index, thread_id, data) VALUES (?, ?, ?, ?)').run('msg_tall', 1, threadId, new Uint8Array([7, 7]));
    expect(await client.call('messages.attachment', { threadId, messageId: 'msg_tall', partIndex: 1, display: true, thumb: true })).toEqual({ data: Buffer.from([7, 7]).toString('base64'), mimeType: 'image/webp' });
  });

  test("an incognito conversation's pictures come with no-store, so no browser cache outlives it", async () => {
    const client = await harness.connect();
    const drafts = await client.call('projects.drafts', {});
    const accountId = (await client.call('accounts.list', {})).find((account) => account.providerId === 'echo')!.id;
    const thread = await client.call('threads.create', { projectId: drafts.id, providerId: 'echo', accountId, incognito: true });
    harness.core.journal.putMessage({ id: 'msg_secret', threadId: thread.id, turnId: 'trn_seed', role: 'user', state: 'complete', createdAt: 3_001, parts: [{ type: 'image', mimeType: 'image/png', data: SCREEN, alt: null }] });
    const asked = { threadId: thread.id, messageId: 'msg_secret', partIndex: 0, ticket: true };
    for (const answer of [
      await client.call('messages.attachment', { ...asked, display: true, thumb: true }),
      await client.call('messages.attachment', { ...asked, display: true }),
      await client.call('messages.attachment', asked),
    ]) {
      const served = await fetch(`${harness.url}${answer.url}`);
      expect(served.status).toBe(200);
      expect(served.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('a copy the journal cannot keep comes as base64 rather than as an address that would not load', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    harness.core.journal.putMessage({ id: 'msg_screen', threadId, turnId: 'trn_seed', role: 'user', state: 'complete', createdAt: 3_001, parts: [{ type: 'image', mimeType: 'image/png', data: SCREEN, alt: null }] });
    // A full disk, as SQLite reports it.
    harness.core.journal.db.exec("CREATE TRIGGER full_disk BEFORE INSERT ON media_displays BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END");
    for (const thumb of [true, false]) {
      const answer = await client.call('messages.attachment', { threadId, messageId: 'msg_screen', partIndex: 0, display: true, thumb, ticket: true });
      expect(answer.url).toBeUndefined();
      expect(answer.mimeType).toBe('image/webp');
      expect(await new Bun.Image(Buffer.from(answer.data, 'base64')).metadata()).toMatchObject({ format: 'webp', width: thumb ? 320 : 1280 });
    }
  });

  test('a fork keeps the copies of the pictures it copies, so it never makes them again', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    await client.call('turns.start', { threadId, prompt: 'look', attachments: [{ kind: 'image', mimeType: 'image/png', data: SCREEN, name: 'screen.png' }] });
    await waitFor(() => harness.core.journal.getThread(threadId)?.status === 'idle' && harness.core.journal.listMessages(threadId).length >= 2);
    const [prompt, reply] = harness.core.journal.listMessages(threadId);
    const partIndex = prompt!.parts.findIndex((part) => part.type === 'image');
    await client.call('messages.attachment', { threadId, messageId: prompt!.id, partIndex, display: true });
    await client.call('messages.attachment', { threadId, messageId: prompt!.id, partIndex, display: true, thumb: true });

    const fork = await client.call('threads.fork', { threadId, messageId: reply!.id });
    const copied = harness.core.journal.listMessages(fork.id)[0]!;
    const made = Bun.Image.prototype.webp;
    let encodes = 0;
    Bun.Image.prototype.webp = function (...args) { encodes += 1; return made.apply(this, args); };
    try {
      await client.call('messages.attachment', { threadId: fork.id, messageId: copied.id, partIndex, display: true });
      await client.call('messages.attachment', { threadId: fork.id, messageId: copied.id, partIndex, display: true, thumb: true });
    } finally {
      Bun.Image.prototype.webp = made;
    }
    expect(encodes).toBe(0);
    const slots = harness.core.journal.db.query('SELECT part_index AS part FROM media_displays WHERE message_id = ? AND thread_id = ? ORDER BY part_index').all(copied.id, fork.id);
    expect(slots).toEqual([{ part: -2 - partIndex }, { part: partIndex }]);
  });

  test('a light page still opens, sized and without blurs, when the blurs cannot be read', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId);
    harness.core.journal.db.exec('DROP TABLE media_previews');
    const light = await client.call('threads.get', { threadId, compactImages: true });
    const shot = light.messages.find((message) => message.id === 'msg_shot')!.parts[1];
    expect(shot).toMatchObject({ dataDeferred: true, width: 320, height: 180 });
    expect(shot).not.toHaveProperty('preview');
    expect((await client.call('messages.list', { threadId, before: 'msg_tall', compactImages: true })).messages).toHaveLength(1);
  });

  test('the blurs of a rewound message and of a deleted thread leave the journal with them', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    seed(threadId);
    await client.call('threads.get', { threadId, compactImages: true });
    await waitFor(() => previews(threadId) === 2);
    harness.core.journal.db.transaction(() => harness.core.journal.truncateMessages(threadId, harness.core.journal.messageRowid(threadId, 'msg_tall')!))();
    expect(previews(threadId)).toBe(1);
    harness.core.journal.deleteThreads([threadId]);
    expect(previews(threadId)).toBe(0);
  });
});
