import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { Attachment, FileAttachment } from '@boite/contracts';
import { ATTACHMENT_MAX_BYTES, RpcErrorCode } from '@boite/contracts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { checkAttachments } from '../src/threads.ts';
import { fileReference, prepareAttachments } from '../src/attachments.ts';
import { continuationInput } from '../src/continuation.ts';

let harness: TestCore;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { await harness.stop(); });
const file: FileAttachment = { kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-test').toString('base64') };

test('files reach the driver as persistent host paths and remain in history', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const turn = await client.call('turns.start', { threadId, prompt: 'Read this', attachments: [file] });
  await waitFor(() => harness.core.journal.getTurn(turn.id)?.status === 'done');
  const messages = harness.core.journal.listMessages(threadId);
  expect(messages[0]!.parts).toContainEqual({ type: 'file', name: file.name, mimeType: file.mimeType, data: file.data });
  const reply = messages.filter(m => m.role === 'assistant').flatMap(m => m.parts).filter(p => p.type === 'text').map(p => p.text).join('');
  const reference = JSON.parse(reply.slice(reply.indexOf('{"name":"report.pdf"')).trim());
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
    await expect(client.call('turns.start', { threadId, prompt: 'Read', clientRequestId: 'invalid-files', attachments: attachments as never })).rejects.toMatchObject({ rpc: { code: RpcErrorCode.Refused, message: expect.stringContaining('attachment') } });
  }
  expect(harness.core.journal.listTurns(threadId)).toEqual([]);
});
