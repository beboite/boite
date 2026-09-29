import type { Database } from 'bun:sqlite';

/** What `usageByBucket` and `usageByThread` sum over a group of finished turns. */
export interface UsageSums {
  turns: number;
  reported: number;
  priced: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Null when no turn of the group carried a price. */
  cost: number | null;
}

export interface UsageSumRow extends UsageSums {
  bucket: number;
  provider_id: string;
  model: string | null;
}

export interface UsageThreadRow extends UsageSums {
  thread_id: string;
  /** The provider the turns of this row ran on; a thread that switched has one row per provider. */
  provider_id: string;
  title: string;
  project_id: string | null;
  thread_provider_id: string;
  archived: number;
}

/** The sums over `x`, a set of turns with their `usage` JSON. */
const USAGE_SUMS = `COUNT(*) AS turns, COUNT(x.usage) AS reported,
  COUNT(json_extract(x.usage, '$.costUsdEquivalent')) AS priced,
  COALESCE(SUM(json_extract(x.usage, '$.inputTokens')), 0) AS input_tokens,
  COALESCE(SUM(json_extract(x.usage, '$.outputTokens')), 0) AS output_tokens,
  COALESCE(SUM(json_extract(x.usage, '$.cacheReadTokens')), 0) AS cache_read_tokens,
  COALESCE(SUM(json_extract(x.usage, '$.cacheWriteTokens')), 0) AS cache_write_tokens,
  SUM(json_extract(x.usage, '$.costUsdEquivalent')) AS cost`;

/**
 * Finished turns summed per bucket, provider and model: bucket `i` holds the
 * turns with `edges[i] <= finished_at < edges[i + 1]`. A turn saved before
 * execution snapshots counts under its thread's provider and model. Token
 * counts are summed as each provider reported them.
 */
export function usageByBucket(db: Database, edges: readonly number[]): UsageSumRow[] {
  return db
    .query(
      `WITH e AS (SELECT CAST(key AS INTEGER) AS i, value AS lo, LEAD(value) OVER (ORDER BY CAST(key AS INTEGER)) AS hi FROM json_each(?)),
       x AS (
         SELECT e.i AS bucket, t.thread_id, t.usage,
           COALESCE(json_extract(t.execution, '$.providerId'), th.provider_id, '') AS provider_id,
           CASE WHEN t.execution IS NULL THEN th.model ELSE json_extract(t.execution, '$.model') END AS model
         FROM e JOIN turns t ON t.finished_at >= e.lo AND t.finished_at < e.hi
         LEFT JOIN threads th ON th.id = t.thread_id
         WHERE e.hi IS NOT NULL
       )
       SELECT bucket, provider_id, model, ${USAGE_SUMS}
       FROM x GROUP BY bucket, provider_id, model ORDER BY bucket, provider_id, model`,
    )
    .all(JSON.stringify(edges)) as UsageSumRow[];
}

/**
 * The same sums per thread and provider over `[from, to)`, with what a list
 * needs to name each thread.
 */
export function usageByThread(db: Database, from: number, to: number): UsageThreadRow[] {
  return db
    .query(
      `WITH x AS (
         SELECT t.thread_id, t.usage,
           COALESCE(json_extract(t.execution, '$.providerId'), th.provider_id, '') AS provider_id
         FROM turns t LEFT JOIN threads th ON th.id = t.thread_id
         WHERE t.finished_at >= ? AND t.finished_at < ?
       )
       SELECT x.thread_id, x.provider_id, COALESCE(th.title, '') AS title, th.project_id,
         COALESCE(th.provider_id, '') AS thread_provider_id, COALESCE(th.archived, 0) AS archived, ${USAGE_SUMS}
       FROM x LEFT JOIN threads th ON th.id = x.thread_id
       GROUP BY x.thread_id, x.provider_id`,
    )
    .all(from, to) as UsageThreadRow[];
}
