import { previewFileData, previewToolOutputs, type Message } from '@boite/contracts';

export interface TransportOptions { compactTools?: boolean; compactFiles?: boolean }

/** The messages a client receives for these options: tool output previews, then deferred files. */
export function forTransport(messages: Message[], options: TransportOptions): Message[] {
  const tools = options.compactTools ? previewToolOutputs(messages) : messages;
  return options.compactFiles ? previewFileData(tools) : tools;
}

/**
 * One message as `forTransport` sends it, for the journal's page budgets.
 * Undefined when nothing is compacted, so the stored row is measured as is.
 */
export function transportProjection(options: TransportOptions): ((message: Message) => Message) | undefined {
  if (!options.compactTools && !options.compactFiles) return undefined;
  return message => forTransport([message], options)[0]!;
}
