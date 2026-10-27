import { createHash } from 'node:crypto';
import type { Attachment, ComposerAttachment, ComposerRecord, ComposerValue } from '@boite/contracts';
import { answerAttachmentError, decodedBytes, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, notFound, refused } from './errors.ts';
import type { Connection } from './router.ts';
import { collectStoredComposerAssets } from './journal/composer-assets.ts';

type Row = { section: ComposerRecord['section']; id: string; revision: number; updated_at: number; value: string | null };
export interface Delivery {
  id: string; section: ComposerRecord['section']; record_id: string;
  status: 'creating' | 'submitting' | 'delivered' | 'uncertain'; thread_id: string | null; request_id: string; fingerprint: string;
}

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  return item;
})).digest('hex');
export const recordKey = (section: string, id: string): string => JSON.stringify([section, id]);

/** Composer data has its own rows: typing never rewrites a message or an attachment. */
export class ComposerStorage {
  private readonly privateRecords = new Map<string, ComposerRecord>();
  private readonly privateAssets = new Map<string, Attachment>();
  private readonly privateDeliveries = new Map<string, Delivery>();
  private readonly privateOwners = new Map<string, Connection>();
  private readonly privateAssetOwners = new Map<string, string>();
  private readonly pendingAssets = new Map<string, Set<string>>();
  private readonly connections = new Set<string>();
  readonly queued = new Map<string, Pick<ComposerRecord, 'section' | 'id'>>();
  constructor(private readonly core: Core) {
    core.journal.collectComposerAssets = assets => this.collectAssets(assets);
    // No client can still be uploading here. Messages already own their bytes;
    // only live composer references retain an uploaded composer asset.
    core.journal.db.run(`DELETE FROM composer_assets WHERE id NOT IN (
      SELECT json_extract(a.value, '$.assetId') FROM composer_records r, json_each(r.value, '$.input.attachments') a
      UNION SELECT json_extract(a.value, '$.assetId') FROM composer_records r, json_each(r.value, '$.input.queued') q, json_each(q.value, '$.attachments') a
    )`);
    const queued = core.journal.db.query("SELECT section, id FROM composer_records WHERE value IS NOT NULL AND json_array_length(value, '$.input.queued') > 0").all() as Pick<ComposerRecord, 'section' | 'id'>[];
    for (const record of queued) this.queued.set(recordKey(record.section, record.id), record);
  }

  list(ownerId?: string): ComposerRecord[] {
    const memory = [...this.privateRecords.values()].filter(record => ownerId === undefined || this.owner(record)?.id === ownerId);
    return [...(this.core.journal.db.query('SELECT * FROM composer_records ORDER BY section, id').all() as Row[]).map(row => this.decode(row)), ...memory].map(record => structuredClone(record));
  }

  owner(record: Pick<ComposerRecord, 'section' | 'id'>): Connection | undefined { return this.privateOwners.get(recordKey(record.section, record.id)); }
  forgetThread(threadId: string): void {
    const key = recordKey('inputs', threadId);
    const assets = this.privateRecords.get(key)?.value;
    this.queued.delete(key); this.privateRecords.delete(key); this.privateOwners.delete(key);
    for (const [id, delivery] of this.privateDeliveries) {
      if (delivery.thread_id !== threadId && !(delivery.section === 'inputs' && delivery.record_id === threadId)) continue;
      if (delivery.section === 'drafts' && delivery.status === 'delivered') { delivery.thread_id = null; delivery.fingerprint = ''; }
      else this.privateDeliveries.delete(id);
    }
    if (assets) this.collectAssets(this.references(assets).map(reference => reference.assetId));
  }
  requireOwner(record: Pick<ComposerRecord, 'section' | 'id'>, connectionId: string): void {
    const owner = this.owner(record);
    if (owner && owner.id !== connectionId) throw notFound('composer.id: this private composer belongs to another connection');
  }

  get(section: ComposerRecord['section'], id: string): ComposerRecord {
    const memory = this.privateRecords.get(recordKey(section, id));
    if (memory) return structuredClone(memory);
    const row = this.core.journal.db.query('SELECT * FROM composer_records WHERE section = ? AND id = ?').get(section, id) as Row | null;
    return row ? this.decode(row) : { section, id, revision: 0, updatedAt: 0, value: null };
  }

  private decode(row: Row): ComposerRecord {
    return { section: row.section, id: row.id, revision: row.revision, updatedAt: row.updated_at, value: row.value === null ? null : JSON.parse(row.value) };
  }

