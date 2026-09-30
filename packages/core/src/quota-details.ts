import type { QuotaCredits, QuotaReading, QuotaWindow } from '@boite/contracts';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function expires(value: unknown): number | null {
  const at = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}
function liveExpiration(value: unknown, now: number): boolean {
  if (value == null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const days = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const at = expires(value);
  return day! <= days && at !== null && at > now;
}

export function codexQuotaDetails(raw: unknown): Pick<QuotaReading, 'resetCredits' | 'credits'> {
  const root = object(raw);
  const bucket = object(object(root['rateLimitsByLimitId'])['codex'] ?? root['rateLimits']);
  const result: Pick<QuotaReading, 'resetCredits' | 'credits'> = {};
  const resets = object(root['rateLimitResetCredits']);
  const count = number(resets['availableCount']);
  if (count !== null && Number.isSafeInteger(count)) {
    const times = (Array.isArray(resets['credits']) ? resets['credits'] : []).flatMap((value) => {
      const row = object(value);
      const at = expires(row['expiresAt']);
      return row['status'] === 'available' && at !== null ? [at] : [];
    });
    result.resetCredits = { availableCount: count, nextExpiresAt: count > 0 && times.length ? Math.min(...times) : null };
  }
  if (!bucket['limitId'] || bucket['limitId'] === 'codex') {
    const value = object(bucket['credits']);
    if (typeof value['hasCredits'] === 'boolean') {
      const balance = value['balance'];
      const parsed = typeof balance === 'string' && /^\d+(?:\.\d+)?$/.test(balance.trim()) ? Number(balance) : balance;
      // hasCredits says there is a balance, not that automatic paid usage is on.
      result.credits = { kind: 'balance', enabled: null, remaining: value['hasCredits'] ? number(parsed) : 0,
        limit: null, unlimited: value['unlimited'] === true };
    }
  }
  return result;
}

export function claudeQuotaDetails(raw: unknown, now = Date.now()): Pick<QuotaReading, 'resetCredits' | 'credits'> {
  const root = object(raw);
  const result: Pick<QuotaReading, 'resetCredits' | 'credits'> = {};
  const ember = object(root['cedar_ember']);
  if (typeof ember['eligible'] === 'boolean' && Array.isArray(ember['grants'])) {
    const grants = ember['grants'].map(object).filter((row) => {
      const left = number(row['resets_left']);
      return ember['eligible'] === true && typeof row['id'] === 'string' && row['id'].length > 0 &&
        (row['paused'] === undefined || row['paused'] === false) && row['usable_now'] === true &&
        left !== null && Number.isSafeInteger(left) && left > 0 &&
        liveExpiration(row['ends_at'], now);
    });
    const next = grants.find((row) => typeof row['id'] === 'string' && row['id'] === ember['next_grant_id']);
    result.resetCredits = { availableCount: next ? grants.reduce((sum, row) => sum + (row['resets_left'] as number), 0) : 0,
      nextExpiresAt: next ? expires(next['ends_at']) : null };
  }
  const extra = object(root['extra_usage']);
  if (typeof extra['is_enabled'] === 'boolean') {
    const limit = number(extra['monthly_limit']);
    const used = number(extra['used_credits']);
    const credits: QuotaCredits = { kind: 'budget', enabled: extra['is_enabled'],
      remaining: limit !== null && used !== null ? Math.max(0, limit - used) : null, limit, unlimited: false };
    result.credits = credits;
  }
  return result;
}

/** Muse reports its host's last observation, not a fresh account probe. */
export function museQuotaReading(raw: unknown): { reading: QuotaReading; observedAt: number } | null {
  const root = object(raw);
  const observedAt = number(root['observedAtMs']);
  if (observedAt === null || !Number.isSafeInteger(observedAt) || observedAt === 0) return null;
  const windows: QuotaWindow[] = [];
  for (const id of ['window', 'weekly']) {
    const value = object(root[id]);
    const percent = number(value['usedPercent']);
    const at = number(value['resetsAtMs']);
    const minutes = number(value['windowDurationMins']);
    if (percent === null || at === null || !Number.isSafeInteger(at) || (id === 'window' && (minutes === null || minutes === 0))) continue;
    windows.push({ id, label: id === 'weekly' ? 'Weekly' : `${minutes! / 60} hours`,
      usedPercent: Math.min(100, percent), resetsAt: at });
  }
  return windows.length ? { reading: { windows }, observedAt } : null;
}
