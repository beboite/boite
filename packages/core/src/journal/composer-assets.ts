import type { Database } from 'bun:sqlite';

/** Read attachment IDs from one indexed record, without decoding uploaded bytes. */
export function storedComposerAssets(db: Database, section: string, id: string): string[] {
  return (db.query(`SELECT json_extract(a.value, '$.assetId') AS id FROM composer_records r, json_each(r.value, '$.input.attachments') a WHERE r.section = ?1 AND r.id = ?2
    UNION SELECT json_extract(a.value, '$.assetId') AS id FROM composer_records r, json_each(r.value, '$.input.queued') q, json_each(q.value, '$.attachments') a WHERE r.section = ?1 AND r.id = ?2`).all(section, id) as { id: string }[]).map(row => row.id);
}

/** Only removed references are candidates; other composers still own their bytes. */
export function collectStoredComposerAssets(db: Database, assetIds: Iterable<string>): void {
  const remove = db.query(`DELETE FROM composer_assets WHERE id = ?1 AND NOT EXISTS (
    SELECT 1 FROM composer_records r, json_each(r.value, '$.input.attachments') a WHERE json_extract(a.value, '$.assetId') = ?1
    UNION ALL SELECT 1 FROM composer_records r, json_each(r.value, '$.input.queued') q, json_each(q.value, '$.attachments') a WHERE json_extract(a.value, '$.assetId') = ?1)`);
  for (const id of assetIds) remove.run(id);
}

/** Runs inside the history deletion transaction, including asset collection. */
export function deleteComposerInput(db: Database, id: string, collect?: (assetIds: string[]) => void): void {
  const assets = storedComposerAssets(db, 'inputs', id);
  db.query("DELETE FROM composer_records WHERE section = 'inputs' AND id = ?").run(id);
  db.query("UPDATE composer_deliveries SET thread_id = NULL, fingerprint = '' WHERE thread_id = ? AND section = 'drafts' AND status = 'delivered'").run(id);
  db.query("DELETE FROM composer_deliveries WHERE thread_id = ?1 OR (section = 'inputs' AND record_id = ?1)").run(id);
  if (collect) collect(assets);
  else collectStoredComposerAssets(db, assets);
}
