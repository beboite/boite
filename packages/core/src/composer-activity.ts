import { AUTO_GOAL_MIN_CHARS, composerActivity as parse, isComposerActivity } from '@boite/contracts';
import { invalidParams } from './errors.ts';
import { nativeCommandPrompt } from './threads/operations.ts';
export { isComposerActivity } from '@boite/contracts';

export function composerActivity(text: string) {
  try { return parse(text); }
  catch (error) { throw invalidParams(error instanceof Error ? error.message : String(error)); }
}

/**
 * Whether a prompt that starts a turn also starts an automatic reviewed goal
 * (the `auto-goal` experiment, `docs/goals.md`): the sending app had it on and
 * the prompt, no command, holds at least `minChars` characters. Decided from
 * the experiments the prompt was sent or queued with, so a restart or another
 * device's switch never changes what a queued prompt means.
 */
export function startsAutoGoal(text: string, experiments: readonly string[] | null | undefined, minChars: number = AUTO_GOAL_MIN_CHARS.default): boolean {
  if (!experiments?.includes('auto-goal') || isComposerActivity(text) || nativeCommandPrompt(text)) return false;
  return text.trim().length >= minChars;
}
