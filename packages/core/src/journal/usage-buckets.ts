import type { Database } from 'bun:sqlite';

/** The protocol a provider id ran on, or null when nothing knows the id. */
export type UsageProtocolOf = (providerId: string) => string | null;

/** What a core with no provider registry knows: the shipped providers whose counts need fixing. */
export const shippedUsageProtocol: UsageProtocolOf = (id) => (id === 'claude' ? 'claude-sdk' : id === 'codex' ? 'codex-appserver' : null);

/** The provider a turn ran on; a turn saved before execution snapshots ran on its thread's. */
const PROVIDER_OF = `COALESCE(json_extract(turns.execution, '$.providerId'), (SELECT provider_id FROM threads WHERE threads.id = turns.thread_id), '')`;

/**
 * Schema 45: stored usage becomes the disjoint buckets of `Usage`, frozen
 * with each turn, so its history no longer depends on the provider's
 * descriptor. Codex counted both cache counts inside its input; Claude Code
 * wrote its cache for an hour. Each provider id is resolved once, by what the
 * registry holds at the upgrade, with the shipped ids as the fallback.
 */
export function freezeUsageBuckets(db: Database, protocolOf: UsageProtocolOf): void {
  const ids = (db.query(`SELECT DISTINCT ${PROVIDER_OF} AS id FROM turns WHERE usage IS NOT NULL`).all() as { id: string }[]).map((row) => row.id);
  const protocols = new Map(ids.map((id) => [id, protocolOf(id) ?? shippedUsageProtocol(id)]));
  const on = (protocol: string): string => JSON.stringify(ids.filter((id) => protocols.get(id) === protocol));
  const codex = on('codex-appserver');
  const claude = on('claude-sdk');
  db.query(
    `UPDATE turns SET usage = json_set(usage, '$.inputTokens', MAX(0,
       COALESCE(json_extract(usage, '$.inputTokens'), 0) - COALESCE(json_extract(usage, '$.cacheReadTokens'), 0) - COALESCE(json_extract(usage, '$.cacheWriteTokens'), 0)))
     WHERE usage IS NOT NULL AND ${PROVIDER_OF} IN (SELECT value FROM json_each(?))`,
  ).run(codex);
  db.query(
    `UPDATE turns SET usage = json_set(usage, '$.cacheWriteHourTokens', json_extract(usage, '$.cacheWriteTokens'))
     WHERE usage IS NOT NULL AND COALESCE(json_extract(usage, '$.cacheWriteTokens'), 0) > 0 AND ${PROVIDER_OF} IN (SELECT value FROM json_each(?))`,
  ).run(claude);
}
