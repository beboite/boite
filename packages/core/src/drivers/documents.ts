/**
 * Tool documents: what a tool call produced or changed, journalled with the
 * tool part and shown under the card's input and output. Every driver that
 * makes one goes through here, so the image cap holds whatever the agent sends.
 */
import type { ToolDocument } from '@boite/contracts';

/**
 * The most base64 an image document may carry. A journal row is read back whole
 * on every `threads.get`, so an unbounded screenshot would be paid for on every
 * open of the thread; past the cap the reader gets a line saying so instead.
 */
export const IMAGE_BASE64_MAX = 2 * 1024 * 1024;

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * An image document, or a markdown one saying it was too large. `data` is
 * base64 with no `data:` prefix, the way both the contract and ACP carry it.
 */
export function imageDocument(mimeType: string, data: string, alt: string | null): ToolDocument {
  if (data.length <= IMAGE_BASE64_MAX) return { kind: 'image', mimeType, data, alt };
  return {
    kind: 'markdown',
    title: alt,
    text: `The image is too large to show: ${megabytes(data.length)} MB of base64, over the ${megabytes(IMAGE_BASE64_MAX)} MB cap.`,
  };
}
