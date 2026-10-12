import { describe, expect, it } from 'vitest';
import type { ComposerState } from './composer-queue';
import { checkpoint, editKind, HISTORY_LIMIT, historyDepth, recordEdit, redoStep, settled, undoStep } from './composer-history';

function state(text = ''): ComposerState {
  return { text, attachments: [], queued: [], sending: false, paused: false };
}

/** One key the way the composer records it: the step first, then the text the edit left. */
function key(target: ComposerState, typed: string, now: number): void {
  const at = target.text.length;
  recordEdit(target, editKind('insertText', { start: at, end: at }), { start: at, end: at }, typed, now);
  target.text += typed;
  settled(target);
}

function erase(target: ComposerState, now: number): void {
  const at = target.text.length;
  recordEdit(target, editKind('deleteContentBackward', { start: at - 1, end: at }), { start: at, end: at }, null, now);
  target.text = target.text.slice(0, -1);
  settled(target);
}

function undoAll(target: ComposerState): string[] {
  const seen: string[] = [];
  for (let step = undoStep(target); step; step = undoStep(target)) { target.text = step.text; seen.push(step.text); }
  return seen;
}

describe('composer history', () => {
  it('groups typing by word, by pause and by kind, like an editor', () => {
    const target = state();
    for (const [index, letter] of [...'hello world'].entries()) key(target, letter, index * 100);
    // A pause, then two letters erased: one step of its own kind.
    erase(target, 5000);
    erase(target, 5100);
    key(target, '!', 5200);
    expect(undoAll(target)).toEqual(['hello wor', 'hello world', 'hello', '']);
  });

  it('makes every big edit its own step, and a new edit drops what redo held', async () => {
    const target = state('keep this');
    recordEdit(target, editKind('deleteContentBackward', { start: 0, end: 9 }), { start: 0, end: 9 });
    target.text = '';
    settled(target);
    key(target, 'x', 10);
    const back = undoStep(target)!;
    target.text = back.text;
    expect(back.text).toBe('');
    target.text = undoStep(target)!.text;
    expect(target.text).toBe('keep this');
    expect(historyDepth(target)).toEqual({ undo: 0, redo: 2 });
    target.text = redoStep(target)!.text;
    expect(target.text).toBe('');
    // The deletion's operation is over: the next write is a new edit.
    await Promise.resolve();
    checkpoint(target);
    expect(historyDepth(target).redo).toBe(0);
  });

  it('keeps one step per operation and at most the cap', async () => {
    const target = state();
    checkpoint(target);
    target.text = 'a';
    checkpoint(target);
    expect(historyDepth(target).undo).toBe(1);
    for (let index = 0; index < HISTORY_LIMIT + 20; index++) {
      await Promise.resolve();
      checkpoint(target);
      target.text = String(index);
    }
    expect(historyDepth(target).undo).toBe(HISTORY_LIMIT);
  });
});
