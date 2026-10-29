import { expect, test } from 'vitest';
import { ATTACHMENTS_PER_TURN, composerBatch, type ComposerQueuedPrompt } from '@boite/contracts';
import { textEntries } from './composer-queue';

test('pending answers keep their entry objects across thread updates, so keyed bubbles do not remount', () => {
  const entries = textEntries();
  const first = entries(['yes', 'use the parser']);
  const again = entries(['yes', 'use the parser', 'also the lexer']);
  expect(again[0]).toBe(first[0]);
  expect(again[1]).toBe(first[1]);
  expect(entries(['no', 'use the parser'])[0]).not.toBe(first[0]);
});

const attachment = { kind: 'file' as const, name: 'note.txt', mimeType: 'text/plain', data: 'YQ==' };
const reference = { id: 'save', url: 'https://example.test', selector: '#save', text: 'Save', bounds: { x: 0, y: 0, width: 80, height: 30 }, mention: { start: 0, end: 5 } };
const entry = (text: string, id = text): ComposerQueuedPrompt => ({ id, text, attachments: [] });

test('the shared batch carries files, offsets mentions and disambiguates repeated reference ids', () => {
  const first = { ...entry('@Save first'), attachments: [{ kind: attachment.kind, mimeType: attachment.mimeType, name: attachment.name, assetId: 'asset' }], previewReferences: [reference] };
  const second = { ...entry('@Save second'), previewReferences: [reference] };
  const batch = composerBatch([first, second, entry('third')], () => attachment);
  expect(batch.text).toBe('@Save first\n\n@Save second\n\nthird');
  expect(batch.attachments).toEqual([attachment]);
  expect(batch.previewReferences.map(ref => ref.mention)).toEqual([{ start: 0, end: 5 }, { start: 13, end: 18 }]);
  expect(new Set(batch.previewReferences.map(ref => ref.id)).size).toBe(2);
});

test('the shared batch keeps activity commands, request ids and file count limits at separate boundaries', () => {
  expect(composerBatch([entry('first'), entry('/goal Fix the parser'), entry('last')], () => attachment).entries.map(item => item.text)).toEqual(['first']);
  expect(composerBatch([entry('/goal Fix the parser'), entry('last')], () => attachment).entries).toHaveLength(1);
  const request = { id: 'request-id', choice: null, queuedAt: 0 };
  expect(composerBatch([{ ...entry('first'), request }, entry('last')], () => attachment).entries).toHaveLength(1);
  const withFiles = Array.from({ length: ATTACHMENTS_PER_TURN + 1 }, (_, at) => ({ ...entry(`file ${at}`), attachments: [{ kind: attachment.kind, mimeType: attachment.mimeType, name: attachment.name, assetId: 'asset' }] }));
  expect(composerBatch(withFiles, () => attachment).entries).toHaveLength(ATTACHMENTS_PER_TURN);
});
