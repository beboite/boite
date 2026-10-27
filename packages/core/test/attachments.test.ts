import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { readFileSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { Attachment, FileAttachment } from '@boite/contracts';
import { ATTACHMENT_MAX_BYTES, RpcErrorCode } from '@boite/contracts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { checkAttachments } from '../src/threads/inputs.ts';
import { FileReferences, fileReference, prepareAttachments } from '../src/attachments.ts';
import { continuationInput } from '../src/continuation.ts';
import { rejection } from './settle.ts';

let harness: TestCore;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { await harness.stop(); });
const file: FileAttachment = { kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-test').toString('base64') };

test('files reach the driver as persistent host paths and remain in history', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  await client.call('brain.configure', { path: null, enabled: false, boiteGuide: true });
  const turn = await client.call('turns.start', { threadId, prompt: 'Read this', attachments: [file] });
  await waitFor(() => harness.core.journal.getTurn(turn.id)?.status === 'done');
  const messages = harness.core.journal.listMessages(threadId);
  expect(messages[0]!.parts).toContainEqual({ type: 'file', name: file.name, mimeType: file.mimeType, data: file.data });
  const reply = messages.filter(m => m.role === 'assistant').flatMap(m => m.parts).filter(p => p.type === 'text').map(p => p.text).join('');
  expect(reply).toContain('boite threads send');
  const referenceLine = reply.split('\n').find(line => line.startsWith('{"name":"report.pdf"'));
  expect(referenceLine).toBeDefined();
  const reference = JSON.parse(referenceLine!);
  expect(reference).toMatchObject({ name: file.name, mimeType: file.mimeType, bytes: Buffer.from(file.data, 'base64').length });
  expect(isAbsolute(reference.path)).toBe(true);
  expect(readFileSync(reference.path).toString()).toBe('%PDF-test');
  const continued = continuationInput(harness.core.journal, threadId, 'next-turn', { prompt: 'Now summarize', attachments: [] }, harness.core.providers.require('echo'), part => fileReference(harness.dataDir, part));
  expect(continued.prompt).toContain(JSON.stringify(reference.path));
  expect(continued.attachments).toEqual([]);
});

test('file names cannot escape storage or use Windows device names; empty files work', () => {
  for (const name of ['../../outside.txt', 'C:\\outside.txt', 'CON', 'evil:stream', 'file\nname', '..']) {
    const ref = JSON.parse(fileReference(harness.dataDir, { ...file, name, data: '' }));
    expect(relative(harness.dataDir, ref.path).startsWith('..')).toBe(false);
    expect(readFileSync(ref.path).length).toBe(0);
    expect(fileReference(harness.dataDir, { ...file, name, data: '' })).toBe(JSON.stringify(ref));
  }
});

test('re-uploading a file does not reuse an agent-modified copy', async () => {
  const { writeFileSync } = await import('node:fs');
  const first = JSON.parse(fileReference(harness.dataDir, file));
  writeFileSync(first.path, 'changed by an agent');
  const next = JSON.parse(fileReference(harness.dataDir, file));
  expect(readFileSync(next.path).toString()).toBe('%PDF-test');
  expect(readFileSync(first.path).toString()).toBe('changed by an agent');
  // A thread's remembered line is dropped once the copy it names changes.
  const references = new FileReferences(harness.dataDir);
  const part = { type: 'file' as const, name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('notes').toString('base64') };
  const place = { messageId: 'msg', partIndex: 0 };
  const line = references.of('thr', part, place);
  expect(references.of('thr', part, place)).toBe(line);
  writeFileSync(JSON.parse(line).path, 'edited');
  const fresh = JSON.parse(references.of('thr', part, place));
  expect(fresh.path).not.toBe(JSON.parse(line).path);
  expect(readFileSync(fresh.path).toString()).toBe('notes');
});

test('re-uploading checks same-size edits but does not read an enlarged local copy', () => {
  const first = JSON.parse(fileReference(harness.dataDir, file));
  const read = spyOn(fs, 'readFileSync');
  try {
    expect(JSON.parse(fileReference(harness.dataDir, file)).path).toBe(first.path);
    expect(read.mock.calls.filter(([path]) => path === first.path)).toHaveLength(0);

    const earlier = new Date(Date.now() - 2000);
    utimesSync(first.path, earlier, earlier);
    expect(JSON.parse(fileReference(harness.dataDir, file)).path).toBe(first.path);
    expect(read.mock.calls.filter(([path]) => path === first.path)).toHaveLength(1);
    read.mockClear();

    const edit = 'x'.repeat(Buffer.from(file.data, 'base64').length);
    writeFileSync(first.path, edit);
    const later = new Date(Date.now() + 2000);
    utimesSync(first.path, later, later);
    const changed = JSON.parse(fileReference(harness.dataDir, file));
    expect(changed.path).not.toBe(first.path);
    expect(read.mock.calls.filter(([path]) => path === first.path)).toHaveLength(1);
    expect(readFileSync(first.path, 'utf8')).toBe(edit);
    expect(readFileSync(changed.path, 'utf8')).toBe('%PDF-test');

    truncateSync(first.path, 8 * 1024 * 1024);
    read.mockClear();
    const grown = JSON.parse(fileReference(harness.dataDir, file));
    expect(grown.path).not.toBe(first.path);
    expect(read.mock.calls.filter(([path]) => path === first.path)).toHaveLength(0);
    expect(statSync(first.path).size).toBe(8 * 1024 * 1024);
    expect(readFileSync(grown.path, 'utf8')).toBe('%PDF-test');
  } finally {
    read.mockRestore();
  }
});

test('only images depend on provider image support; malformed and oversized files are refused', () => {
  const provider = structuredClone(harness.core.providers.require('echo'));
  provider.capabilities.images = false;
  expect(() => checkAttachments([file, { ...file, data: '' }], provider)).not.toThrow();
  expect(() => checkAttachments([{ ...file, kind: 'image', mimeType: 'image/png' }], provider)).toThrow('takes no images');
  for (const change of [{ data: 'not base64' }, { mimeType: 'text/plain\ninvalid' }, { name: 1 }, { kind: 'other' }, { data: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1).toString('base64') }]) {
    expect(() => checkAttachments([{ ...file, ...change } as Attachment], provider)).toThrow();
  }
  const image: Attachment = { kind: 'image', name: 'pixel.png', mimeType: 'image/png', data: 'YWJj' };
  const prepared = prepareAttachments(harness.dataDir, { prompt: 'Compare', attachments: [file, image] });
  expect(prepared.attachments).toEqual([image]);
  expect(prepared.prompt).toContain('report.pdf');
});

test('malformed attachment arrays are refused before retry fingerprinting', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  for (const attachments of [{}, [null]]) {
    expect((await rejection(client.call('turns.start', { threadId, prompt: 'Read', clientRequestId: 'invalid-files', attachments: attachments as never }))).reason).toMatchObject({ rpc: { code: RpcErrorCode.Refused, message: expect.stringContaining('attachment') } });
  }
  expect(harness.core.journal.listTurns(threadId)).toEqual([]);
});
