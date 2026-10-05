import { projectMessage, type Message, type TransportOptions } from '@boite/contracts';

/**
 * One message as the client receives it (`projectMessage`), for the journal's
 * page budgets and its frame check. Every read bound for a client passes one,
 * even with nothing compacted: internal reads pass none and are neither
 * measured nor refused.
 */
export function transportProjection(options: TransportOptions): (message: Message) => Message {
  return message => projectMessage(message, options);
}
