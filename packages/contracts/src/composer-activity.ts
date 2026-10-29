import type { RpcParams } from './index';
export type ComposerActivityIssue = 'goalUsage' | 'goal2Usage' | 'loopUsage' | 'intervalError';

export function isComposerActivity(text: string): boolean {
  return /^\/(goal2?|loop)(?:\s|$)/.test(text.trim());
}

/** Same user command grammar as the composer, executed without a live app. */
export function composerActivity(text: string, fail: (issue: ComposerActivityIssue, message: string) => Error = (_issue, message) => new Error(message)): Omit<RpcParams<'threads.activity.set'>, 'threadId' | 'attachments'> | null {
  const match = /^\/(goal2|goal|loop)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const body = match[2]?.trim();
  if (!body) throw fail(match[1] === 'goal' ? 'goalUsage' : match[1] === 'goal2' ? 'goal2Usage' : 'loopUsage', `/${match[1]}: expected an objective or loop cadence and prompt`);
  if (match[1] !== 'loop') return { goal: { objective: body, ...(match[1] === 'goal2' ? { review: true } : {}) } };
  const timed = /^(\d+(?:\.\d+)?)(s|m|h)\s+([\s\S]+)$/.exec(body);
  if (timed) {
    const intervalMs = Number(timed[1]) * ({ s: 1000, m: 60000, h: 3600000 }[timed[2]!] ?? 0);
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 86400000) throw fail('intervalError', '/loop: expected an interval between 1 second and 24 hours');
    return { loop: { prompt: timed[3]!.trim(), intervalMs } };
  }
  const counted = /^(\d+)(?:x|\s+(?:iterations?|itérations?|fois|times))?\s+([\s\S]+)$/i.exec(body);
  const count = Number(counted?.[1] ?? /\b(\d+)\s+(?:itérations?|iterations?|fois|times)\b/i.exec(body)?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw fail('loopUsage', '/loop: expected 1 to 1000 iterations and a prompt');
  return { loop: { prompt: counted?.[2]?.trim() ?? body, intervalMs: 0, maxIterations: count } };
}

/** Canonical comparison for choices and origins; field order carries no meaning. */
export const stableComposerValue = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  return item;
});
