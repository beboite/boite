/**
 * Images on their way to a prompt: a file read into the shape the contract
 * carries, and the three caps the core enforces again on its side. Nothing here
 * touches the store or the DOM beyond `FileReader`, so every rule is testable
 * on its own.
 */
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_TURN,
  IMAGE_MIME_TYPES,
  type ImageAttachment,
  type ImageMimeType
} from '@boite/contracts';
import { bytes } from './format';
import { fill, strings } from './i18n.svelte';

/** The formats named in a refusal, the contract's own list and nothing else. */
const FORMATS = IMAGE_MIME_TYPES.join(', ');

export function isImageMimeType(type: string): type is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

/**
 * The body of a `data:` url, or the string itself when it carries no prefix.
 * The contract wants base64 alone: `data:image/png;base64,` is the browser's.
 */
export function stripDataPrefix(value: string): string {
  const comma = value.indexOf(',');
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
}

/** What a base64 body weighs once decoded, without decoding it. */
export function decodedBytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * One file as an attachment, its base64 body stripped of the `data:` prefix.
 * The mime type is the file's own and is not checked here: `acceptAttachments`
 * is what refuses a format no agent reads, so a refusal can name the file.
 */
export function readImageFile(file: File): Promise<ImageAttachment> {
  return new Promise<ImageAttachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name || 'the file'} could not be read`));
    reader.onload = () => {
      resolve({
        kind: 'image',
        mimeType: file.type as ImageMimeType,
        data: stripDataPrefix(typeof reader.result === 'string' ? reader.result : ''),
        name: file.name === '' ? null : file.name
      });
    };
    reader.readAsDataURL(file);
  });
}

export interface AcceptResult {
  /** What the composer should hold now: the ones it had plus the ones that passed. */
  accepted: ImageAttachment[];
  /** The first refusal, naming the file and the limit it hit, or null. */
  refused: string | null;
}

/**
 * The incoming images against the three caps, in the order a user meets them:
 * a format no agent reads, a body over `ATTACHMENT_MAX_BYTES`, then more than
 * `ATTACHMENTS_PER_TURN` in one turn. Everything that passes is kept, so one
 * bad file in a drop of five does not lose the other four.
 */
export function acceptAttachments(
  current: ImageAttachment[],
  incoming: ImageAttachment[]
): AcceptResult {
  const accepted = [...current];
  let refused: string | null = null;
  const refuse = (message: string): void => {
    refused ??= message;
  };

  for (const attachment of incoming) {
    const name = attachment.name ?? strings.composer.attachUnnamed;
    if (!isImageMimeType(attachment.mimeType)) {
      refuse(fill(strings.composer.attachFormat, { name, type: attachment.mimeType, formats: FORMATS }));
      continue;
    }
    if (decodedBytes(attachment.data) > ATTACHMENT_MAX_BYTES) {
      refuse(fill(strings.composer.attachTooLarge, { name, max: bytes(ATTACHMENT_MAX_BYTES) }));
      continue;
    }
    if (accepted.length >= ATTACHMENTS_PER_TURN) {
      refuse(fill(strings.composer.attachTooMany, { name, max: String(ATTACHMENTS_PER_TURN) }));
      continue;
    }
    accepted.push(attachment);
  }

  return { accepted, refused };
}
