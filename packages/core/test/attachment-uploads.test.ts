import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, type Attachment } from '@boite/contracts';
import { AttachmentUploads } from '../src/attachment-uploads.ts';
import { fileReference, prepareAttachments } from '../src/attachments.ts';
import { processPlatform } from '../src/platform/index.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';

let dataDir: string;
let stores: AttachmentUploads[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'boite-attachment-uploads-'));
  stores = [];
});

afterEach(async () => {
  try { await Promise.all(stores.map(store => store.close())); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
});

function store(options?: ConstructorParameters<typeof AttachmentUploads>[1]): AttachmentUploads {
  const uploads = new AttachmentUploads(dataDir, options);
  stores.push(uploads);
  return uploads;
}

function file(data = 'first file', name: string | null = 'report.txt'): Attachment {
  return { kind: 'file', name, mimeType: 'text/plain', data: Buffer.from(data).toString('base64') };
}

function metadata(attachment: Attachment): Attachment { return { ...attachment, data: '' }; }

async function bodies(): Promise<string[]> {
  const root = join(dataDir, 'attachment-uploads');
  const paths: string[] = [];
  let instances: string[];
  try { instances = await readdir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return paths; throw error; }
  for (const instance of instances) {
    for (const lease of await readdir(join(root, instance), { withFileTypes: true })) {
      if (lease.isDirectory()) paths.push(join(root, instance, lease.name, 'body'));
    }
  }
  return paths;
}

const expiry = { data: { reason: 'attachment-upload-expired' } };

test('leases restore ordered file and native image bytes, keep inline bytes, and remain reusable for receipt retries', async () => {
  const uploads = store();
  const first = file();
  const image: Attachment = { kind: 'image', name: 'pixel.png', mimeType: 'image/png', data: 'YWJj' };
  const inline = file('inline');
  const one = await uploads.upload('connection', first);
  const two = await uploads.upload('connection', image);
  expect(one.id).not.toBe(two.id);
  const input = [metadata(image), inline, metadata(first)];
  const ids = [two.id, null, one.id];
  const expected = [image, inline, first];
  expect(await uploads.resolve('connection', input, ids)).toEqual(expected);
  expect(await uploads.resolve('connection', input, ids)).toEqual(expected);
  expect(input[0]!.data).toBe('');
  expect(await uploads.resolve('connection', [inline])).toEqual([inline]);
  const prepared = prepareAttachments(dataDir, { prompt: 'Read', attachments: await uploads.resolve('connection', input, ids) });
  expect(prepared.attachments).toEqual([image]);
  expect(prepared.prompt).toContain('report.txt');
  const path = JSON.parse(fileReference(dataDir, { ...first, kind: 'file' })).path;
  expect(await Bun.file(path).text()).toBe('first file');
  await uploads.release('connection', [one.id, one.id, two.id]);
  expect(await bodies()).toEqual([]);
  await expect(uploads.resolve('connection', [metadata(first)], [one.id])).rejects.toMatchObject(expiry);
  // Permanent copies created only when sending remain independent of pre-send cleanup.
  expect(await Bun.file(path).text()).toBe('first file');
});

test('an upload cannot be read or released by another connection or an arbitrary path', async () => {
  const uploads = store();
  const attachment = file();
  const { id } = await uploads.upload('owner', attachment);
  for (const invalidId of [id, '../../outside', '/etc/passwd', 'unknown']) {
    await expect(uploads.resolve('other', [metadata(attachment)], [invalidId])).rejects.toMatchObject(expiry);
    await expect(uploads.release('other', [invalidId])).rejects.toMatchObject(expiry);
  }
  await expect(uploads.release('owner', [id, 'missing'])).rejects.toMatchObject(expiry);
  expect(await uploads.resolve('owner', [metadata(attachment)], [id])).toEqual([attachment]);
});

test('upload validation preserves shared shape, format and per-file size refusals', async () => {
  const uploads = store();
  for (const attachment of [null, { ...file(), kind: 'other' }, { ...file(), name: 3 }, { ...file(), mimeType: 'text/plain\n' }, { ...file(), data: 'invalid base64' }, { ...file(), kind: 'image', mimeType: 'image/svg+xml' }, { ...file(), data: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1).toString('base64') }]) {
    await expect(uploads.upload('owner', attachment as Attachment)).rejects.toMatchObject({ name: 'RpcFailure' });
  }
  expect(await bodies()).toEqual([]);
  const empty = file('', null);
  const { id } = await uploads.upload('owner', empty);
  expect(await uploads.resolve('owner', [metadata(empty)], [id])).toEqual([empty]);
});

