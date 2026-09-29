import type { Message } from '@boite/contracts';

/**
 * How often the finished side was rebuilt. `turn-progress.svelte.test.ts` and
 * the MessageList bench read it to prove a streamed delta never rebuilds it.
 */
export const turnProgressStats = { finishedScans: 0 };

export interface Thought {
  host: string;
  text: string;
  live: boolean;
}

function wrote(message: Message): boolean {
  return message.parts.some((part) => (part.type === 'text' || part.type === 'thinking' ? part.text.length > 0 : true));
}

/** One reasoning disclosure per turn: new reasoning replaces the text, the first message keeps the host. */
function collectThoughts(messages: Message[]): Map<string, Thought> {
  const result = new Map<string, Thought>();
  for (const message of messages) {
    for (const [index, part] of message.parts.entries()) {
      if (part.type !== 'thinking') continue;
      const previous = result.get(message.turnId);
      result.set(message.turnId, {
        host: previous?.host ?? message.id,
        text: part.text || previous?.text || '',
        live: message.state === 'streaming' && index === message.parts.length - 1
      });
    }
  }
  return result;
}

/**
 * Which turns have started answering and what each one reasoned, for the
 * timeline. Finished messages and streaming ones are derived apart: a delta
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
      responded: new Set(answered.filter(wrote).map((message) => message.turnId)),
      thoughts: collectThoughts(answered)
    };
  });

  #streaming = $derived.by(() => this.#messages().filter((message) => message.role === 'assistant' && message.state === 'streaming'));

  #liveResponded = $derived(this.#streaming.filter(wrote).map((message) => message.turnId).join('\n'));

  #liveRespondedSet = $derived(new Set(this.#liveResponded.split('\n').filter(Boolean)));

  #liveThoughts = $derived(collectThoughts(this.#streaming));

  responded(turnId: string): boolean {
    return this.#finished.responded.has(turnId) || this.#liveRespondedSet.has(turnId);
  }

  thought(turnId: string): Thought | undefined {
    const done = this.#finished.thoughts.get(turnId);
    const live = this.#liveThoughts.get(turnId);
    if (!live) return done;
    return { host: done?.host ?? live.host, text: live.text || done?.text || '', live: live.live };
  }
}
