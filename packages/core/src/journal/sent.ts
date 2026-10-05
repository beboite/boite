import { RPC_MAX_FRAME_BYTES, type Message } from '@boite/contracts';
import { refused } from '../errors.ts';

/** What a read bound for a client sends for each message it reads. */
export type Projection = (message: Message) => Message;

/**
 * The message as the client receives it, and its serialized UTF-8 bytes. A
 * read with no projection is internal: nothing is sent and nothing is measured.
 */
export function sent(message: Message, project: Projection | undefined): { sent: Message; size: number } {
  if (!project) return { sent: message, size: 0 };
  const projected = project(message);
  const size = Buffer.byteLength(JSON.stringify(projected));
  // Unreachable with `compactToolParts`, which cuts a message to MESSAGE_SENT_MAX_BYTES.
  // Never pretend a message too large for any RPC frame was sent.
  if (size >= RPC_MAX_FRAME_BYTES) {
    throw refused(`message ${message.id} is ${size} serialized UTF-8 bytes; expected a complete message below ${RPC_MAX_FRAME_BYTES} bytes`,
      { threadId: message.threadId, messageId: message.id, field: 'messages', bytes: size, max: RPC_MAX_FRAME_BYTES, expected: `a complete message below ${RPC_MAX_FRAME_BYTES} serialized UTF-8 bytes` });
  }
  return { sent: projected, size };
}
