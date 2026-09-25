import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, type Attachment, type ProviderSummary } from '@boite/contracts';
import { acceptAttachments, attachedBytes, readAttachmentFile } from './attachments';
import { bytes } from './format';
import { fill, strings } from './strings';
import type { Store } from './store.svelte';

/**
 * Reads files into a composer's attachments one at a time, checking their sizes
 * before allocating base64. The attach button, pasted files and dropped files
 * all come through here; `lib/attachments.ts` owns the caps. A file refused
 * says why in `store.error` and the rest go on.
 */
export async function attachFiles(
  store: Store,
  files: File[],
  state: { attachments: Attachment[] },
  attachmentProvider: ProviderSummary | null | undefined
): Promise<void> {
  for (const file of files) {
    if (file.size > ATTACHMENT_MAX_BYTES) {
      store.error = fill(strings.composer.attachTooLarge, { name: file.name, max: bytes(ATTACHMENT_MAX_BYTES) });
      continue;
    }
    if (state.attachments.length >= ATTACHMENTS_PER_TURN) {
      store.error = fill(strings.composer.attachTooMany, { name: file.name, max: String(ATTACHMENTS_PER_TURN) });
      break;
    }
    if (attachedBytes(state.attachments) + file.size > ATTACHMENTS_TOTAL_MAX_BYTES) {
      store.error = fill(strings.composer.attachTotalTooLarge, { name: file.name, max: bytes(ATTACHMENTS_TOTAL_MAX_BYTES) });
      continue;
    }
    try {
      const attachment = await readAttachmentFile(file);
      if (attachment.kind === 'image' && attachmentProvider && !attachmentProvider.capabilities.images) {
        store.error = fill(strings.composer.attachNoImages, { provider: attachmentProvider.name });
        continue;
      }
      const { accepted, refused } = acceptAttachments(state.attachments, [attachment]);
      state.attachments = accepted;
      if (refused !== null) store.error = refused;
    } catch {
      store.error = fill(strings.composer.attachReadError, { name: file.name });
    }
  }
}
