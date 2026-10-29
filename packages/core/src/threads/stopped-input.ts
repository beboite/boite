import { ATTACHMENTS_PER_TURN, type Attachment, type Message, type MessagePart, type TurnId } from '@boite/contracts';
import type { PartPlace } from '../continuation.ts';
import type { Journal } from '../journal.ts';
import { nativeCommandPrompt } from './operations.ts';

type FilePart = Extract<MessagePart, { type: 'file' }>;

/**
 * Stop can win before a provider saves the prompt, even when an older native
 * session exists. Carry interrupted user input until a later user turn succeeds.
 * Read the journal rather than consuming a queue, so another stop or restart
 * cannot lose it. Native commands and automatic turns do not consume it.
 */
export function stoppedInput(
  journal: Journal,
  threadId: string,
  turnId: TurnId,
  input: { prompt: string; attachments: Attachment[] },
  fileReference: (file: FilePart, place: PartPlace) => string,
): { prompt: string; attachments: Attachment[] } {
  const opening = journal.db.query('SELECT MIN(rowid) AS first FROM messages WHERE thread_id = ? AND turn_id = ?').get(threadId, turnId) as { first: number | null };
  if (opening.first === null) return input;
  // Read user rows without blobs until a completed request: assistant/tool
  // payloads are irrelevant, and stopped attachments load only when carried.
  const statement = journal.db.prepare("SELECT id, turn_id AS turnId, parts FROM messages WHERE thread_id = ? AND role = 'user' AND rowid < ? ORDER BY rowid DESC");
  const messages: Message[] = [];
  try {
    for (const row of statement.iterate(threadId, opening.first) as Iterable<{ id: string; turnId: TurnId; parts: string }>) {
      const turn = journal.getTurn(row.turnId);
      if (!turn || turn.execution?.operation || turn.execution?.automatic) continue;
      const parts = JSON.parse(row.parts) as MessagePart[];
      if (nativeCommandPrompt(parts.filter(part => part.type === 'text').map(part => part.text).join(''))) continue;
      if (turn.status === 'done') break;
      if (turn.status === 'stopped') {
        const message = journal.getMessage(row.id);
        if (message) messages.push(message);
      }
    }
  } finally { statement.finalize(); }
  if (messages.length === 0) return input;
  messages.reverse();
  const images = messages.flatMap(message => message.parts.filter(part => part.type === 'image'));
  const slots = ATTACHMENTS_PER_TURN - input.attachments.filter(part => part.kind === 'image').length;
  const kept = new Set(images.slice(Math.max(0, images.length - slots)));
  const attachments: Attachment[] = [];
  const history = messages.map(message => {
    const parts = message.parts.map((part, partIndex) => {
      const place = { messageId: message.id, partIndex };
      if (part.type === 'text') return (part.moved?.note ?? '') + part.text;
      if (part.type === 'file') return fileReference(part, place);
      if (part.type !== 'image') return '';
      if (!kept.has(part)) return fileReference({ type: 'file', mimeType: part.mimeType, data: part.data, name: part.alt }, place);
      attachments.push({ kind: 'image', mimeType: part.mimeType, data: part.data, name: part.alt });
      return `[Image: ${part.alt ?? 'attachment'}]`;
    }).filter(Boolean).join('\n');
    return `[Earlier user message, turn stopped]\n${parts}`;
  }).join('\n\n');
  return {
    prompt: `Earlier user messages were stopped and may be missing from your native session. Keep them as conversation context; the current user request determines what to do next. Do not repeat completed work.\n\n<interrupted-user-messages>\n${history}\n</interrupted-user-messages>\n\nCurrent user request:\n${input.prompt}`,
    attachments: [...attachments, ...input.attachments],
  };
}
