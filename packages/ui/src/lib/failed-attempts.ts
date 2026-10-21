import type { MemoryEvent, Message } from '@boite/contracts';

/** Only empty failed attempts fold together. Work, prompts and unloaded history keep their place. */
export function failedRun(timeline: readonly Message[], start: number, memory?: ReadonlyMap<string, MemoryEvent[]>, breaks?: ReadonlyMap<string, unknown>): Message[] | undefined {
  const messages: Message[] = [];
  let attempts = 0;
  let at = start;
  while (at < timeline.length) {
    const first = timeline[at]!;
    const wake = first.role === 'system' && first.parts.length > 0 && first.parts.every(part => part.type === 'text' && !part.moved && !part.started) ? first : undefined;
    const error = wake ? timeline[at + 1] : first;
    if (!error || error.role !== 'assistant' || error.state === 'streaming' ||
      error.parts.find(part => part.type !== 'text' || part.text.trim())?.type !== 'error' ||
      !error.parts.every(part => part.type === 'error' || part.type === 'text' && !part.text.trim()) ||
      wake && (wake.state === 'streaming' || wake.turnId !== error.turnId) ||
      memory?.get(first.id)?.length || memory?.get(error.id)?.length ||
      at > start && breaks?.has(first.id) || wake && breaks?.has(error.id)) break;
    messages.push(...(wake ? [wake, error] : [error]));
    at += wake ? 2 : 1;
    attempts += 1;
  }
  return attempts > 1 ? messages : undefined;
}
