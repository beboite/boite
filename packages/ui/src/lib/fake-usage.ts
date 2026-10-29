import type { ThreadId, TokenRates, Usage, UsageHistory, UsageHistoryRow, UsageHistoryThread, UsagePrice } from '@boite/contracts';

/**
 * The ledger `?fake=1` answers `usage.history` from: about a hundred days of
 * several providers, with a weekday rhythm, derived from the calendar day so a
 * reload draws the same page. It follows the core's contract: the four token
 * buckets are disjoint, a model with public rates is priced at them, and a
 * model without rates or a reported cost has a null cost.
 */

/** A turn the fake itself finished during this session. */
export interface FakeFinishedTurn {
  at: number;
  threadId: ThreadId;
  title: string;
  projectId: string | null;
  providerId: string;
  model: string | null;
  usage: Usage;
}

/** The rates the core's price list gives these models, USD per million tokens. */
function rated(model: string, input: number, output: number, cacheRead: number, cacheWrite: number): UsagePrice {
  const rates: TokenRates = { input, output, cacheRead, cacheWrite };
  return { model, rates };
}

interface Profile {
  providerId: string;
  /** `price` is what the core prices the model at; a reported cost stands in where it has none. */
  models: { id: string | null; share: number; price?: UsagePrice; reported?: TokenRates }[];
  /** Turns on a busy weekday. */
  perDay: number;
  /** Days before today the provider was first used. */
  since: number;
  /** Chance that a day has no turn at all. */
  idle: number;
  /** Tokens per turn: input without cache, output, cache read, cache write. */
  tokens: [number, number, number, number];
  /** Its turns write the one-hour cache, as Claude Code does. */
  hourCache?: boolean;
  /** The threads its turns land in, most recent first. */
  threads: { id: ThreadId; title: string }[];
}

const PROFILES: Profile[] = [
  {
    providerId: 'claude',
    // Claude Code writes its cache for an hour, twice the input rate.
    models: [
      { id: 'claude-opus-5-5', share: 0.45, price: rated('claude-opus-5-5', 4, 20, 0.2, 8) },
      { id: 'claude/claude-opus-5-5', share: 0.15, price: rated('claude-opus-5-5', 4, 20, 0.2, 8) },
      { id: 'claude-sonnet-5-5', share: 0.3, price: rated('claude-sonnet-5-5', 2, 10, 0.1, 4) },
      { id: 'claude-haiku-5-5', share: 0.1, price: rated('claude-haiku-5-5', 0.1, 0.5, 0.01, 0.2) },
    ],
    perDay: 42, since: 104, idle: 0.03,
    tokens: [2_600, 1_800, 61_000, 7_200],
    hourCache: true,
    threads: [
      { id: 't-trace', title: 'Finish the trace tab' },
      { id: 'u-claude-panel', title: 'Right panel with changes and files' },
      { id: 'u-claude-cli', title: 'boite CLI for agents' },
      { id: 'u-claude-phone', title: 'Phone settings split' },
      { id: 'u-claude-dictation', title: 'Dictation and attachments' },
      { id: 'u-claude-platform', title: 'Isolate the OS backends' },
      { id: 'u-claude-onboarding', title: 'First run without a provider' },
    ],
  },
  {
    providerId: 'codex',
    models: [{ id: 'gpt-6.1-sol', share: 0.75, price: rated('gpt-6.1-sol', 2, 10, 0.1, 2.5) }, { id: null, share: 0.25 }],
    perDay: 22, since: 92, idle: 0.1,
    tokens: [8_400, 2_300, 39_000, 0],
    threads: [
      { id: 't-scheduler', title: 'Port the scheduler' },
      { id: 'u-codex-install', title: 'Managed Codex install' },
      { id: 'u-codex-quota', title: 'Read the Codex rate limits' },
      { id: 'u-codex-review', title: 'Review the journal migration' },
    ],
  },
  {
    providerId: 'opencode',
    models: [{ id: null, share: 1, reported: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 } }],
    perDay: 8, since: 71, idle: 0.3,
    tokens: [5_800, 1_300, 21_000, 0],
    threads: [
      { id: 't-bench', title: 'Bench against legacy' },
      { id: 'u-opencode-acp', title: 'ACP permission cards' },
    ],
  },
  {
    providerId: 'grok',
    models: [{ id: 'grok-code-fast-2', share: 1 }],
    perDay: 10, since: 37, idle: 0.25,
    tokens: [7_200, 1_600, 18_000, 0],
    threads: [
      { id: 'u-grok-search', title: 'Workspace search ranking' },
      { id: 'u-grok-titles', title: 'Shorter thread titles' },
    ],
  },
  {
    providerId: 'antigravity',
    models: [{ id: null, share: 1 }],
    perDay: 5, since: 23, idle: 0.5,
    tokens: [9_500, 2_100, 12_000, 0],
    threads: [{ id: 'u-antigravity-quota', title: 'Antigravity quota reader' }],
  },
  {
    providerId: 'pi',
    models: [{ id: 'claude-sonnet-5-5', share: 1, price: rated('claude-sonnet-5-5', 2, 10, 0.1, 2.5) }],
    perDay: 4, since: 58, idle: 0.55,
    tokens: [3_100, 1_200, 26_000, 3_000],
    threads: [{ id: 't-descriptors', title: 'Review the descriptor loader' }],
  },
  {
    providerId: 'muse', models: [{ id: 'default', share: 1 }],
    perDay: 6, since: 17, idle: 0.2,
    tokens: [3_500, 1_500, 15_000, 0],
    threads: [{ id: 'u-muse-tools', title: 'Map the Muse tools' }],
  },
];

const DAY = 86_400_000;

