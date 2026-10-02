import type { Message } from '@boite/contracts';

/**
 * How often the finished side was rebuilt. `turn-progress.svelte.test.ts` and
 * the MessageList bench read it to prove a streamed delta never rebuilds it.
 */
export const turnProgressStats = { finishedScans: 0 };

function wrote(message: Message): boolean {
  return message.parts.some((part) => (part.type === 'text' || part.type === 'thinking' ? part.text.length > 0 : true));
}

/**
 * Which turns have started answering in the timeline. Finished messages and
 * streaming ones are derived apart: a delta
 * appends to a streaming part, so only the small live side re-runs, and the
 * scan over every loaded message happens when a message finishes or arrives.
 * The live side of `responded` is a string, so once a turn has answered the
 * next deltas compare equal and nothing downstream re-runs.
 */
export class TurnProgress {
  #messages: () => Message[];

  constructor(messages: () => Message[]) {
    this.#messages = messages;
  }

  // The state test comes before any part is read, so a streaming part is never tracked here.
  #finished = $derived.by(() => {
    turnProgressStats.finishedScans += 1;
    const answered = this.#messages().filter((message) => message.role === 'assistant' && message.state !== 'streaming');
    return {
      responded: new Set(answered.filter(wrote).map((message) => message.turnId))
    };
  });

  #streaming = $derived.by(() => this.#messages().filter((message) => message.role === 'assistant' && message.state === 'streaming'));

  #liveResponded = $derived(this.#streaming.filter(wrote).map((message) => message.turnId).join('\n'));

  #liveRespondedSet = $derived(new Set(this.#liveResponded.split('\n').filter(Boolean)));

  responded(turnId: string): boolean {
    return this.#finished.responded.has(turnId) || this.#liveRespondedSet.has(turnId);
  }
}
