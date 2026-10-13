import type { Attachment } from '@boite/contracts';
import type { Client } from '../client';
import type { StoreContext } from './context';
import { unresolvedAssetId } from '../draft-attachments';

type Upload = { client: Client; generation: number; attachment: Attachment; id: string | null; selected: boolean; pins: number; released: boolean };
const same = (a: Attachment, b: Attachment) => a.kind === b.kind && a.mimeType === b.mimeType && a.name === b.name && a.data === b.data;

/** Upload leases stay separate from durable drafts, which always retain the original bytes. */
export class AttachmentUploads {
  #entries: Upload[] = [];
  constructor(private readonly ctx: StoreContext) {}

  select(files: Attachment[], supported: boolean): void {
    for (const held of this.#entries) held.selected = false;
    const client = this.ctx.client;
    if (client && supported) for (const attachment of files) {
      if (unresolvedAssetId(attachment)) continue;
      let held = this.#entries.find(entry => !entry.released && this.ctx.currentClient(entry.client, entry.generation) && same(entry.attachment, attachment));
      if (!held) {
        held = { client, generation: this.ctx.clientGeneration, attachment: { ...attachment }, id: null, selected: true, pins: 0, released: false };
        this.#entries.push(held);
        const made = held;
        void client.call('attachments.upload', { attachment: made.attachment }).then(({ id }) => {
          made.id = id;
          if (made.released || !this.ctx.currentClient(client, made.generation)) this.#release(made);
        }, () => {
          // Retain the selected null-id entry so typing does not retry; Send keeps the bytes.
        });
      }
      held.selected = true;
    }
    for (const entry of this.#entries) if (!entry.selected && !entry.pins) this.#release(entry);
    this.#entries = this.#entries.filter(entry => !entry.released);
  }

  pin(files: Attachment[]): () => void {
    const entries = this.#entries.filter(entry => !entry.released && files.some(file => same(file, entry.attachment)));
    for (const entry of entries) entry.pins++;
    return () => { for (const entry of entries) { entry.pins--; if (!entry.selected && !entry.pins) this.#release(entry); } };
  }

  payload(files: Attachment[]): { attachments: Attachment[]; attachmentIds?: (string | null)[] } {
    if (this.ctx.store.connection !== 'ready' || !this.ctx.store.core?.features?.attachmentUploads) return { attachments: files };
    const ids = files.map(file => this.#entries.find(entry => !entry.released && entry.id && this.ctx.currentClient(entry.client, entry.generation) && same(entry.attachment, file))?.id ?? null);
    return ids.some(Boolean) ? { attachments: files.map((file, i) => ids[i] ? { ...file, data: '' } : file), attachmentIds: ids } : { attachments: files };
  }

  forget(files: Attachment[]): void {
    for (const entry of this.#entries) if (files.some(file => same(file, entry.attachment))) this.#release(entry);
    this.#entries = this.#entries.filter(entry => !entry.released);
  }
  #release(entry: Upload): void {
    entry.released = true;
    if (entry.id) { const id = entry.id; entry.id = null; void entry.client.call('attachments.release', { ids: [id] }).catch(() => undefined); }
  }
  reset(): void { for (const entry of this.#entries) this.#release(entry); this.#entries = []; }
}
