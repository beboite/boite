import type { Attachment } from '@boite/contracts';

/** UI-only placeholder; its bytes must be recovered before anything is sent. */
export type DraftAttachment = Attachment & { pendingDraftAsset?: string };

export function unresolvedAssetId(attachment: Attachment): string | undefined {
  return (attachment as DraftAttachment).pendingDraftAsset;
}