test('reference alignment and exact metadata are checked before reading any bytes', async () => {
  const uploads = store();
  const attachment = file();
  const { id } = await uploads.upload('owner', attachment);
  for (const ids of [[], [id, null], [undefined], [3], [''], {}]) {
    await expect(uploads.resolve('owner', [metadata(attachment)], ids as (string | null)[])).rejects.toThrow('align');
  }
  for (const changed of [null, { ...metadata(attachment), kind: 'image' }, { ...metadata(attachment), name: 'different.txt' }, { ...metadata(attachment), mimeType: 'application/pdf' }, attachment]) {
    await expect(uploads.resolve('owner', [changed as Attachment], [id])).rejects.toThrow('metadata must match');
  }
  await expect(uploads.resolve('owner', {} as Attachment[], [])).rejects.toThrow('array');
  await expect(uploads.resolve('owner', [file(''), { ...file(), data: 'broken' }], [id, null])).rejects.toThrow('base64');
  expect(await uploads.resolve('owner', [metadata(attachment)], [id])).toEqual([attachment]);
});

test('per-connection byte reservations are atomic under concurrent uploads and release returns capacity', async () => {
  const uploads = store();
  const attachment = { ...file(), data: Buffer.alloc(ATTACHMENT_MAX_BYTES, 2).toString('base64') };
  const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () => uploads.upload('owner', attachment)));
  const successful = outcomes.filter(outcome => outcome.status === 'fulfilled');
  expect(successful).toHaveLength(ATTACHMENTS_TOTAL_MAX_BYTES / ATTACHMENT_MAX_BYTES);
  const rejected = outcomes.find(outcome => outcome.status === 'rejected');
  expect(rejected?.status === 'rejected' && rejected.reason.data).toEqual({ bytes: 3 * ATTACHMENT_MAX_BYTES, max: ATTACHMENTS_TOTAL_MAX_BYTES });
  expect(await bodies()).toHaveLength(successful.length);
  const first = successful[0]!;
  if (first.status !== 'fulfilled') throw new Error('expected a fulfilled upload');
  await uploads.release('owner', [first.value.id]);
  await expect(uploads.upload('owner', attachment)).resolves.toHaveProperty('id');
});

test('per-connection count reservations bound empty files even while writes are pending', async () => {
  const uploads = store();
  const outcomes = await Promise.allSettled(Array.from({ length: ATTACHMENTS_PER_TURN + 2 }, () => uploads.upload('owner', file(''))));
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(ATTACHMENTS_PER_TURN);
  expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(2);
  await expect(uploads.upload('other', file(''))).resolves.toHaveProperty('id');
  await uploads.disconnect('owner');
  expect(await bodies()).toHaveLength(1);
  await expect(uploads.upload('owner', file(''))).resolves.toHaveProperty('id');
});

test('global byte and count budgets cover all connections, including zero-byte files', async () => {
  const uploads = store({ globalMaxBytes: 4, globalMaxCount: 3 });
  const first = await uploads.upload('one', file('abcd'));
  await expect(uploads.upload('two', file('x'))).rejects.toMatchObject({ data: { bytes: 5, max: 4 } });
  await uploads.release('one', [first.id]);
  await Promise.all(['one', 'two', 'three'].map(connection => uploads.upload(connection, file(''))));
  await expect(uploads.upload('four', file(''))).rejects.toMatchObject({ data: { count: 4, max: 3 } });
  await uploads.disconnect('two');
  await expect(uploads.upload('four', file('x'))).resolves.toHaveProperty('id');
});

