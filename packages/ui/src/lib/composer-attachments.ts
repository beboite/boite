import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, type Attachment, type ProviderSummary } from '@boite/contracts';
import { acceptAttachments, attachedBytes, isImageMimeType, readAttachmentFile } from './attachments';
import { bytes } from './format';
import { IMAGE_SOURCE_MAX_BYTES, isReducible, prepareImage, type ImageCodec } from './image-prepare';
import { fill, strings } from './strings';
import type { Store } from './store.svelte';

export interface Holder {
  /** What is attached now, read again before each file: a removal made meanwhile counts. */
  held(): Attachment[];
  /** One attachment that passed every cap. */
  add(attachment: Attachment): void;
  /** Null when images go anywhere, as files given with an answer do. */
  noImages: { provider: string } | null;
  codec?: ImageCodec;
}

/**
 * Files read into attachments one at a time: an image brought to a sendable
 * size first (`lib/image-prepare.ts`), then the caps checked before base64 is
 * allocated. The attach buttons, pasted files and dropped files of the
 * composer and of a question card all come through here; `lib/attachments.ts`
 * owns the caps. A refused file says why and the rest go on. Returns the first
 * reason, or null.
 */
export async function gatherAttachments(files: File[], holder: Holder): Promise<string | null> {
  let refused: string | null = null;
  const refuse = (message: string): void => { refused ??= message; };
  for (const file of files) {
    if (holder.held().length >= ATTACHMENTS_PER_TURN) {
      refuse(fill(strings.composer.attachTooMany, { name: file.name, max: String(ATTACHMENTS_PER_TURN) }));
      break;
    }
    if (holder.noImages !== null && isImageMimeType(file.type)) {
      refuse(fill(strings.composer.attachNoImages, { provider: holder.noImages.provider }));
      continue;
    }
    // Without image input nothing becomes an image: a HEIC, BMP or TIFF goes as the file it is.
    const image = holder.noImages === null && isReducible(file);
    let ready = file;
    if (image) {
      const prepared = await prepareImage(file, holder.codec);
      if (prepared.kind === 'tooLarge') {
        refuse(fill(strings.media.sourceTooLarge, { name: file.name, size: bytes(file.size), max: bytes(IMAGE_SOURCE_MAX_BYTES) }));
        continue;
      }
      ready = prepared.file;
    }
    if (ready.size > ATTACHMENT_MAX_BYTES) {
      refuse(fill(strings.composer.attachTooLarge, { name: file.name, max: bytes(ATTACHMENT_MAX_BYTES) }));
      continue;
    }
    if (attachedBytes(holder.held()) + ready.size > ATTACHMENTS_TOTAL_MAX_BYTES) {
      refuse(fill(strings.composer.attachTotalTooLarge, { name: file.name, max: bytes(ATTACHMENTS_TOTAL_MAX_BYTES) }));
      continue;
    }
    try {
      const attachment = await readAttachmentFile(ready);
      const result = acceptAttachments(holder.held(), [attachment]);
      if (result.refused !== null) refuse(result.refused);
      else holder.add(attachment);
    } catch {
      refuse(fill(strings.composer.attachReadError, { name: file.name }));
    }
  }
  return refused;
}

/** The composer's way in: `gatherAttachments` on its state, a refusal in `store.error`. */
export async function attachFiles(
  store: Store,
  files: File[],
  state: { attachments: Attachment[] },
  attachmentProvider: ProviderSummary | null | undefined,
  onimage?: () => void,
  codec?: ImageCodec
): Promise<void> {
  const refused = await gatherAttachments(files, {
    held: () => state.attachments,
    add: (attachment) => {
      state.attachments = [...state.attachments, attachment];
      if (attachment.kind === 'image') onimage?.();
    },
    noImages: attachmentProvider && !attachmentProvider.capabilities.images ? { provider: attachmentProvider.name } : null,
    codec
  });
  if (refused !== null) store.error = refused;
}
