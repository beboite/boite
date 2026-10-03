/** Formats supported by providers' native image inputs. */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
/**
 * Maximum decoded bytes per attachment. Claude's API refuses an image over
 * 5 MB; the UI brings a photo or a screenshot well under it before sending
 * (2048 px on its long edge, JPEG at 0.85: about 0.3 to 1.5 MB).
 */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Maximum attachments carried by one turn: a series of phone screenshots fits. */
export const ATTACHMENTS_PER_TURN = 20;
/**
 * Maximum decoded bytes of all the attachments of one turn together. They
 * travel inside the `turns.start` frame as base64, a third larger, so 10 MB
 * becomes about 13.3 MB on the wire and leaves 2.7 MB of `RPC_MAX_FRAME_BYTES`
 * for the prompt and the envelope. The user message keeps them inline in the
 * journal as well, and `threads.get` cannot page a message heavier than that
 * frame, so this total cannot grow without a separate upload channel.
 */
export const ATTACHMENTS_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
/**
 * The request and RPC response ceiling in serialized UTF-8 bytes, including
 * the JSON-RPC envelope and all result metadata. Bun's `maxPayloadLength`
 * closes the socket on a larger request before any handler runs, so the client
 * refuses one before sending it. The core checks each serialized response and
 * sends a bounded refusal instead of an oversized result. Streaming event
 * frames retain their existing transport behavior.
 */
export const RPC_MAX_FRAME_BYTES = 16 * 1024 * 1024;
