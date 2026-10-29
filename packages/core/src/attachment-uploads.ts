import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { answerAttachmentError, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, type Attachment } from '@boite/contracts';
import { refused } from './errors.ts';
import { AttachmentUploadInstances, type UploadRecovery } from './attachment-upload-instances.ts';

const TTL_MS = 10 * 60_000;
const GLOBAL_MAX_BYTES = 4 * ATTACHMENTS_TOTAL_MAX_BYTES;
// Empty files consume leases too, so a byte budget alone cannot bound the store.
const GLOBAL_MAX_COUNT = 4 * ATTACHMENTS_PER_TURN;

type Lease = {
  id: string;
  connectionId: string;
  attachment: Omit<Attachment, 'data'>;
  bytes: number;
  digest: string;
  directory: string;
  expiresAt: number;
  cancelled: boolean;
  writing: Promise<void>;
  cleaning?: Promise<void>;
};

type Upload = { connectionId: string; cancelled: boolean };

type Options = {
  ttlMs?: number;
  cleanupIntervalMs?: number;
  globalMaxBytes?: number;
  globalMaxCount?: number;
};

function expired(id?: string) {
  return refused('the attachment upload expired: send its bytes again', { reason: 'attachment-upload-expired', ...(id ? { id } : {}) });
}

/** Pre-send bytes belong to a connection, never to the journal or permanent attachment store. */
export class AttachmentUploads {
  private readonly directory: string;
  readonly #instances: AttachmentUploadInstances;
  readonly #leases = new Map<string, Lease>();
  readonly #uploads = new Set<Upload>();
  private readonly ttlMs: number;
  private readonly globalMaxBytes: number;
  private readonly globalMaxCount: number;
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;
  #closing?: Promise<void>;