test('resolved duplicate references and inline bytes cannot exceed turn count or byte limits', async () => {
  const uploads = store();
  const attachment = { ...file(), data: Buffer.alloc(ATTACHMENT_MAX_BYTES, 3).toString('base64') };
  const { id } = await uploads.upload('owner', attachment);
  await expect(uploads.resolve('owner', [metadata(attachment), attachment, metadata(attachment)], [id, null, id])).rejects.toMatchObject({ data: { bytes: 3 * ATTACHMENT_MAX_BYTES, max: ATTACHMENTS_TOTAL_MAX_BYTES } });
  await expect(uploads.resolve('owner', Array.from({ length: ATTACHMENTS_PER_TURN + 1 }, () => metadata(attachment)), Array(ATTACHMENTS_PER_TURN + 1).fill(id))).rejects.toMatchObject({ data: { count: ATTACHMENTS_PER_TURN + 1, max: ATTACHMENTS_PER_TURN } });
});

test('disconnect and shutdown cancel uploads both before reservation and during filesystem writes', async () => {
  const uploads = store();
  const pending = uploads.upload('owner', file());
  const cancelled = pending.then(value => ({ value }), error => ({ error }));
  await uploads.disconnect('owner');
  expect(await cancelled).toMatchObject({ error: expiry });
  expect(await bodies()).toEqual([]);

  const write = fs.writeFile;
  for (const action of ['disconnect', 'close'] as const) {
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const writing = spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      entered();
      await gate;
      await write(...args);
    });
    try {
      const upload = uploads.upload('owner', file());
      const rejected = upload.then(value => ({ value }), error => ({ error }));
      await started;
      let finished = false;
      const cleanup = (action === 'close' ? uploads.close() : uploads.disconnect('owner')).then(() => { finished = true; });
      await Promise.resolve();
      expect(finished).toBe(false);
      resume();
      await cleanup;
      expect(await rejected).toMatchObject({ error: expiry });
      expect(await bodies()).toEqual([]);
    } finally { resume(); writing.mockRestore(); }
  }
  await uploads.close();
  await expect(uploads.upload('owner', file())).rejects.toMatchObject(expiry);
});

test('closing a manager removes its temporary bytes without touching another manager or permanent copies', async () => {
  const first = store();
  const second = store();
  const attachment = file('independent', '../../outside.txt');
  const one = await first.upload('owner', attachment);
  const two = await second.upload('owner', attachment);
  expect(await bodies()).toHaveLength(2);
  const paths = await bodies();
  expect(paths.every(path => path.startsWith(join(dataDir, 'attachment-uploads')))).toBe(true);
  expect(paths.every(path => !path.includes('outside.txt'))).toBe(true);
  if (process.platform !== 'win32') {
    for (const path of paths) expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
  await first.close();
  expect(await bodies()).toHaveLength(1);
  await expect(first.resolve('owner', [metadata(attachment)], [one.id])).rejects.toMatchObject(expiry);
  expect(await second.resolve('owner', [metadata(attachment)], [two.id])).toEqual([attachment]);
});

test('lazy expiry deletes old leases and reclaims the global budget before a new upload', async () => {
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now);
  try {
    const uploads = store({ ttlMs: 100, cleanupIntervalMs: 60_000, globalMaxBytes: 1 });
    const attachment = file('a');
    const { id } = await uploads.upload('owner', attachment);
    // Filesystem work must finish before the test spends the lease's TTL.
    clock.mockReturnValue(now + 150);
    const replacement = await uploads.upload('other', attachment);
    await expect(uploads.resolve('owner', [metadata(attachment)], [id])).rejects.toMatchObject(expiry);
    expect(await bodies()).toHaveLength(1);
    await uploads.release('other', [replacement.id]);
    expect(await bodies()).toEqual([]);
  } finally { clock.mockRestore(); }
});

test('the cleanup timer removes expired bytes even without subsequent requests', async () => {
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now);
  try {
    const uploads = store({ ttlMs: 100, cleanupIntervalMs: 10 });
    await uploads.upload('owner', file());
    clock.mockReturnValue(now + 150);
    // The real interval runs while a monotonic clock bounds this wait.
    const deadline = performance.now() + 1_000;
    while ((await bodies()).length > 0 && performance.now() < deadline) await Bun.sleep(10);
    expect(await bodies()).toEqual([]);
  } finally { clock.mockRestore(); }
});

