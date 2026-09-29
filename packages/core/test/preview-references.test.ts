import { expect, test } from 'bun:test';
import { previewReferencesError, type PreviewReference } from '@boite/contracts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import { continuationInput } from '../src/continuation.ts';

const reference: PreviewReference = { id: 'element-1', url: 'https://example.test/shop', selector: 'button:nth-of-type(2)', shadowPath: ['#checkout'], text: 'Buy now', bounds: { x: 10, y: 20, width: 120, height: 40 }, surfaceId: 'browser:checkout' };

test('inline reference ranges bind to visible text without overlap or out-of-bounds positions', () => {
  const prompt = 'Make @Buy now clearer.';
  const inline = { ...reference, mention: { start: 5, end: 13 } };
  expect(previewReferencesError([inline], prompt)).toBeNull();
  expect(previewReferencesError([reference], prompt)).toBeNull();
  for (const mention of [{ start: -1, end: 13 }, { start: 5.5, end: 13 }, { start: 5, end: 5 }, { start: 5, end: 99 }, { start: 0, end: 4 }, { start: 5, end: 13, extra: true }]) {
    expect(previewReferencesError([{ ...reference, mention }], prompt)).toContain('mention');
  }
  expect(previewReferencesError([inline, { ...inline, id: 'overlapping' }], prompt)).toContain('overlap');
});

test('preview URLs with credentials are refused before they reach the journal or driver', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    for (const url of ['https://user@example.test', 'https://:password@example.test', 'https://user:%70assword@example.test']) {
      await expect(client.call('turns.start', { threadId, prompt: 'Check this', previewReferences: [{ ...reference, url }] })).rejects.toThrow('without credentials');
    }
    expect(h.core.journal.listTurns(threadId)).toHaveLength(0);
    expect(h.core.journal.listMessages(threadId)).toHaveLength(0);
  } finally { await h.stop(); }
});

test('preview references reach drivers and continuation as untrusted context while visible prose stays compact', async () => {
  const inline = { ...reference, mention: { start: 5, end: 13 } };
  const prompt = 'Make @Buy now clearer.';
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const turn = await client.call('turns.start', { threadId, prompt, previewReferences: [inline], clientRequestId: 'preview-retry-1' });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
    const messages = h.core.journal.listMessages(threadId);
    const part = messages.find(message => message.role === 'user')!.parts[0]!;
    expect(part.type).toBe('text');
    if (part.type !== 'text') throw new Error('missing text');
    expect(part.displayText).toBe(prompt);
    expect(part.previewReferences).toEqual([inline]);
    expect(part.text).toContain('untrusted page data');
    expect(part.text).toContain('"shadowPath"');
    expect(part.text).toContain(reference.url);
    const answer = messages.filter(message => message.role === 'assistant').flatMap(message => message.parts).filter(part => part.type === 'text').map(part => part.text).join('');
    expect(answer).toContain('Buy now');
    expect(answer).toContain(reference.selector);
    const continued = continuationInput(h.core.journal, threadId, 'next-preview-turn', { prompt: 'Continue', attachments: [] }, h.core.providers.require('echo'));
    expect(continued.prompt).toContain(reference.selector);
    const retry = await client.call('turns.start', { threadId, prompt, previewReferences: [inline], clientRequestId: 'preview-retry-1' });
    expect(retry.id).toBe(turn.id);
    await expect(client.call('turns.start', { threadId, prompt, previewReferences: [{ ...inline, selector: '#different' }], clientRequestId: 'preview-retry-1' })).rejects.toThrow('different content');
  } finally { await h.stop(); }
});

test('preview reference validation refuses malformed, oversized and unknown fields before creating a turn', async () => {
  const h = await startTestCore();
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    for (const patch of [{ url: 'file:///secret' }, { bounds: { ...reference.bounds, width: -1 } }, { text: 'x'.repeat(1001) }, { shadowPath: Array(9).fill('#host') }, { extra: 'unexpected' }]) {
      await expect(client.call('turns.start', { threadId, prompt: 'Test', previewReferences: [{ ...reference, ...patch }] })).rejects.toThrow('previewReferences');
    }
    expect(h.core.journal.listTurns(threadId)).toHaveLength(0);
    expect(previewReferencesError([reference, reference])).toContain('unique');
    expect(previewReferencesError(Array(9).fill(reference))).toContain('at most 8');
  } finally { await h.stop(); }
});
