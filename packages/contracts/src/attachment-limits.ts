/** Formats supported by providers' native image inputs. */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
/**
 * The longest edge, in pixels, of an image sent to an agent. Claude's API
 * refuses an image over 2000 px on either side once a request carries more
 * than 20 images, and a long thread of screenshots gets there: one image over
 * it would fail every later request of the conversation.
 */
export const IMAGE_MAX_EDGE = 2000;
/**
 * Maximum decoded bytes per attachment. Claude's API refuses an image over
 * 5 MB; the UI brings a photo or a screenshot well under it before sending
 * (`IMAGE_MAX_EDGE` on its long edge, JPEG at 0.85: about 0.3 to 1.5 MB).
 */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Maximum attachments carried by one turn: a long bug report with a screenshot
 * per problem fits. The count is not what weighs on a request: the byte total
 * below is, and the composer re-encodes a turn's images smaller so that fifty
 * of them stay inside it (`lib/turn-fit.ts` in the UI).
 */
export const ATTACHMENTS_PER_TURN = 50;
/**
 * Maximum decoded bytes of all the attachments of one turn together. They
 * travel inside the `turns.start` frame as base64, a third larger, so 10 MB
 * becomes about 13.3 MB on the wire and leaves 2.7 MB of `RPC_MAX_FRAME_BYTES`
 * for the prompt and the envelope. The user message keeps them inline in the
 * journal as well, and `threads.get` cannot page a message heavier than that
 * frame, so this total cannot grow without a separate upload channel. It also
 * keeps a Claude request under the API's 32 MB body limit: one turn's images
 * and the history images a fresh session carries share this one budget.
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
