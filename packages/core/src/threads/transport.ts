import { projectMessage, type ImagePreviews, type Message, type TransportOptions } from '@boite/contracts';

/**
 * One message as the client receives it (`projectMessage`), for the journal's
 * page budgets and its frame check. Every read bound for a client passes one,
 * even with nothing compacted: internal reads pass none and are neither
 * measured nor refused. `previews` gives a deferred picture its blur.
 */
export function transportProjection(options: TransportOptions, previews?: ImagePreviews): (message: Message) => Message {
  return message => projectMessage(message, options, previews);
}
