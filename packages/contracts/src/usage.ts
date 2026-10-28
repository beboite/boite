import type { ProjectId, ProviderId, ThreadId, Timestamp } from './ids';

/**
 * Tokens as four disjoint buckets, whatever the provider counts: `inputTokens`
 * holds neither the cache reads nor the cache writes, so the four add up to
 * what the model processed. The driver normalises them and the turn keeps
 * them as stored (`buckets`); nothing downstream depends on the provider that
 * ran it.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Of `cacheWriteTokens`, those written to a one-hour cache, which Anthropic
   * bills at twice the input rate. Absent when none were, and on turns an
   * older core recorded with no cache writes.
   */
  cacheWriteHourTokens?: number;
  /**
   * 1 on a turn's usage whose core normalised it into the buckets above.
   * Absent on a turn an older core recorded, whose split followed its
   * provider (Codex's input then held the cache), and on sums of turns.
   */
  buckets?: 1;
  /** API-equivalent cost. On a subscription this is not money spent; the UI says so. */
  costUsdEquivalent: number | null;
}

/** Public API prices in US dollars per million tokens. */
export interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The public model a usage row was priced as, with the rates its tokens were charged. */
export interface UsagePrice {
  /** The id in the core's price list, such as `claude-opus-5-5`. */
  model: string;
  rates: TokenRates;
}

/**
 * The finished turns of one provider and model whose `finishedAt` falls in
 * `[edges[bucket], edges[bucket + 1])` of a `usage.history` call.
 */
export interface UsageHistoryRow {
  bucket: number;
  providerId: ProviderId;
  /** Null when the turn ran on the provider's default model. */
  model: string | null;
  /** Finished turns, whether or not the agent reported its usage. */
  turns: number;
  /** Turns among them that carried a usage report. */
  reported: number;
  /**
   * Turns among them with an API-equivalent cost: every reported turn when the
   * row has a `price`, else the turns whose agent reported a cost.
   */
  priced: number;
  /**
   * Reported turns among them that an older core recorded (`Usage.buckets`
   * absent). Their split and hour writes are estimated from the protocol the
   * provider has now, so editing or removing it can change them. Absent when
   * none, and from an older core.
   */
  estimated?: number;
  /**
   * Sums over the reported turns, in the buckets each turn stored.
   * `costUsdEquivalent` is the tokens at `price`'s rates, or the sum
   * of the costs the agent reported when no rate matched the model; null when
   * neither gave one.
   */
  usage: Usage;
  /** The public rates the row was priced at. Null when none matched its model; absent from an older core. */
  price?: UsagePrice | null;
}

export interface UsageHistoryThread {
  threadId: ThreadId;
  title: string;
  projectId: ProjectId | null;
  providerId: ProviderId;
  archived: boolean;
  turns: number;
  usage: Usage;
}

export interface UsageHistory {
  edges: Timestamp[];
  rows: UsageHistoryRow[];
  /**
   * The threads that spent the most over the whole range, by tokens, by cost
   * and by turns, so a client can rank by any of the three. Unordered.
   */
  threads: UsageHistoryThread[];
}

export interface UsageRpcMethods {
  'usage.get': {
    params: { threadId?: ThreadId };
    result: { byThread: Record<ThreadId, Usage>; total: Usage };
  };
  /**
   * Finished turns summed per bucket, provider and model. `edges` are 2 to 367
   * ascending timestamps chosen by the client, usually its local midnights, so
   * a day follows the reader's calendar whatever the core's time zone.
   * Optional `providerId` filters execution snapshots before ranking threads.
   */
  'usage.history': { params: { edges: Timestamp[]; providerId?: ProviderId }; result: UsageHistory };
}
