import type { Attachment } from '@boite/contracts';

/**
 * UI-only placeholders; their bytes must be there before anything is sent.
 * `pendingDraftAsset` names bytes the core keeps for this draft. `loading`
 * marks a file this device is still reading: its tile and its `[Image N]`
 * show at once, it is never saved or synced, and the file takes its place in
 * the list when it is ready (`composer-attachments.ts`).
 */
export type DraftAttachment = Attachment & { pendingDraftAsset?: string; loading?: true };

export function unresolvedAssetId(attachment: Attachment): string | undefined {
  return (attachment as DraftAttachment).pendingDraftAsset;
}

export function isLoading(attachment: Attachment): boolean {
  return (attachment as DraftAttachment).loading === true;
}

/** What a list holds once the files still being read are left out: what is saved and synced. */
export function readyAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.some(isLoading) ? attachments.filter(attachment => !isLoading(attachment)) : attachments;
}

/** The file that replaced each placeholder, so a tile keyed on it stays the same tile. */
const placeholders = new WeakMap<Attachment, Attachment>();

export function loadedFrom(ready: Attachment, placeholder: Attachment): void {
  placeholders.set(ready, placeholder);
}

/** Other boxes that took a copy of a placeholder, told once its file is read or refused. */
const followers = new WeakMap<Attachment, ((ready: Attachment | null) => void)[]>();

export function followRead(placeholder: Attachment, then: (ready: Attachment | null) => void): void {
  followers.set(placeholder, [...(followers.get(placeholder) ?? []), then]);
}

export function readSettled(placeholder: Attachment, ready: Attachment | null): void {
  const waiting = followers.get(placeholder);
  followers.delete(placeholder);
  for (const then of waiting ?? []) then(ready);
}

/** The key a list draws an attachment under: its placeholder's while it had one. */
export function tileKey(attachment: Attachment): Attachment {
  return placeholders.get(attachment) ?? attachment;
}
