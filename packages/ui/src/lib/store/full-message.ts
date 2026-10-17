import { MESSAGE_PAGE_MAX, type Message, type MessageId, type Thread, type ThreadId } from '@boite/contracts';
import type { Client } from '../client';
import { lastIndexById } from '../thread-rows';

/**
 * A message whole, with the parts its page deferred. Older cores expose full
 * parts only through history pages: the page that ends right after the
 * message, then older ones until it shows. `current` is false once the
 * connection or the visit that asked has changed, and stops the walk.
 */
export async function fullMessage(client: Client, snapshots: Iterable<Thread>, threadId: ThreadId, messageId: MessageId, current: () => boolean): Promise<Message | undefined> {
  if (!current()) return undefined;
  const thread = [...snapshots].find(held => held.messages.some(message => message.id === messageId));
  const next = thread?.messages[lastIndexById(thread.messages, messageId) + 1]?.id;
  const page = next
    ? await client.call('messages.list', { threadId, before: next, limit: 1 })
    : await client.call('threads.get', { threadId, after: messageId });
  let message = page.messages.find(message => message.id === messageId);
  let before = 'before' in page ? page.before : page.messagesBefore;
  while (!message && before && current()) {
    const older = await client.call('messages.list', { threadId, before, limit: MESSAGE_PAGE_MAX });
    message = older.messages.find(message => message.id === messageId);
    if (older.before === before) break;
    before = older.before;
  }
  return message;
}
