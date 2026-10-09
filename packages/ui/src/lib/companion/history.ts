/*
 * An agent's last exchanges with the user, for the history in the companion's
 * panel, read from the agents snapshot: what the user asked, without the line
 * the companion adds to a request (`contextLine`), and the agent's answer as
 * the bubble shows it. Nothing is copied locally: the agent's conversation,
 * in the Agents page, is the record.
 */
import type { AgentsSnapshot } from '@boite/contracts';
import { conversationOf } from './crew';
import { visibleReply } from './directives';

export interface Exchange {
  /** The request's message id. */
  id: string;
  request: string;
  reply: string;
  at: number;
}

export const HISTORY_EXCHANGES = 20;

/** Each request of the user's with the agent's answer, newest first, at most `limit`. */
export function exchangesOf(snapshot: AgentsSnapshot | null, agentId: string, limit = HISTORY_EXCHANGES): Exchange[] {
  const messages = conversationOf(snapshot, agentId);
  const answers = new Map(messages.flatMap((message) => (message.senderId === agentId && message.replyTo ? [[message.replyTo, message.text] as const] : [])));
  return messages
    .filter((message) => message.senderId === null)
    .map((message) => ({ id: message.id, request: visibleReply(message.text), reply: visibleReply(answers.get(message.id) ?? ''), at: message.createdAt }))
    .filter((exchange) => exchange.request || exchange.reply)
    .slice(-limit)
    .reverse();
}
