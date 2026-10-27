import type { Database } from 'bun:sqlite';
import type { SharedComputeJob, SharedComputeStart } from '@boite/contracts';

export interface ComputeRecord {
  role: 'host' | 'source';
  job: SharedComputeJob;
  input: SharedComputeStart;
  repository: string;
  fingerprint: string;
  /** Host-only identity. Never included in a peer result or a client projection. */
  accountId?: string;
  rootId?: string;
  cancelRequest?: string;
  notified?: string;
  stopping?: 'cancelled' | 'revoked';
  /** A released board claim keeps its history but can never accept another turn. */
  claimClosed?: true;
  checkoutPath?: string;
  repositoryPath?: string;
  commonDirectory?: string;
}
export const terminalCompute = (job: SharedComputeJob): boolean => ['done', 'failed', 'cancelled', 'revoked'].includes(job.status);

export function createSharedCompute(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS shared_compute_jobs (
    id TEXT NOT NULL, role TEXT NOT NULL, association_id TEXT NOT NULL, worker_id TEXT,
    data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(id,role)
  );
  CREATE INDEX IF NOT EXISTS shared_compute_scope ON shared_compute_jobs(association_id,role);
  CREATE INDEX IF NOT EXISTS shared_compute_worker ON shared_compute_jobs(worker_id) WHERE worker_id IS NOT NULL;`);
  db.exec(`CREATE INDEX IF NOT EXISTS shared_compute_host_peer ON shared_compute_jobs(json_extract(data,'$.job.source.project.ownerCoreId')) WHERE role='host';
    CREATE INDEX IF NOT EXISTS shared_compute_source_peer ON shared_compute_jobs(json_extract(data,'$.job.host.ownerCoreId')) WHERE role='source';`);
}
export class SharedComputeJournal {
  constructor(private readonly db: Database) {}
  get(id: string, role: ComputeRecord['role']): ComputeRecord | null {
    const row = this.db.query('SELECT data FROM shared_compute_jobs WHERE id=? AND role=?').get(id, role) as { data: string } | null;
    return row ? JSON.parse(row.data) : null;
  }
  worker(id: string): ComputeRecord | null {
    const row = this.db.query("SELECT data FROM shared_compute_jobs WHERE worker_id=? AND role='host'").get(id) as { data: string } | null;
    return row ? JSON.parse(row.data) : null;
  }
  all(associationId?: string): ComputeRecord[] {
    return (this.db.query('SELECT data FROM shared_compute_jobs WHERE (? IS NULL OR association_id=?) ORDER BY rowid').all(associationId ?? null, associationId ?? null) as { data: string }[]).map(r => JSON.parse(r.data));
  }
  /** Keep durable replay fences, but materialize only this peer's notification/retry work. */
  forPeer(peerId: string, role: ComputeRecord['role']): ComputeRecord[] {
    const query = role === 'host'
      ? "SELECT data FROM shared_compute_jobs WHERE role='host' AND json_extract(data,'$.job.source.project.ownerCoreId')=? ORDER BY rowid"
      : "SELECT data FROM shared_compute_jobs WHERE role='source' AND json_extract(data,'$.job.host.ownerCoreId')=? AND (json_extract(data,'$.job.status') NOT IN ('done','failed','cancelled','revoked') OR coalesce(json_extract(data,'$.cancelRequest'),'') <> '') ORDER BY rowid";
    return (this.db.query(query).all(peerId) as {data: string}[]).map(row => JSON.parse(row.data));
  }
  put(record: ComputeRecord): void {
    this.db.query('INSERT INTO shared_compute_jobs VALUES(?,?,?,?,?) ON CONFLICT(id,role) DO UPDATE SET worker_id=excluded.worker_id,data=excluded.data')
      .run(record.job.id, record.role, record.job.sharedProjectId, record.job.worker?.threadId ?? null, JSON.stringify(record));
  }
}
