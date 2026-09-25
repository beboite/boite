/** Formats supported by providers' native image inputs. */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
/** Maximum decoded bytes per attachment. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Maximum attachments carried by one turn. */
export const ATTACHMENTS_PER_TURN = 8;
/**
 * Maximum decoded bytes of all the attachments of one turn together. They
 * travel inside the `turns.start` frame as base64, a third larger, so 10 MB
 * becomes about 13.3 MB on the wire and leaves 2.7 MB of `RPC_MAX_FRAME_BYTES`
 * for the prompt and the envelope.
 */
export const ATTACHMENTS_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
/**
 * The largest frame the core reads, set as the websocket's `maxPayloadLength`
 * (Bun's own default, named so both ends agree). Bun closes the socket on a
 * larger frame before any handler runs, so the client refuses one before
 * sending it.
 */
export const RPC_MAX_FRAME_BYTES = 16 * 1024 * 1024;