test('filesystem upload failures are preserved and leave no reserved capacity or body', async () => {
  await writeFile(join(dataDir, 'attachment-uploads'), 'not a directory');
  const uploads = store({ globalMaxCount: 1 });
  let failure: unknown;
  try { await uploads.upload('owner', file()); } catch (error) { failure = error; }
  // Recovery fails before reservation and preserves the original filesystem error.
  expect(failure).toMatchObject({ code: 'ENOTDIR' });
  await rm(join(dataDir, 'attachment-uploads'));
  await expect(uploads.upload('owner', file())).resolves.toHaveProperty('id');
  expect(await bodies()).toHaveLength(1);
});

test('a missing temporary body produces the expiry reason for inline retry', async () => {
  const uploads = store();
  const attachment = file();
  const { id } = await uploads.upload('owner', attachment);
  await rm((await bodies())[0]!);
  await expect(uploads.resolve('owner', [metadata(attachment)], [id])).rejects.toMatchObject(expiry);
  expect(await bodies()).toEqual([]);
});

test('changed temporary bytes are never restored, including same-length edits', async () => {
  const uploads = store();
  const attachment = file('original');
  for (const corrupted of ['modified', 'longer changed content']) {
    const { id } = await uploads.upload('owner', attachment);
    await writeFile((await bodies())[0]!, corrupted);
    await expect(uploads.resolve('owner', [metadata(attachment)], [id])).rejects.toMatchObject({ message: expect.stringContaining('bytes changed'), ...expiry });
    expect(await bodies()).toEqual([]);
    await expect(uploads.resolve('owner', [metadata(attachment)], [id])).rejects.toMatchObject(expiry);
  }
});

test('release requests are bounded before processing and cannot partially delete leases', async () => {
  const uploads = store();
  const attachment = file();
  const { id } = await uploads.upload('owner', attachment);
  await expect(uploads.release('owner', Array(ATTACHMENTS_PER_TURN + 1).fill(id))).rejects.toMatchObject({ data: { count: ATTACHMENTS_PER_TURN + 1, max: ATTACHMENTS_PER_TURN } });
  for (const ids of [null, [null], ['']]) {
    await expect(uploads.release('owner', ids as unknown as string[])).rejects.toThrow('array of nonempty strings');
  }
  expect(await uploads.resolve('owner', [metadata(attachment)], [id])).toEqual([attachment]);
});

test('release and disconnect invalidate a resolve that already started reading its lease', async () => {
  const uploads = store();
  const attachment = file();
  const read = fs.readFile;
  for (const action of ['release', 'disconnect'] as const) {
    const { id } = await uploads.upload('owner', attachment);
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const gatedRead = (async (...args: Parameters<typeof fs.readFile>) => {
      const body = await read(...args);
      entered();
      await gate;
      return body;
    }) as typeof fs.readFile;
    const reading = spyOn(fs, 'readFile').mockImplementation(gatedRead);
    try {
      const request = uploads.resolve('owner', [metadata(attachment)], [id]);
      const result = request.then(value => ({ value }), error => ({ error }));
      await started;
      if (action === 'release') await uploads.release('owner', [id]);
      else await uploads.disconnect('owner');
      resume();
      expect(await result).toMatchObject({ error: expiry });
      expect(await bodies()).toEqual([]);
    } finally { resume(); reading.mockRestore(); }
  }
});

test('upload snapshots cannot be changed while disk writes are pending', async () => {
  const uploads = store();
  const original = file('original');
  const expected = { ...original };
  const request = uploads.upload('owner', original);
  original.name = 'changed.txt';
  original.data = file('changed').data;
  const { id } = await request;
  expect(await uploads.resolve('owner', [metadata(expected)], [id])).toEqual([expected]);
});

async function recordedInstance(pid: number, startedAt: number | null): Promise<string> {
  const id = randomUUID();
  const path = join(dataDir, 'attachment-uploads', id);
  await fs.mkdir(join(path, randomUUID()), { recursive: true });
  await writeFile(join(path, 'owner.json'), JSON.stringify({
    schemaVersion: 1, instanceId: id, hostname: hostname(), platform: process.platform, pid, startedAt,
  }));
  return path;
}

