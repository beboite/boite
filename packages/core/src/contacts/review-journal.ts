import type { Database } from 'bun:sqlite';
import type { SharedReviewConfig, SharedReviewVerdict } from '@boite/contracts';

export function createSharedReview(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS shared_review_config (
    association_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
  );
  CREATE TABLE IF NOT EXISTS shared_review_work (
    event_id TEXT PRIMARY KEY, association_id TEXT NOT NULL, revision INTEGER NOT NULL,
    authority TEXT NOT NULL, state TEXT NOT NULL, verdict_id TEXT
  );
  CREATE INDEX IF NOT EXISTS shared_review_pending ON shared_review_work(state, association_id);
  CREATE TABLE IF NOT EXISTS shared_review_verdicts (
    id TEXT PRIMARY KEY, association_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
  );`);
}
export interface ReviewWork { event_id: string; association_id: string; revision: number; authority: string; state: string; verdict_id: string | null }
export class SharedReviewJournal {
  constructor(private readonly db: Database) {}
  config(id: string): {revision: number; value: SharedReviewConfig} {
    const row = this.db.query('SELECT revision,data FROM shared_review_config WHERE association_id=?').get(id) as {revision: number; data: string} | null;
    return row ? {revision: row.revision, value: JSON.parse(row.data)} : {revision: 0, value: {enabled: false}};
  }
  configure(id: string, config: SharedReviewConfig): void {
    this.db.query('INSERT INTO shared_review_config VALUES(?,1,?) ON CONFLICT(association_id) DO UPDATE SET revision=revision+1,data=excluded.data').run(id, JSON.stringify(config));
  }
  enqueue(id: string, event: string, revision: number, authority: string): void {
    this.db.query("INSERT OR IGNORE INTO shared_review_work VALUES(?,?,?,?,'pending',NULL)").run(event, id, revision, authority);
  }
  interrupted(): ReviewWork[] { return this.db.query("SELECT * FROM shared_review_work WHERE state IN ('running','pending')").all() as ReviewWork[]; }
  take(): ReviewWork[] {
    return this.db.transaction(() => {
      const first = this.db.query("SELECT * FROM shared_review_work WHERE state='pending' ORDER BY rowid LIMIT 1").get() as ReviewWork | null;
      if (!first) return [];
      // Bounded inference input; this is a page size, not a limit on contact activity or exchanges.
      const rows = this.db.query("SELECT * FROM shared_review_work WHERE state='pending' AND association_id=? AND revision=? AND authority=? ORDER BY rowid LIMIT 32").all(first.association_id, first.revision, first.authority) as ReviewWork[];
      for (const row of rows) this.db.query("UPDATE shared_review_work SET state='running' WHERE event_id=?").run(row.event_id);
      return rows;
    })();
  }
  finish(rows: ReviewWork[], verdict: SharedReviewVerdict): void {
    this.db.query('INSERT INTO shared_review_verdicts VALUES(?,?,?)').run(verdict.id, verdict.sharedProjectId, JSON.stringify(verdict));
    for (const row of rows) this.db.query("UPDATE shared_review_work SET state='done',verdict_id=? WHERE event_id=? AND state!='done'").run(verdict.id, row.event_id);
  }
  verdicts(id: string, eventIds: string[]): SharedReviewVerdict[] {
    if (!eventIds.length) return [];
    const slots = eventIds.map(() => '?').join(',');
    return (this.db.query(`SELECT data FROM shared_review_verdicts WHERE association_id=? AND id IN
      (SELECT verdict_id FROM shared_review_work WHERE event_id IN (${slots})) ORDER BY rowid`).all(id, ...eventIds) as {data: string}[]).map(row => JSON.parse(row.data));
  }
  status(id: string): 'idle' | 'reviewing' | 'unavailable' {
    if (this.db.query("SELECT 1 FROM shared_review_work WHERE association_id=? AND state!='done' LIMIT 1").get(id)) return 'reviewing';
    const row = this.db.query('SELECT data FROM shared_review_verdicts WHERE association_id=? ORDER BY rowid DESC LIMIT 1').get(id) as {data: string} | null;
    return row && (JSON.parse(row.data) as SharedReviewVerdict).verdict === 'unavailable' ? 'unavailable' : 'idle';
  }
}
