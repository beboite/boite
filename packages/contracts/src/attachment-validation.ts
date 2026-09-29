import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, IMAGE_MIME_TYPES } from './attachment-limits.ts';
import type { ProviderDescriptor } from './index.ts';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
function refused(message: string, data?: Record<string, unknown>) { return { message, ...(data ? { data } : {}) }; }
function decodedBytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor(data.length * 3 / 4) - padding;
}

/** Pure validation shared by the core and its in-memory client. */
export function attachmentError(attachments: unknown, provider: Pick<ProviderDescriptor, 'id' | 'name' | 'capabilities'>): { message: string; data?: Record<string, unknown> } | null {
  if (!Array.isArray(attachments)) return refused('attachments must be an array');
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment || typeof attachment !== 'object') return refused(`attachment ${index + 1}: expected an object`);
  }
  if (attachments.length === 0) return null;
  if (!provider.capabilities.images && attachments.some(a => a?.kind === 'image')) {
    return refused(`${provider.name} takes no images: send the prompt without them`, { providerId: provider.id });
  }
  if (attachments.length > ATTACHMENTS_PER_TURN) {
    return refused(`a turn carries at most ${ATTACHMENTS_PER_TURN} attachments, this one has ${attachments.length}`, {
      count: attachments.length,
      max: ATTACHMENTS_PER_TURN,
    });
  }
  let total = 0;
  for (const [index, attachment] of attachments.entries()) {
    if (attachment.name !== null && (typeof attachment.name !== 'string' || attachment.name.length > 255)) return refused(`attachment ${index + 1}: name must be null or a string of at most 255 characters`);
    const label = attachment.name ?? `attachment ${index + 1}`;
    if (attachment.kind !== 'image' && attachment.kind !== 'file') {
      return refused(`${label}: expected an image or file attachment`, { index });
    }
    if (typeof attachment.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) || attachment.mimeType.length > 128) return refused(`${label}: mimeType must be a media type such as application/pdf`, { index });
    if (attachment.kind === 'image' && !(IMAGE_MIME_TYPES as readonly string[]).includes(attachment.mimeType)) {
      return refused(`${label}: ${attachment.mimeType} is not an image format an agent reads (${IMAGE_MIME_TYPES.join(', ')})`, {
        index,
        mimeType: attachment.mimeType,
      });
    }
    if (typeof attachment.data !== 'string' || (attachment.kind === 'image' && attachment.data.length === 0) || attachment.data.length % 4 !== 0 || (attachment.data !== '' && !BASE64.test(attachment.data))) {
      return refused(`${label}: the attachment data is not base64 (no data: prefix, no line breaks)`, { index });
    }
    const bytes = decodedBytes(attachment.data);
    if (bytes > ATTACHMENT_MAX_BYTES) {
      return refused(`${label}: ${(bytes / 1048576).toFixed(1)} MB is over the ${ATTACHMENT_MAX_BYTES / 1048576} MB a file may weigh`, {
        index,
        bytes,
        max: ATTACHMENT_MAX_BYTES,
      });
    }
    total += bytes;
  }
  if (total > ATTACHMENTS_TOTAL_MAX_BYTES) {
    return refused(`the attachments weigh ${(total / 1048576).toFixed(1)} MB together, over the ${ATTACHMENTS_TOTAL_MAX_BYTES / 1048576} MB one turn may carry`, {
      bytes: total,
      max: ATTACHMENTS_TOTAL_MAX_BYTES,
    });
  }
  return null;
}