/** A small deterministic generator, so a day draws the same numbers every time. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function localMidnight(at: number): Date {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: null };
}

function addUsage(into: Usage, from: Usage): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  const hour = (into.cacheWriteHourTokens ?? 0) + (from.cacheWriteHourTokens ?? 0);
  if (hour > 0) into.cacheWriteHourTokens = hour;
  if (from.costUsdEquivalent !== null) into.costUsdEquivalent = (into.costUsdEquivalent ?? 0) + from.costUsdEquivalent;
}

interface Group {
  at: number;
  threadId: ThreadId;
  title: string;
  projectId: string | null;
  providerId: string;
  model: string | null;
  turns: number;
  reported: number;
  priced: number;
  usage: Usage;
  price: UsagePrice | null;
}

/** What one calendar day of the seed spent, as groups of turns sharing a thread and a model. */
function seededDay(day: Date, today: Date, now: number): Group[] {
  const age = Math.round((today.getTime() - day.getTime()) / DAY);
  const weekday = day.getDay();
  const rhythm = weekday === 0 ? 0.18 : weekday === 6 ? 0.3 : 1;
  // Busier towards today, the way a project picks up.
  const trend = 0.55 + 0.5 * Math.max(0, 1 - age / 100);
  // Today is still going.
  const elapsed = age === 0 ? Math.max(0.2, (now - day.getTime()) / DAY) : 1;
  const stamp = day.getFullYear() * 10_000 + (day.getMonth() + 1) * 100 + day.getDate();
  const groups: Group[] = [];
  PROFILES.forEach((profile, index) => {
    if (age > profile.since) return;
    const draw = random(stamp * 31 + index * 7919);
    if (draw() < profile.idle) return;
    const count = Math.round(profile.perDay * rhythm * trend * elapsed * (0.55 + draw() * 0.9));
    if (count === 0) return;
    const thread = profile.threads[Math.floor(age / 5) % profile.threads.length]!;
    for (const model of profile.models) {
      const turns = Math.round(count * model.share);
      if (turns === 0) continue;
      const reported = turns - (draw() < 0.3 ? 1 : 0);
      const scale = reported * (0.75 + draw() * 0.5);
      const [input, output, cacheRead, cacheWrite] = profile.tokens.map((tokens) => Math.round(tokens * scale)) as [number, number, number, number];
      const rates = model.price?.rates ?? model.reported ?? null;
      const usage: Usage = {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        ...(profile.hourCache && cacheWrite > 0 ? { cacheWriteHourTokens: cacheWrite } : {}),
        costUsdEquivalent: rates === null ? null : (input * rates.input + output * rates.output + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite) / 1_000_000,
      };
      groups.push({
        at: day.getTime() + Math.min(DAY - 1, (13 + index) * 3_600_000),
        threadId: thread.id,
        title: thread.title,
        projectId: 'p-boite',
        providerId: profile.providerId,
        model: model.id,
        turns,
        reported,
        priced: rates === null ? 0 : reported,
        usage,
        price: model.price ?? null,
      });
    }
  });
  return groups.filter((group) => group.at <= now);
}

export function fakeUsageHistory(edges: number[], options: { seeded: boolean; finished: FakeFinishedTurn[]; now?: number; providerId?: string }): UsageHistory {
  const now = options.now ?? Date.now();
  const first = edges[0]!;
  const last = edges[edges.length - 1]!;
  const groups: Group[] = [];
  if (options.seeded) {
    const today = localMidnight(now);
    for (let day = localMidnight(first); day.getTime() < last && day.getTime() <= now; day.setDate(day.getDate() + 1)) {
      groups.push(...seededDay(new Date(day), today, now));
    }
  }
  for (const turn of options.finished) {
    // A turn finished here is priced like the seeded ones: at its model's rates when the ledger lists them.
    const price = PROFILES.find((profile) => profile.providerId === turn.providerId)?.models.find((model) => model.id === turn.model)?.price ?? null;
    const usage = { ...turn.usage };
    if (price !== null) usage.costUsdEquivalent = (usage.inputTokens * price.rates.input + usage.outputTokens * price.rates.output + usage.cacheReadTokens * price.rates.cacheRead + usage.cacheWriteTokens * price.rates.cacheWrite) / 1_000_000;
    groups.push({ ...turn, turns: 1, reported: 1, priced: usage.costUsdEquivalent === null ? 0 : 1, usage, price });
  }

  const rows = new Map<string, UsageHistoryRow>();
  const threads = new Map<ThreadId, UsageHistoryThread>();
  for (const group of groups) {
    if (group.at < first || group.at >= last) continue;
    if (options.providerId !== undefined && group.providerId !== options.providerId) continue;
    let bucket = 0;
    while (edges[bucket + 1]! <= group.at) bucket += 1;
    const key = `${bucket}\u0000${group.providerId}\u0000${group.model ?? ''}`;
    const row = rows.get(key) ?? { bucket, providerId: group.providerId, model: group.model, turns: 0, reported: 0, priced: 0, usage: emptyUsage(), price: group.price };
    row.turns += group.turns;
    row.reported += group.reported;
    row.priced += group.priced;
    addUsage(row.usage, group.usage);
    rows.set(key, row);
    const thread = threads.get(group.threadId) ?? { threadId: group.threadId, title: group.title, projectId: group.projectId, providerId: group.providerId, archived: group.threadId.startsWith('u-'), turns: 0, usage: emptyUsage() };
    thread.turns += group.turns;
    addUsage(thread.usage, group.usage);
    threads.set(group.threadId, thread);
  }
  const ordered = [...rows.values()].sort((a, b) => a.bucket - b.bucket || a.providerId.localeCompare(b.providerId) || (a.model ?? '').localeCompare(b.model ?? ''));
  return { edges: [...edges], rows: ordered, threads: [...threads.values()] };
}