test('first upload and shutdown join recovery and delete only instances with a proved dead owner', async () => {
  const h = await startTestCore();
  try {
    const child = h.core.procs.spawn('upload-recovery-fixture', process.execPath, ['-e', 'process.exit(0)']);
    await child.exited;
    const stale = await recordedInstance(child.proc.pid, null);
    const uploads = store();
    await uploads.upload('owner', file());
    expect(existsSync(stale)).toBe(false);
    expect(await uploads.recover()).toMatchObject({ removed: [stale.split(/[\\/]/).at(-1)] });
    const later = await recordedInstance(child.proc.pid, null);
    const shutdownOnly = store();
    await shutdownOnly.close();
    expect(existsSync(later)).toBe(false);
    expect(await bodies()).toHaveLength(1);
  } finally { await h.stop(); }
});

test('recovery preserves independent same-process managers and another living process', async () => {
  const h = await startTestCore();
  const child = h.core.procs.spawn('upload-live-fixture', process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    const first = store();
    const second = store();
    const attachment = file('alive');
    const one = await first.upload('owner', attachment);
    const two = await second.upload('owner', attachment);
    const foreign = await recordedInstance(child.proc.pid, processPlatform.startedAt(child.proc.pid));
    const current = await recordedInstance(process.pid, processPlatform.startedAt(process.pid));
    const unknown = await recordedInstance(process.pid, null);
    const recovery = await store().recover();
    expect(recovery).toEqual({ removed: [], preserved: 5 });
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(unknown)).toBe(true);
    expect(await first.resolve('owner', [metadata(attachment)], [one.id])).toEqual([attachment]);
    expect(await second.resolve('owner', [metadata(attachment)], [two.id])).toEqual([attachment]);
  } finally { child.proc.kill(); await child.exited; await h.stop(); }
});

test('recovery removes an older instance reusing the current PID only on the same host and platform', async () => {
  const stale = await recordedInstance(process.pid, 1_000);
  const foreignHost = await recordedInstance(process.pid, 1_000);
  const foreignPlatform = await recordedInstance(process.pid, 1_000);
  for (const [path, changed] of [
    [foreignHost, { hostname: `${hostname()}-other`.slice(-255) }],
    [foreignPlatform, { platform: process.platform === 'win32' ? 'linux' : 'win32' }],
  ] as const) {
    const marker = join(path, 'owner.json');
    await writeFile(marker, JSON.stringify({ ...JSON.parse(await fs.readFile(marker, 'utf8')), ...changed }));
  }
  const identity = spyOn(processPlatform, 'startedAt').mockReturnValue(2_000);
  try {
    expect(await store().recover()).toEqual({ removed: [stale.split(/[\\/]/).at(-1)!], preserved: 2 });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(foreignHost)).toBe(true);
    expect(existsSync(foreignPlatform)).toBe(true);
  } finally { identity.mockRestore(); }
});

test('recovery preserves a current-PID instance when its current start identity is unavailable', async () => {
  const recorded = await recordedInstance(process.pid, 1_000);
  const identity = spyOn(processPlatform, 'startedAt').mockReturnValue(null);
  try {
    expect(await store().recover()).toEqual({ removed: [], preserved: 1 });
    expect(existsSync(recorded)).toBe(true);
  } finally { identity.mockRestore(); }
});

test('a process killed during body writing leaves a recorded partial upload recoverable after restart', async () => {
  const h = await startTestCore();
  const ready = join(dataDir, 'partial-ready');
  const script = `
    import { spyOn } from 'bun:test';
    import * as fs from 'node:fs/promises';
    import { AttachmentUploads } from ${JSON.stringify(new URL('../src/attachment-uploads.ts', import.meta.url).href)};
    const write = fs.writeFile;
    spyOn(fs, 'writeFile').mockImplementation(async (path, body, options) => {
      await write(path, body.subarray(0, 3), options);
      await write(process.env.UPLOAD_READY, String(path));
      await new Promise(() => {});
    });
    setInterval(() => {}, 1000);
    await new AttachmentUploads(process.env.UPLOAD_DATA).upload('owner', {
      kind: 'file', name: 'partial.txt', mimeType: 'text/plain', data: Buffer.from('complete bytes').toString('base64')
    });
  `;
  const child = h.core.procs.spawn('upload-crash-fixture', process.execPath, ['-e', script], {
    env: { UPLOAD_READY: ready, UPLOAD_DATA: dataDir },
  });
  const stderr = new Response(child.proc.stderr).text();
  try {
    await waitFor(() => existsSync(ready));
    const body = await fs.readFile(ready, 'utf8');
    expect(await fs.readFile(body, 'utf8')).toBe('com');
    const instance = join(body, '..', '..');
    expect(JSON.parse(await fs.readFile(join(instance, 'owner.json'), 'utf8'))).toMatchObject({ pid: child.proc.pid });
    expect((await store().recover()).removed).toEqual([]);
    expect(existsSync(body)).toBe(true);
    child.proc.kill('SIGKILL');
    await child.exited;
    const recovery = await store().recover();
    expect(recovery.removed).toEqual([instance.split(/[\\/]/).at(-1)!]);
    expect(existsSync(instance)).toBe(false);
    expect(await stderr).toBe('');
  } finally { child.proc.kill(); await child.exited; await h.stop(); }
});

