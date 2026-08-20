import type { CodexSwitcherAccount, KebaccSwitcherAccount, KebaccUsageWindow } from "$lib/backend/types";

export type UsageWindow = {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  reset: string | null;
};

export type AccountRow = {
  id: string;
  provider: string;
  email: string;
  active: boolean;
  windows: UsageWindow[];
  source: "kebacc" | "codex-switcher";
};

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value && value !== "null" ? value : null;
}

/** Walk an object of `{ label: { used_percent, remaining_percent, reset } }`. */
export function windowsFromUsage(usage: unknown): UsageWindow[] {
  if (!usage || typeof usage !== "object") return [];
  const out: UsageWindow[] = [];
  for (const [key, val] of Object.entries(usage as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const row = val as Record<string, unknown>;
    out.push({
      label: key.replace(/_/g, " "),
      usedPercent: asNumber(row.used_percent),
      remainingPercent: asNumber(row.remaining_percent),
      reset: asString(row.resets_at) ?? asString(row.reset),
    });
  }
  return out;
}

export function windowsFromKebacc(account: KebaccSwitcherAccount): UsageWindow[] {
  if (!Array.isArray(account.windows)) return [];
  return account.windows.map((w: KebaccUsageWindow) => ({
    label: w.label,
    usedPercent: asNumber(w.used_percent),
    remainingPercent: asNumber(w.remaining_percent),
    reset: asString(w.reset),
  }));
}

export function rowFromKebacc(provider: string, account: KebaccSwitcherAccount): AccountRow {
  return {
    id: account.email,
    provider,
    email: account.email,
    active: account.active,
    windows: windowsFromKebacc(account),
    source: "kebacc",
  };
}

export function rowFromCodexSwitcher(account: CodexSwitcherAccount): AccountRow {
  return {
    id: account.id,
    provider: "codex",
    email: account.email,
    active: account.is_active,
    windows: windowsFromUsage(account.usage ?? null),
    source: "codex-switcher",
  };
}

/** `94%` when the CLI said used, else remaining, else nothing. */
export function windowPercent(window: UsageWindow): string | null {
  if (window.usedPercent != null) return `${Math.round(window.usedPercent)}%`;
  if (window.remainingPercent != null) return `${Math.round(window.remainingPercent)}%`;
  return null;
}

/**
 * A reset the CLI already worded ("9h13m") stays that way. An ISO timestamp
 * becomes a short remaining span against `now`.
 */
export function formatReset(reset: string | null, now: number): string | null {
  if (!reset) return null;
  const ms = Date.parse(reset);
  if (Number.isNaN(ms)) return reset;
  const delta = ms - now;
  if (delta <= 0) return null;
  const hours = Math.floor(delta / 3_600_000);
  const minutes = Math.floor((delta % 3_600_000) / 60_000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