  privateMode(section: ComposerRecord['section'], id: string, value: ComposerValue | null): boolean {
    return this.privateRecords.has(recordKey(section, id)) || value?.draft?.incognito === true ||
      value?.input.queued.some(item => item.request?.start?.incognito) === true ||
      (section === 'inputs' && this.core.journal.getThread(id)?.incognito === true);
  }

  save(section: ComposerRecord['section'], id: string, value: ComposerValue | null, owner?: Connection): ComposerRecord {
    const previous = this.get(section, id);
    const references = value ? this.references(value).map(reference => reference.assetId) : [];
    const record = { section, id, value, revision: previous.revision + 1, updatedAt: Date.now() };
    if (this.privateMode(section, id, value)) {
      if (previous.revision && !this.privateRecords.has(recordKey(section, id))) throw refused('composer: a persisted composer cannot become incognito; use a new draft');
      const connection = this.privateOwners.get(recordKey(section, id)) ?? owner;
      if (!connection) throw refused('composer: an incognito record requires its originating connection');
      this.track(connection);
      this.privateOwners.set(recordKey(section, id), connection);
      this.privateRecords.set(recordKey(section, id), record);
    } else this.core.journal.db.query(`INSERT INTO composer_records VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(section,id) DO UPDATE SET revision=excluded.revision, updated_at=excluded.updated_at, value=excluded.value`)
      .run(section, id, record.revision, record.updatedAt, value === null ? null : JSON.stringify(value));
    if (value?.input.queued.length) this.queued.set(recordKey(section, id), { section, id });
    else this.queued.delete(recordKey(section, id));
    for (const assetId of references) {
      const pending = this.pendingAssets.get(assetId);
      if (owner) pending?.delete(owner.id);
      if (pending?.size === 0) this.pendingAssets.delete(assetId);
    }
    if (previous.value) this.collectAssets(this.references(previous.value).map(reference => reference.assetId).filter(assetId => !references.includes(assetId)));
    const privateOwner = this.privateOwners.get(recordKey(section, id));
    if (privateOwner) privateOwner.sendEvent('composer.updated', structuredClone(record));
    else this.core.bus.emit('composer.updated', structuredClone(record));
    return record;
  }

  putAsset(attachment: Attachment, incognito: boolean, owner: Connection): { assetId: string } {
    const error = answerAttachmentError([attachment]);
    if (error) throw invalidParams(`composer.asset.put: ${error.message}`);
    this.track(owner);
    const assetId = `${incognito ? 'private-' : ''}${digest(incognito ? [owner.id, attachment] : attachment)}`;
    if (incognito) { this.privateAssets.set(assetId, structuredClone(attachment)); this.privateAssetOwners.set(assetId, owner.id); }
    else this.core.journal.db.query('INSERT OR IGNORE INTO composer_assets VALUES (?, ?, ?, ?, ?, ?)').run(assetId, JSON.stringify(attachment), attachment.kind, attachment.mimeType, attachment.name, decodedBytes(attachment.data));
    const pending = this.pendingAssets.get(assetId) ?? new Set<string>();
    pending.add(owner.id); this.pendingAssets.set(assetId, pending);
    return { assetId };
  }

  private track(connection: Connection): void {
    if (this.connections.has(connection.id)) return;
    this.connections.add(connection.id);
    connection.onClose?.(() => {
      this.connections.delete(connection.id);
      const assets = new Set<string>(), records = new Set<string>();
      for (const [key, owner] of this.privateOwners) if (owner.id === connection.id) {
        const value = this.privateRecords.get(key)?.value;
        if (value) for (const reference of this.references(value)) assets.add(reference.assetId);
        this.privateRecords.delete(key); this.privateOwners.delete(key); this.queued.delete(key); records.add(key);
      }
      for (const [id, delivery] of this.privateDeliveries) if (records.has(recordKey(delivery.section, delivery.record_id))) this.privateDeliveries.delete(id);
      for (const [id, ownerId] of this.privateAssetOwners) if (ownerId === connection.id) assets.add(id);
      for (const [id, pending] of this.pendingAssets) if (pending.delete(connection.id)) {
        if (!pending.size) this.pendingAssets.delete(id);
        assets.add(id);
      }
      this.collectAssets(assets);
    });
  }

  private collectAssets(assetIds: Iterable<string>): void {
    const stored: string[] = [];
    for (const id of new Set(assetIds)) {
      if (this.pendingAssets.has(id)) continue;
      if ([...this.privateRecords.values()].some(record => record.value && this.references(record.value).some(reference => reference.assetId === id))) continue;
      if (!id.startsWith('private-')) { stored.push(id); continue; }
      this.privateAssets.delete(id); this.privateAssetOwners.delete(id);
    }
    collectStoredComposerAssets(this.core.journal.db, stored);
  }