test('unknown legacy, malformed, oversized and linked ownership records remain untouched', async () => {
  const root = join(dataDir, 'attachment-uploads');
  const legacy = join(root, 'legacy-uploads');
  await fs.mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'body'), 'legacy');
  const paths: string[] = [legacy];
  for (const marker of [undefined, '{broken', 'x'.repeat(1025), JSON.stringify({ schemaVersion: 1, pid: process.pid })]) {
    const path = join(root, randomUUID());
    await fs.mkdir(path);
    if (marker !== undefined) await writeFile(join(path, 'owner.json'), marker);
    paths.push(path);
  }
  if (process.platform !== 'win32') {
    const linked = join(root, randomUUID());
    await fs.symlink(legacy, linked);
    paths.push(linked);
    const ownerLink = join(root, randomUUID());
    await fs.mkdir(ownerLink);
    await fs.symlink(join(legacy, 'body'), join(ownerLink, 'owner.json'));
    paths.push(ownerLink);
  }
  expect(await store().recover()).toEqual({ removed: [], preserved: paths.length });
  for (const path of paths) expect(existsSync(path)).toBe(true);
  expect(await fs.readFile(join(legacy, 'body'), 'utf8')).toBe('legacy');
});

test('concurrent startup recovery, first upload and shutdown share one scan and wait for it', async () => {
  await fs.mkdir(join(dataDir, 'attachment-uploads'));
  const opendir = fs.opendir;
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const scanning = spyOn(fs, 'opendir').mockImplementation((async (...args: Parameters<typeof fs.opendir>) => {
    entered();
    await gate;
    return opendir(...args);
  }) as typeof fs.opendir);
  try {
    const uploads = store();
    const recovery = uploads.recover();
    const upload = uploads.upload('owner', file()).then(value => ({ value }), error => ({ error }));
    await started;
    let closed = false;
    const closing = uploads.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    resume();
    await closing;
    expect(await recovery).toEqual({ removed: [], preserved: 0 });
    expect(await upload).toMatchObject({ error: expiry });
    expect(scanning).toHaveBeenCalledTimes(1);
    expect(await bodies()).toEqual([]);
  } finally { resume(); scanning.mockRestore(); }
});

test('accepted upload receipt survives release and expired-reference fallback without duplicating input', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const attachment = file('receipt original bytes');
    const { id } = await client.call('attachments.upload', { attachment });
    const params = { threadId, prompt: 'read once', clientRequestId: 'upload-fallback-receipt', attachments: [metadata(attachment)], attachmentIds: [id] };
    const accepted = await client.call('turns.start', params);
    await client.call('attachments.release', { ids: [id] });
    await expect(client.call('turns.start', params)).rejects.toMatchObject({ rpc: expiry });
    const fallback = await client.call('turns.start', { ...params, attachments: [attachment], attachmentIds: [null] });
    expect(fallback.id).toBe(accepted.id);
    await waitFor(() => h.core.journal.getTurn(accepted.id)?.status === 'done');
    expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
    const user = h.core.journal.listMessages(threadId).filter(message => message.role === 'user');
    expect(user).toHaveLength(1);
    expect(user[0]!.parts).toContainEqual({ type: 'file', name: attachment.name, mimeType: attachment.mimeType, data: attachment.data });
  } finally { await h.stop(); }
});
