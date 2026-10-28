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

/** Sums of the turns of one provider and model. */
export interface UsageGroupRow extends UsageSums {
  provider_id: string;
  model: string | null;
}

export interface UsageSumRow extends UsageGroupRow {
  bucket: number;
}

export interface UsageThreadRow extends UsageSums {
  thread_id: string;
  /** The provider and model the turns of this row ran on; a thread that switched has one row per pair. */
  provider_id: string;
  model: string | null;
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
 * The provider and model a turn `t` of thread `th` ran on: its execution
 * snapshot, else its thread's, for a turn saved before snapshots.
 */
const TURN_ROUTE = `COALESCE(json_extract(t.execution, '$.providerId'), th.provider_id, '') AS provider_id,
  CASE WHEN t.execution IS NULL THEN th.model ELSE json_extract(t.execution, '$.model') END AS model`;

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
           ${TURN_ROUTE}
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
 * The same sums per thread, provider and model over `[from, to)`, with what a
 * list needs to name each thread.
 */
export function usageByThread(db: Database, from: number, to: number): UsageThreadRow[] {
  return db
    .query(
      `WITH x AS (
         SELECT t.thread_id, t.usage,
           ${TURN_ROUTE}
         FROM turns t LEFT JOIN threads th ON th.id = t.thread_id
         WHERE t.finished_at >= ? AND t.finished_at < ?
       )
       SELECT x.thread_id, x.provider_id, x.model, COALESCE(th.title, '') AS title, th.project_id,
         COALESCE(th.provider_id, '') AS thread_provider_id, COALESCE(th.archived, 0) AS archived, ${USAGE_SUMS}
       FROM x LEFT JOIN threads th ON th.id = x.thread_id
       GROUP BY x.thread_id, x.provider_id, x.model`,
    )
    .all(from, to) as UsageThreadRow[];
}

/**
 * The same sums per provider and model over the turns started since `since`
 * on `rootId` and every thread below it: its subagents at any depth
 * (`parent_thread_id`) and the steps of workflow runs rooted in that set.
 * Each thread's turns are read through the partial index
 * `turns_by_thread_queue`, whose `started_at IS NOT NULL` the query repeats;
 * the CROSS JOIN keeps the tree outside, else SQLite may walk the whole index.
 */
export function usageOfTree(db: Database, rootId: string, since: number): UsageGroupRow[] {
  return db
    .query(
      `WITH RECURSIVE tree(id) AS (
         SELECT ?
         UNION SELECT c.id FROM threads c JOIN tree ON c.parent_thread_id = tree.id
         UNION SELECT s.thread_id FROM workflow_runs r JOIN tree ON r.root_id = tree.id JOIN workflow_steps s ON s.run_id = r.id
       ),
       x AS (
         SELECT t.usage, ${TURN_ROUTE}
         FROM tree CROSS JOIN turns AS t INDEXED BY turns_by_thread_queue ON t.thread_id = tree.id
         LEFT JOIN threads th ON th.id = t.thread_id
         WHERE t.queued_at >= ? AND t.started_at IS NOT NULL AND t.usage IS NOT NULL
       )
       SELECT provider_id, model, ${USAGE_SUMS}
       FROM x GROUP BY provider_id, model ORDER BY provider_id, model`,
    )
    .all(rootId, since) as UsageGroupRow[];
}