  readAsset(assetId: string): Attachment {
    const memory = this.privateAssets.get(assetId);
    if (memory) return structuredClone(memory);
    const row = this.core.journal.db.query('SELECT attachment FROM composer_assets WHERE id = ?').get(assetId) as { attachment: string } | null;
    if (!row) throw notFound('composer.assetId: expected an uploaded attachment');
    return JSON.parse(row.attachment);
  }

  getAsset(assetId: string, ownerId?: string): Attachment {
    const memory = [...this.privateRecords.values()].some(record => (ownerId === undefined || this.owner(record)?.id === ownerId) && record.value && this.references(record.value).some(attachment => attachment.assetId === assetId));
    const stored = typeof assetId === 'string' && this.core.journal.db.query(`SELECT 1 FROM composer_records r
      WHERE EXISTS (SELECT 1 FROM json_each(r.value, '$.input.attachments') a WHERE json_extract(a.value, '$.assetId') = ?1)
      OR EXISTS (SELECT 1 FROM json_each(r.value, '$.input.queued') q, json_each(q.value, '$.attachments') a WHERE json_extract(a.value, '$.assetId') = ?1) LIMIT 1`).get(assetId);
    if (typeof assetId !== 'string' || (!memory && !stored)) {
      throw notFound('composer.assetId: expected an attachment referenced by a composer record');
    }
    return this.readAsset(assetId);
  }

  references(value: ComposerValue): ComposerAttachment[] { return [...value.input.attachments, ...value.input.queued.flatMap(item => item.attachments)]; }

  validateAssets(value: ComposerValue, privateMode: boolean, ownerId?: string): void {
    for (const input of [value.input, ...value.input.queued]) {
      if (input.attachments.length > ATTACHMENTS_PER_TURN) throw invalidParams(`composer.attachments: expected at most ${ATTACHMENTS_PER_TURN} attachments per input`);
      let bytes = 0;
      for (const reference of input.attachments) {
        if (!privateMode && reference.assetId.startsWith('private-')) throw refused('composer.assetId: a memory-only attachment requires an incognito record');
        if (reference.assetId.startsWith('private-') && this.privateAssetOwners.get(reference.assetId) !== ownerId) throw notFound('composer.assetId: expected a private attachment uploaded by this connection');
        const privateAsset = this.privateAssets.get(reference.assetId);
        const metadata = privateAsset ? { kind: privateAsset.kind, mime_type: privateAsset.mimeType, name: privateAsset.name, bytes: decodedBytes(privateAsset.data) }
          : this.core.journal.db.query('SELECT kind, mime_type, name, bytes FROM composer_assets WHERE id = ?').get(reference.assetId) as { kind: string; mime_type: string; name: string | null; bytes: number } | null;
        if (!metadata) throw notFound('composer.assetId: expected an uploaded attachment');
        if (metadata.kind !== reference.kind || metadata.name !== reference.name || metadata.mime_type !== reference.mimeType) throw invalidParams('composer.attachment: metadata must match the uploaded attachment');
        bytes += metadata.bytes;
      }
      if (bytes > ATTACHMENTS_TOTAL_MAX_BYTES) throw invalidParams(`composer.attachments: expected at most ${ATTACHMENTS_TOTAL_MAX_BYTES} bytes per input`);
    }
  }

  delivery(id: string): Delivery | null {
    return this.privateDeliveries.get(id) ?? this.core.journal.db.query('SELECT * FROM composer_deliveries WHERE id = ?').get(id) as Delivery | null;
  }

  reserve(delivery: Delivery, privateMode: boolean): void {
    if (privateMode) this.privateDeliveries.set(delivery.id, delivery);
    else this.core.journal.db.query(`INSERT INTO composer_deliveries VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, thread_id=excluded.thread_id`)
      .run(delivery.id, delivery.section, delivery.record_id, delivery.status, delivery.thread_id, delivery.request_id, delivery.fingerprint);
  }

  status(id: string, status: Delivery['status'], threadId?: string): void {
    const memory = this.privateDeliveries.get(id);
    if (memory) { memory.status = status; if (threadId !== undefined) memory.thread_id = threadId; }
    else this.core.journal.db.query('UPDATE composer_deliveries SET status = ?, thread_id = COALESCE(?, thread_id) WHERE id = ?').run(status, threadId ?? null, id);
  }

  release(id: string): void {
    this.privateDeliveries.delete(id);
    this.core.journal.db.query('DELETE FROM composer_deliveries WHERE id = ?').run(id);
  }
}
