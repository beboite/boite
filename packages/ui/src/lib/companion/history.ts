/*
 * The companion's last exchanges, read back from its thread for the history
 * in its panel: what the user asked, without what the companion put around it
 * (the role and the memory of a first request, the date line, the bracketed
 * lines), and the reply as the bubble shows it. Nothing is copied locally:
 * the thread is the record.
 */
import type { Message } from '@boite/contracts';
import type { Client } from '../client';
import { COMPANION_ROLE, MEMORY_AGAIN, PRIMING_END, replyText } from './brain';
import { visibleReply } from './directives';

export interface Exchange {
  /** The request's message id. */
  id: string;
  request: string;
  reply: string;
  at: number;
}

/** About twenty exchanges, the tool calls between them compacted. */
export const HISTORY_EXCHANGES = 20;
const HISTORY_MESSAGES = 120;
/** How a request that carries the role or the memory starts. */
const PRIMED_OPENINGS = [COMPANION_ROLE.slice(0, 40), MEMORY_AGAIN.slice(0, 40)];

/** The request as the user typed it. */
export function requestText(prompt: string): string {
  let text = prompt;
  if (PRIMED_OPENINGS.some((opening) => text.startsWith(opening))) {
    const end = text.indexOf(PRIMING_END);
    text = end < 0 ? '' : text.slice(end + PRIMING_END.length);
  }
  return text
    .split('\n')
    .filter((line) => !/^\s*\[[^\]]*\]\s*$/.test(line))
    .join('\n')
    .trim();
}

const userText = (message: Message) => message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');

/** Each request with the last words its turn wrote, oldest first, at most `limit`. */
export function exchangesOf(messages: readonly Message[], limit = HISTORY_EXCHANGES): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: Exchange | null = null;
  for (const message of messages) {
    if (message.role === 'user') {
      current = { id: message.id, request: requestText(userText(message)), reply: '', at: message.createdAt };
      exchanges.push(current);
    } else if (message.role === 'assistant' && current) {
      const reply = visibleReply(replyText(message));
      if (reply) current.reply = reply;
    }
  }
  return exchanges.filter((exchange) => exchange.request || exchange.reply).slice(-limit);
}

/** The thread's last exchanges, newest first. */
export async function readHistory(client: Client, threadId: string): Promise<Exchange[]> {
  const { messages } = await client.call('threads.get', { threadId, limit: HISTORY_MESSAGES, compactTools: true, compactFiles: true, compactImages: true });
  return exchangesOf(messages).reverse();
}