  constructor(dataDir: string, options: Options = {}) {
    this.ttlMs = options.ttlMs ?? TTL_MS;
    this.globalMaxBytes = options.globalMaxBytes ?? GLOBAL_MAX_BYTES;
    this.globalMaxCount = options.globalMaxCount ?? GLOBAL_MAX_COUNT;
    const interval = options.cleanupIntervalMs ?? Math.min(this.ttlMs, 60_000);
    for (const [field, value] of Object.entries({ ttlMs: this.ttlMs, globalMaxBytes: this.globalMaxBytes, globalMaxCount: this.globalMaxCount, cleanupIntervalMs: interval })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field}: expected a positive safe integer`);
    }
    // A manager only removes its own instance, including when two cores share a parent directory.
    this.#instances = new AttachmentUploadInstances(dataDir);
    this.directory = this.#instances.directory;
    this.#timer = setInterval(() => {
      void this.#expire().catch(error => { console.error('attachment upload cleanup failed', error); });
    }, interval);
    this.#timer.unref();
  }

  /** Startup recovery is shared with first upload and shutdown; it creates no new scratch data. */
  recover(): Promise<UploadRecovery> { return this.#instances.recover(); }

  async upload(connectionId: string, attachment: Attachment): Promise<{ id: string }> {
    if (this.#closed) throw expired();
    const error = answerAttachmentError([attachment]);
    if (error) throw refused(error.message, error.data);
    const snapshot = { ...attachment };
    const pending: Upload = { connectionId, cancelled: false };
    this.#uploads.add(pending);
    try {
      await this.recover();
      await this.#expire();
      if (this.#closed || pending.cancelled) throw expired();
      const bytes = Buffer.byteLength(snapshot.data, 'base64');
      let connectionBytes = 0;
      let connectionCount = 0;
      let totalBytes = 0;
      for (const lease of this.#leases.values()) {
        totalBytes += lease.bytes;
        if (lease.connectionId === connectionId) {
          connectionBytes += lease.bytes;
          connectionCount += 1;
        }
      }
      if (connectionCount >= ATTACHMENTS_PER_TURN) throw refused(`a connection holds at most ${ATTACHMENTS_PER_TURN} attachment uploads`, { count: connectionCount + 1, max: ATTACHMENTS_PER_TURN });
      if (connectionBytes + bytes > ATTACHMENTS_TOTAL_MAX_BYTES) throw refused('the connection attachment uploads exceed the byte budget', { bytes: connectionBytes + bytes, max: ATTACHMENTS_TOTAL_MAX_BYTES });
      if (this.#leases.size >= this.globalMaxCount) throw refused('the attachment upload store is full', { count: this.#leases.size + 1, max: this.globalMaxCount });
      if (totalBytes + bytes > this.globalMaxBytes) throw refused('the attachment upload store exceeds the byte budget', { bytes: totalBytes + bytes, max: this.globalMaxBytes });

      const id = randomUUID();
      const body = Buffer.from(snapshot.data, 'base64');
      const lease: Lease = {
        id, connectionId, attachment: { kind: snapshot.kind, name: snapshot.name, mimeType: snapshot.mimeType },
        bytes, digest: createHash('sha256').update(body).digest('hex'), directory: join(this.directory, id), expiresAt: Date.now() + this.ttlMs,
        cancelled: false, writing: Promise.resolve(),
      };
      // Reserve before the first filesystem operation: concurrent requests cannot oversubscribe.
      this.#leases.set(id, lease);
      lease.writing = this.#write(lease, body);
      try {
        await lease.writing;
        this.require(connectionId, id);
        return { id };
      } catch (error) {
        try { await this.remove(lease); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'attachment upload and cleanup failed'); }
        throw error;
      }
    } finally {
      this.#uploads.delete(pending);
    }
  }

  async resolve(connectionId: string, attachments: Attachment[], ids?: (string | null)[]): Promise<Attachment[]> {
    if (!Array.isArray(attachments)) throw refused('attachments must be an array');
    if (ids === undefined) return attachments;
    if (attachments.length > ATTACHMENTS_PER_TURN) throw refused(`a turn carries at most ${ATTACHMENTS_PER_TURN} attachments`, { count: attachments.length, max: ATTACHMENTS_PER_TURN });
    if (!Array.isArray(ids) || ids.length !== attachments.length || ids.some(id => id !== null && (typeof id !== 'string' || id.length === 0))) {
      throw refused('attachment upload IDs must align with attachments: expected a string or null for every attachment');
    }
    const snapshot = attachments.map(attachment => attachment && { ...attachment });
    const references = [...ids];
    await this.#expire();
    let totalBytes = 0;
    const selected = snapshot.map((attachment, index) => {
      const id = references[index]!;
      if (id === null) {
        const error = answerAttachmentError([attachment]);
        if (error) throw refused(error.message, error.data);
        totalBytes += Buffer.byteLength(attachment.data, 'base64');
        return null;
      }
      const lease = this.require(connectionId, id);
      if (!attachment || attachment.kind !== lease.attachment.kind || attachment.name !== lease.attachment.name || attachment.mimeType !== lease.attachment.mimeType || attachment.data !== '') {
        throw refused(`attachment ${index + 1}: upload metadata must match the original kind, name and mimeType, with empty data`, { index });
      }
      totalBytes += lease.bytes;
      return lease;
    });
    if (totalBytes > ATTACHMENTS_TOTAL_MAX_BYTES) throw refused('the attachments exceed the byte budget', { bytes: totalBytes, max: ATTACHMENTS_TOTAL_MAX_BYTES });

    // Read sequentially to bound simultaneous decoded buffers. Leases survive successful reads for retries.
    const resolved: Attachment[] = [];
    for (const [index, lease] of selected.entries()) {
      if (lease === null) { resolved.push(snapshot[index]!); continue; }
      await lease.writing;
      this.require(connectionId, lease.id);
      let body: Buffer;
      try { body = await readFile(join(lease.directory, 'body')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await this.remove(lease);
        throw expired(lease.id);
      }
      this.require(connectionId, lease.id);
      if (body.length !== lease.bytes || createHash('sha256').update(body).digest('hex') !== lease.digest) {
        await this.remove(lease);
        throw refused('the attachment upload bytes changed: send its bytes again', { id: lease.id, reason: 'attachment-upload-expired' });
      }
      resolved.push({ ...snapshot[index]!, data: body.toString('base64') });
    }
    // A release/disconnect during any read invalidates the whole request, including earlier reads.
    for (const lease of selected) if (lease) this.require(connectionId, lease.id);
    return resolved;
  }

  async release(connectionId: string, ids: string[]): Promise<void> {
    if (!Array.isArray(ids)) throw refused('attachment upload IDs must be an array of nonempty strings');
    if (ids.length > ATTACHMENTS_PER_TURN) throw refused(`release at most ${ATTACHMENTS_PER_TURN} attachment uploads at once`, { count: ids.length, max: ATTACHMENTS_PER_TURN });
    if (ids.some(id => typeof id !== 'string' || id.length === 0)) throw refused('attachment upload IDs must be an array of nonempty strings');
    await this.#expire();
    const leases = [...new Set(ids)].map(id => this.require(connectionId, id));
    await this.#removeAll(leases);
  }

  async disconnect(connectionId: string): Promise<void> {
    for (const upload of this.#uploads) if (upload.connectionId === connectionId) upload.cancelled = true;
    await this.#removeAll([...this.#leases.values()].filter(lease => lease.connectionId === connectionId));
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    clearInterval(this.#timer);
    for (const upload of this.#uploads) upload.cancelled = true;
    this.#closing = (async () => {
      const errors: unknown[] = [];
      try { await this.recover(); } catch (error) { errors.push(error); }
      try { await this.#removeAll([...this.#leases.values()]); } catch (error) { errors.push(error); }
      try { await rm(this.directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'attachment upload shutdown failed');
    })().catch(error => { this.#closing = undefined; throw error; });
    return this.#closing;
  }

  private require(connectionId: string, id: string): Lease {
    const lease = this.#leases.get(id);
    if (this.#closed || !lease || lease.cancelled || lease.connectionId !== connectionId || lease.expiresAt <= Date.now()) throw expired(id);
    return lease;
  }

  async #write(lease: Lease, body: Buffer): Promise<void> {
    await this.#instances.own();
    await mkdir(lease.directory, { recursive: true, mode: 0o700 });
    if (this.#closed || lease.cancelled) throw expired(lease.id);
    await writeFile(join(lease.directory, 'body'), body, { flag: 'wx', mode: 0o600 });
  }

  #expire(): Promise<void> {
    const now = Date.now();
    return this.#removeAll([...this.#leases.values()].filter(lease => lease.cancelled || lease.expiresAt <= now));
  }

  private remove(lease: Lease): Promise<void> {
    lease.cancelled = true;
    if (lease.cleaning) return lease.cleaning;
    lease.cleaning = (async () => {
      // A write that was already submitted must settle before its directory can be removed.
      await lease.writing.catch(() => {});
      await rm(lease.directory, { recursive: true, force: true });
      this.#leases.delete(lease.id);
    })().finally(() => { lease.cleaning = undefined; });
    return lease.cleaning;
  }

  async #removeAll(leases: Lease[]): Promise<void> {
    const results = await Promise.allSettled(leases.map(lease => this.remove(lease)));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'attachment upload cleanup failed');
  }
}
