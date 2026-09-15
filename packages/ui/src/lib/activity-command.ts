import { strings } from './strings';

export type ActivityCommand = { goal: { objective: string } } | { loop: { prompt: string; intervalMs: number } };

/** Boite owns these commands across providers, including on a fresh draft. */
export function activityCommand(text: string): ActivityCommand | null {
  const command = /^\/(goal|loop)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!command) return null;
  const body = command[2]?.trim() ?? '';
  if (!body) throw new Error(command[1] === 'goal' ? strings.activity.goalUsage : strings.activity.loopUsage);
  if (command[1] === 'goal') return { goal: { objective: body } };
  const timed = /^(\d+(?:\.\d+)?)(s|m|h)\s+([\s\S]+)$/.exec(body);
  const intervalMs = timed ? Number(timed[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[timed[2]!] ?? 0) : 300_000;
  if (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 86_400_000) throw new Error(strings.activity.intervalError);
  if (!timed && /^\d+(?:\.\d+)?\S*(?:\s|$)/.test(body)) throw new Error(strings.activity.loopUsage);
  return { loop: { prompt: timed?.[3]?.trim() ?? body, intervalMs } };
}
