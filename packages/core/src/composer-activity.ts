import { AUTO_GOAL_MIN_CHARS, type RpcParams } from '@boite/contracts';
import { invalidParams } from './errors.ts';
import { nativeCommandPrompt } from './threads/operations.ts';

export function isComposerActivity(text: string): boolean { return /^\/(goal2?|loop)(?:\s|$)/.test(text.trim()); }

/** Same user command grammar as the composer, executed without a live app. */
export function composerActivity(text: string): Omit<RpcParams<'threads.activity.set'>, 'threadId' | 'attachments'> | null {
  const match = /^\/(goal2|goal|loop)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const body = match[2]?.trim();
  if (!body) throw invalidParams(`/${match[1]}: expected an objective or loop cadence and prompt`);
  if (match[1] !== 'loop') return { goal: { objective: body, ...(match[1] === 'goal2' ? { review: true } : {}) } };
  const timed = /^(\d+(?:\.\d+)?)(s|m|h)\s+([\s\S]+)$/.exec(body);
  if (timed) {
    const intervalMs = Number(timed[1]) * ({ s: 1000, m: 60000, h: 3600000 }[timed[2]!] ?? 0);
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 86400000) throw invalidParams('/loop: expected an interval between 1 second and 24 hours');
    return { loop: { prompt: timed[3]!.trim(), intervalMs } };
  }
  const counted = /^(\d+)(?:x|\s+(?:iterations?|itérations?|fois|times))?\s+([\s\S]+)$/i.exec(body);
  const count = Number(counted?.[1] ?? /\b(\d+)\s+(?:itérations?|iterations?|fois|times)\b/i.exec(body)?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw invalidParams('/loop: expected 1 to 1000 iterations and a prompt');
  return { loop: { prompt: counted?.[2]?.trim() ?? body, intervalMs: 0, maxIterations: count } };
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

