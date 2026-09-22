/** Formats supported by providers' native image inputs. */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
/** Maximum decoded bytes per attachment. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Maximum attachments carried by one turn. */
export const ATTACHMENTS_PER_TURN = 8;
