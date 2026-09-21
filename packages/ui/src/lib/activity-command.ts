import { strings } from './i18n.svelte';

export type ActivityCommand = { goal: { objective: string } } | { loop: { prompt: string; intervalMs: number; maxIterations?: number } };

/** A loop needs an explicit cadence or iteration count, never an invented timer. */
export function activityCommand(text: string): ActivityCommand | null {
  const command = /^\/(goal|loop)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!command) return null;
  const body = command[2]?.trim() ?? '';
  if (!body) throw new Error(command[1] === 'goal' ? strings.activity.goalUsage : strings.activity.loopUsage);
  if (command[1] === 'goal') return { goal: { objective: body } };
  const timed = /^(\d+(?:\.\d+)?)(s|m|h)\s+([\s\S]+)$/.exec(body);
  if (timed) {
    const intervalMs = Number(timed[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[timed[2]!] ?? 0);
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 86_400_000) throw new Error(strings.activity.intervalError);
    return { loop: { prompt: timed[3]!.trim(), intervalMs } };
  }
  const counted = /^(\d+)(?:x|\s+(?:iterations?|itérations?|fois|times))?\s+([\s\S]+)$/i.exec(body);
  const inPrompt = /\b(\d+)\s+(?:itérations?|iterations?|fois|times)\b/i.exec(body);
  const count = Number(counted?.[1] ?? inPrompt?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error(strings.activity.loopUsage);
  return { loop: { prompt: counted?.[2]?.trim() ?? body, intervalMs: 0, maxIterations: count } };
}
