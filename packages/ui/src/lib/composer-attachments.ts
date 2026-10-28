import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, type Attachment, type ProviderSummary } from '@boite/contracts';
import { acceptAttachments, attachedBytes, decodedBytes, isImageMimeType, readAttachmentFile } from './attachments';
import { bytes } from './format';
import { IMAGE_SOURCE_MAX_BYTES, isReducible, prepareImage, type ImageCodec } from './image-prepare';
import { fill, strings } from './strings';
import { fitTurn } from './turn-fit';

/** The composer reads the running fit of its box here, beside the other ways pictures come in. */
export { fitting } from './turn-fit';
import type { Store } from './store.svelte';

/** Files dropped on the shell window, wherever they land (`lib/native-drop.ts`). */
export { receiveDroppedFiles } from './native-drop';

export interface Holder {
  /** What is attached now, read again before each file: a removal made meanwhile counts. */
  held(): Attachment[];
  /** One attachment that passed every cap. */
  add(attachment: Attachment): void;
  /** Held attachments swapped for the lighter copies a fitted turn made of them (`lib/turn-fit.ts`). */
  replace(lighter: Map<Attachment, Attachment>): void;
  /** Null when images go anywhere, as files given with an answer do. */
  noImages: { provider: string } | null;
  codec?: ImageCodec;
}

/**
 * Files read into attachments one at a time: an image brought to a sendable
 * size first (`lib/image-prepare.ts`), then the caps checked. The attach
 * buttons, pasted files and dropped files of the composer and of a question
 * card all come through here; `lib/attachments.ts` owns the caps. Files go in
 * as they are read while the turn stays under its byte total; the ones after
 * that wait for the rest of the batch, and the turn is fitted once with them
 * (`lib/turn-fit.ts`), the images already held included. A refused file says
 * why and the rest go on. Returns the first reason, or null.
 */
export async function gatherAttachments(files: File[], holder: Holder): Promise<string | null> {
  let refused: string | null = null;
  const refuse = (message: string): void => { refused ??= message; };
  const waiting: { attachment: Attachment; name: string }[] = [];
  for (const file of files) {
    if (holder.held().length + waiting.length >= ATTACHMENTS_PER_TURN) {
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
    let attachment: Attachment;
    try { attachment = await readAttachmentFile(ready); } catch {
      refuse(fill(strings.composer.attachReadError, { name: file.name }));
      continue;
    }
    if (waiting.length > 0 || attachedBytes(holder.held()) + ready.size > ATTACHMENTS_TOTAL_MAX_BYTES) {
      waiting.push({ attachment, name: file.name });
      continue;
    }
    const result = acceptAttachments(holder.held(), [attachment]);
    if (result.refused !== null) refuse(result.refused);
    else holder.add(attachment);
  }
  if (waiting.length > 0) await admitFitted(waiting, holder, refuse);
  return refused;
}

/** The files past the byte total, in once the whole turn is fitted, as many as it then holds. */
async function admitFitted(waiting: { attachment: Attachment; name: string }[], holder: Holder, refuse: (message: string) => void): Promise<void> {
  const held = holder.held();
  const fitted = await fitTurn([...held, ...waiting.map(item => item.attachment)], holder.codec);
  const lighter = new Map(held.flatMap((attachment, at) => fitted.attachments[at] === attachment ? [] : [[attachment, fitted.attachments[at]!] as const]));
  if (lighter.size > 0) holder.replace(lighter);
  waiting.forEach((item, at) => {
    const attachment = fitted.attachments[held.length + at]!;
    if (holder.held().length >= ATTACHMENTS_PER_TURN) {
      refuse(fill(strings.composer.attachTooMany, { name: item.name, max: String(ATTACHMENTS_PER_TURN) }));
      return;
    }
    if (attachedBytes(holder.held()) + decodedBytes(attachment.data) > ATTACHMENTS_TOTAL_MAX_BYTES) {
      refuse(fill(strings.composer.attachTotalTooLarge, { name: item.name, max: bytes(ATTACHMENTS_TOTAL_MAX_BYTES) }));
      return;
    }
    holder.add(attachment);
  });
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
    replace: (lighter) => { state.attachments = state.attachments.map(attachment => lighter.get(attachment) ?? attachment); },
    noImages: attachmentProvider && !attachmentProvider.capabilities.images ? { provider: attachmentProvider.name } : null,
    codec
  });
  if (refused !== null) store.error = refused;
}
