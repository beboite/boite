/** Authority history and replica/outbox state share the existing journal's SQLite transaction. */
import type { Database } from 'bun:sqlite';
import type { SharedBoardCard, SharedBoardChange, SharedBoardCommand, SharedBoardPage, SharedBoardReceipt, SharedProjectActor, SharedProjectPeerMethods } from '@boite/contracts';
import { invalidParams } from '../errors.ts';
import { fingerprint } from './project-journal.ts';

export function createSharedBoard(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS shared_board_heads (
    association TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS shared_board_entries (
    association TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(association,id)
  );
  CREATE TABLE IF NOT EXISTS shared_board_changes (
    association TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(association,revision)
  );
  CREATE TABLE IF NOT EXISTS shared_board_commands (
    seq INTEGER PRIMARY KEY, association TEXT NOT NULL, actor TEXT NOT NULL, request TEXT NOT NULL,
    fingerprint TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), result TEXT,
    UNIQUE(association,actor,request)
  );
  CREATE TABLE IF NOT EXISTS shared_board_progress (
    association TEXT NOT NULL, card TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(association,card)
  );`);
}
export interface PendingBoardCommand {
  threadId: string;
  source: SharedProjectActor;
  command: SharedBoardCommand;
}
export type BoardProgress = SharedProjectPeerMethods['board.progress']['params'];

export class SharedBoardJournal {
  constructor(readonly db: Database) {}
  revision(id: string): number { return (this.db.query('SELECT revision FROM shared_board_heads WHERE association=?').get(id) as {revision: number} | null)?.revision ?? 0; }
  notified(id: string): number { return (this.db.query('SELECT notified FROM shared_board_heads WHERE association=?').get(id) as {notified: number} | null)?.notified ?? 0; }
  notify(id: string, revision: number): void { this.db.query('UPDATE shared_board_heads SET notified=MAX(notified,?) WHERE association=?').run(revision, id); }
  entries(id: string): SharedBoardChange[] {
    return (this.db.query('SELECT data FROM shared_board_entries WHERE association=? ORDER BY rowid').all(id) as {data: string}[]).map(row => JSON.parse(row.data));
  }
  entry(id: string, card: string): SharedBoardChange | null {
    const row = this.db.query('SELECT data FROM shared_board_entries WHERE association=? AND id=?').get(id, card) as {data: string} | null;
    return row ? JSON.parse(row.data) : null;
  }
  append(id: string, change: SharedBoardChange): void {
    const previous = this.entry(id, change.kind === 'card' ? change.card.id : change.tombstone.id);
    // Deletion is terminal even if a corrupted/malicious authority tries to reuse an ID later.
    if (previous?.kind === 'deleted' && change.kind === 'card') throw invalidParams('board.cardId: a deleted id cannot be reused');
    this.db.query('INSERT INTO shared_board_entries VALUES(?,?,?) ON CONFLICT(association,id) DO UPDATE SET data=excluded.data')
      .run(id, change.kind === 'card' ? change.card.id : change.tombstone.id, JSON.stringify(change));
    this.db.query('INSERT INTO shared_board_changes VALUES(?,?,?)').run(id, change.revision, JSON.stringify(change));
    this.db.query('INSERT INTO shared_board_heads(association,revision) VALUES(?,?) ON CONFLICT(association) DO UPDATE SET revision=excluded.revision').run(id, change.revision);
  }
  /** At most 64 changes and 128 KiB, except one intrinsically larger validated card. */
  delta(id: string, after: number): Extract<SharedBoardPage, {kind: 'delta'}> {
    const rows = this.db.query('SELECT data FROM shared_board_changes WHERE association=? AND revision>? ORDER BY revision LIMIT 64').all(id, after) as {data: string}[];
    let bytes = 0;
    const changes: SharedBoardChange[] = [];
    for (const row of rows) { const size = Buffer.byteLength(row.data); if (changes.length && bytes + size > 128 * 1024) break; bytes += size; changes.push(JSON.parse(row.data)); }
    const to = changes.at(-1)?.revision ?? after;
    return { kind: 'delta', from: after, to, changes, more: to < this.revision(id) };
  }
  actor(source: SharedProjectActor): string { return fingerprint(source.kind === 'human' ? { kind: source.kind, project: source.project } : { kind: source.kind, project: source.project, threadId: source.threadId }); }
  enqueue(id: string, value: PendingBoardCommand): void {
    const actor = this.actor(value.source), request = value.command.requestId, hash = fingerprint(value.command);
    const row = this.db.query('SELECT fingerprint FROM shared_board_commands WHERE association=? AND actor=? AND request=?').get(id, actor, request) as {fingerprint: string} | null;
    if (row) { if (row.fingerprint !== hash) throw invalidParams('requestId: already used with different content'); return; }
    this.db.query('INSERT INTO shared_board_commands(association,actor,request,fingerprint,data) VALUES(?,?,?,?,?)').run(id, actor, request, hash, JSON.stringify(value));
  }
  pending(id: string): PendingBoardCommand[] {
    return (this.db.query('SELECT data FROM shared_board_commands WHERE association=? AND result IS NULL ORDER BY seq').all(id) as {data: string}[]).map(row => JSON.parse(row.data));
  }
  result(id: string, value: PendingBoardCommand): SharedBoardReceipt | null {
    const row = this.db.query('SELECT result FROM shared_board_commands WHERE association=? AND actor=? AND request=?').get(id, this.actor(value.source), value.command.requestId) as {result: string | null} | null;
    return row?.result ? JSON.parse(row.result) : null;
  }
  settle(id: string, value: PendingBoardCommand, receipt: SharedBoardReceipt): void {
    this.db.query('UPDATE shared_board_commands SET result=? WHERE association=? AND actor=? AND request=?').run(JSON.stringify(receipt), id, this.actor(value.source), value.command.requestId);
  }
  progress(id: string, card: string): BoardProgress | null {
    const row = this.db.query('SELECT data FROM shared_board_progress WHERE association=? AND card=?').get(id, card) as {data: string} | null;
    return row ? JSON.parse(row.data) : null;
  }
  putProgress(id: string, p: BoardProgress): void { this.db.query('INSERT INTO shared_board_progress VALUES(?,?,?,0) ON CONFLICT(association,card) DO UPDATE SET data=excluded.data,delivered=0').run(id, p.cardId, JSON.stringify(p)); }
  pendingProgress(id: string): BoardProgress[] { return (this.db.query('SELECT data FROM shared_board_progress WHERE association=? AND delivered=0').all(id) as {data: string}[]).map(row => JSON.parse(row.data)); }
  ackProgress(id: string, p: BoardProgress): void { this.db.query("UPDATE shared_board_progress SET delivered=1 WHERE association=? AND card=? AND json_extract(data,'$.sequence')=? AND json_extract(data,'$.claimId')=?").run(id, p.cardId, p.sequence, p.claimId); }
  snapshot(id: string): Extract<SharedBoardPage, {kind: 'snapshot'}> {
    const entries = this.entries(id);
    return { kind: 'snapshot', revision: this.revision(id), cards: entries.flatMap(e => e.kind === 'card' ? [e.card] : []), tombstones: entries.flatMap(e => e.kind === 'deleted' ? [e.tombstone] : []) };
  }
}
