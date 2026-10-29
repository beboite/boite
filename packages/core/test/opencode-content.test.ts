import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QuestionAnswer } from '@boite/contracts';
import { openCodeContent } from '../src/drivers/acp/opencode-content.ts';
import { answerOpenCodeForm } from '../src/drivers/acp/opencode-forms.ts';
import type { AcpTurn } from '../src/drivers/acp/turn.ts';

let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

test('native tool results keep text, images and a completed file diff without reading oversized files', async () => {
  directory = mkdtempSync(join(tmpdir(), 'boite-opencode-content-'));
  writeFileSync(join(directory, 'file.txt'), 'after\n');
  writeFileSync(join(directory, 'large.txt'), 'x'.repeat(65537));
  const patch = '--- file.txt\n+++ file.txt\n@@ -1 +1 @@\n-before\n+after\n';
  expect(await openCodeContent([{ type: 'text', text: 'written' }, { type: 'file', uri: 'data:image/png;base64,YQ==' }], { files: [
    { file: 'file.txt', status: 'modified', patch },
    { file: 'large.txt', status: 'modified', patch },
  ] }, directory)).toEqual([
    { type: 'content', content: { type: 'text', text: 'written' } },
    { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'YQ==' } },
    { type: 'diff', path: join(directory, 'file.txt'), oldText: 'before\n', newText: 'after\n' },
  ]);
});

test('a native form sends field keys and typed answers back to the same session', async () => {
  const requests: unknown[] = [];
  const replies: QuestionAnswer[] = [{ optionIds: ['parser'] }, { optionIds: [], text: '3' }];
  const turn = {
    isStopped: false, settled: false, stopped: new Promise(() => {}), takeIndex: () => 0, part() {},
    ctx: { askQuestion(ask: unknown) { requests.push(ask); return Object.assign(Promise.resolve(replies.shift()!), { questionId: 'question' }); } },
  } as unknown as AcpTurn;
  const calls: unknown[] = [];
  await answerOpenCodeForm(turn, { id: 'form_1', sessionID: 'ses_1', title: 'Review', fields: [
    { key: 'target', type: 'string', options: [{ value: 'parser', label: 'Parser' }] },
    { key: 'other', type: 'string', when: [{ key: 'target', op: 'eq', value: 'other' }] },
    { key: 'attempts', type: 'integer' },
  ] }, async (...args) => { calls.push(args); return {}; });
  expect(requests).toHaveLength(2);
  expect(calls).toEqual([['/api/session/ses_1/form/form_1/reply', 'POST', { answer: { target: 'parser', attempts: 3 } }]]);
});
