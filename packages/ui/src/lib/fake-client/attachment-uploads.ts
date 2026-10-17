import { answerAttachmentError, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, RpcErrorCode, type Attachment, type RpcParams } from '@boite/contracts';
import { RpcFailure } from '../client';
import { decodedBytes } from '../attachments';
import type { FakeContext, FakeMethods } from './context';

type Upload = { attachment: Attachment; bytes: number; expires: number };
const refuse = (message: string, data?: Record<string, unknown>) => new RpcFailure({ code: RpcErrorCode.Refused, message, data });
const expired = () => refuse('the attachment upload expired: send its bytes again', { reason: 'attachment-upload-expired' });

/** The fake enforces the same connection lease budget and attachment validation as the core. */
export class FakeAttachmentUploads {
  #entries = new Map<string, Upload>();
  constructor(private readonly ctx: FakeContext) {}
  clear(): void { this.#entries.clear(); }
  #expire(): void { for (const [id, entry] of this.#entries) if (entry.expires <= Date.now()) this.#entries.delete(id); }
  #require(id: string): Upload { const entry = this.#entries.get(id); if (!entry) throw expired(); return entry; }

  methods(): Pick<FakeMethods, 'attachments.upload' | 'attachments.release'> {
    return {
      'attachments.upload': async ({ attachment }) => {
        const error = answerAttachmentError([attachment]);
        if (error) throw refuse(error.message, error.data);
        this.#expire();
        const bytes = decodedBytes(attachment.data);
        const total = [...this.#entries.values()].reduce((sum, entry) => sum + entry.bytes, bytes);
        if (this.#entries.size >= ATTACHMENTS_PER_TURN) throw refuse(`a connection holds at most ${ATTACHMENTS_PER_TURN} attachment uploads`, { count: this.#entries.size + 1, max: ATTACHMENTS_PER_TURN });
        if (total > ATTACHMENTS_TOTAL_MAX_BYTES) throw refuse('the connection attachment uploads exceed the byte budget', { bytes: total, max: ATTACHMENTS_TOTAL_MAX_BYTES });
        const id = `upload-${++this.ctx.seq}`;
        this.#entries.set(id, { attachment: structuredClone(attachment), bytes, expires: Date.now() + 10 * 60_000 });
        return { id };
      },
      'attachments.release': async ({ ids }) => {
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw refuse('attachment upload IDs must be an array of nonempty strings');
        if (ids.length > ATTACHMENTS_PER_TURN) throw refuse(`release at most ${ATTACHMENTS_PER_TURN} attachment uploads at once`);
        this.#expire();
        for (const id of ids) this.#require(id);
        for (const id of ids) this.#entries.delete(id);
        return { ok: true };
      }
    };
  }

  resolve(params: RpcParams<'turns.start'>): RpcParams<'turns.start'> {
    const ids = params.attachmentIds;
    if (ids === undefined) return params;
    const files = params.attachments ?? [];
    if (!Array.isArray(files)) throw refuse('attachments must be an array');
    if (files.length > ATTACHMENTS_PER_TURN) throw refuse(`a turn carries at most ${ATTACHMENTS_PER_TURN} attachments`);
    if (!Array.isArray(ids) || ids.length !== files.length || ids.some(id => id !== null && (typeof id !== 'string' || !id))) throw refuse('attachment upload IDs must align with attachments: expected a string or null for every attachment');
    this.#expire();
    const attachments = files.map((attachment, index) => {
      const id = ids[index]!;
      if (id === null) return attachment;
      const entry = this.#require(id);
      if (!attachment || attachment.kind !== entry.attachment.kind || attachment.name !== entry.attachment.name || attachment.mimeType !== entry.attachment.mimeType || attachment.data !== '') throw refuse(`attachment ${index + 1}: upload metadata must match the original kind, name and mimeType, with empty data`, { index });
      return { ...attachment, data: entry.attachment.data };
    });
    const error = answerAttachmentError(attachments);
    if (error) throw refuse(error.message, error.data);
    return { ...params, attachments, attachmentIds: undefined };
  }
}
