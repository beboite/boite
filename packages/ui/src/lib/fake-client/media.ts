import {
  MEDIA_SLOT_PATTERN,
  RpcErrorCode,
  mediaAt,
  messageWithMediaRefs,
  partWithMediaRefs,
  type Message,
  type RpcEventName,
  type RpcEvents,
  type RpcMethods,
  type Thread,
  type ThreadRewind
} from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext } from './context';

/*
 * The core's `MediaIndex` for the in-memory client, which says hello as the
 * UI does, with `media: 'ref'`. The bytes stay in the fake's own messages and
 * leave them only through `messages.media`. There is no image decoder here,
 * so a reference carries the size from the header and no blur.
 */

const noPreview = () => null;

const message = (value: Message): Message => messageWithMediaRefs(value, noPreview);
const thread = (value: Thread): Thread => ({ ...value, messages: value.messages.map(message) });

/** What a media client is sent for `method`'s answer, as the core's `MediaIndex.result`. */
export function fakeMediaResult(method: string, result: unknown): unknown {
  switch (method) {
    case 'threads.get':
      return thread(result as Thread);
    case 'messages.list': {
      const page = result as { messages: Message[] };
      return { ...page, messages: page.messages.map(message) };
    }
    case 'threads.rewind': {
      const rewind = result as ThreadRewind;
      return { ...rewind, thread: thread(rewind.thread) };
    }
    case 'artifacts.publish':
      return message(result as Message);
    default:
      return result;
  }
}

/** The event a media client is sent, as the core's `MediaIndex.event`. */
export function fakeMediaEvent<E extends RpcEventName>(name: E, payload: RpcEvents[E]): RpcEvents[E] {
  if (name === 'message.started') return message(payload as Message) as RpcEvents[E];
  if (name !== 'message.part') return payload;
  const event = payload as RpcEvents['message.part'];
  const part = partWithMediaRefs(event.part, event.partIndex, event.messageId, noPreview);
  return (part === event.part ? payload : { ...event, part }) as RpcEvents[E];
}

export function mediaMethods(ctx: FakeContext): { 'messages.media': (params: RpcMethods['messages.media']['params']) => Promise<RpcMethods['messages.media']['result']> } {
  return {
    'messages.media': async (params) => {
      const held = ctx.thread(params.threadId);
      if (typeof params.slot !== 'string' || !MEDIA_SLOT_PATTERN.test(params.slot)) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'slot: expected p<part> or p<part>d<document>, as a MediaRef names it', data: { field: 'slot', slot: params.slot } });
      }
      const found = held.messages.find((entry) => entry.id === params.messageId);
      if (found === undefined) {
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `message ${params.messageId} is not a message of thread ${params.threadId}`, data: { field: 'messageId', messageId: params.messageId, threadId: params.threadId } });
      }
      const media = mediaAt(found, params.slot);
      if (media === null) {
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `slot ${params.slot} of message ${params.messageId} holds no image or file`, data: { field: 'slot', slot: params.slot } });
      }
      return { ...media };
    }
  };
}
