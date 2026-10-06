import type { Attachment } from '@boite/contracts';

/** UI-only placeholder; its bytes must be recovered before anything is sent. */
export type DraftAttachment = Attachment & { pendingDraftAsset?: string };

export function unresolvedAssetId(attachment: Attachment): string | undefined {
  return (attachment as DraftAttachment).pendingDraftAsset;
}

/** What `pendingDraftAsset` starts with on a sent message's picture or file whose bytes stayed on its machine. */
const SENT_MEDIA = 'media:';

/** A sent message's picture or file, back in the box without its bytes until `Store.recoverSentMedia` fetches them. */
export function sentMediaPlaceholder(attachment: Attachment, slot: string): DraftAttachment {
  return { ...attachment, pendingDraftAsset: `${SENT_MEDIA}${slot}` };
}

/** The slot a placeholder's bytes are fetched from, or null for anything else. */
export function sentMediaSlot(attachment: Attachment): string | null {
  const pending = unresolvedAssetId(attachment);
  return pending?.startsWith(SENT_MEDIA) ? pending.slice(SENT_MEDIA.length) : null;
}
