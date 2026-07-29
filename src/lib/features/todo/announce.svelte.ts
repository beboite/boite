import type { TodoDelta } from "./diff";
import { uuid } from "$lib/shared/utils/uuid";

/**
 * The queue behind the card that appears when an agent touches the list.
 *
 * A toast was the obvious answer and the wrong one: a toast is for something
 * the app is telling you about itself, and it lives in a corner at 11px. This
 * is the other thing happening in the room — an agent finished a task and is
 * waiting on you — and it earns the middle of the window for two seconds.
 *
 * One at a time, and never more than a handful queued: an agent that adds nine
 * todos in a burst should say "nine todos", not hold the screen for twenty
 * seconds. The overflow is dropped rather than shown faster, because a card
 * nobody can read is worse than a card nobody sees.
 */
export interface Announcement extends TodoDelta {
  /** Fresh per announcement, so a repeat of the same todo remounts the card
      and restarts its timer rather than reusing a card mid-fade. */
  key: string;
}

const MAX_QUEUED = 3;

class TodoAnnouncer {
  current = $state<Announcement | null>(null);
  #queue: Announcement[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** How long a card stays up once it has arrived. */
  holdMs = 2600;

  push(deltas: TodoDelta[]) {
    for (const delta of deltas) {
      if (this.#queue.length >= MAX_QUEUED) break;
      this.#queue.push({ ...delta, key: uuid() });
    }
    this.#advance();
  }

  /** The card was clicked or the user acted; move on without waiting. */
  dismiss() {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.current = null;
    // A frame between two cards, so the outgoing one is seen to leave rather
    // than being replaced in place by different text.
    setTimeout(() => this.#advance(), 180);
  }

  #advance() {
    if (this.current || this.#timer !== null) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.current = next;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.current = null;
      setTimeout(() => this.#advance(), 180);
    }, this.holdMs);
  }

  reset() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue = [];
    this.current = null;
  }
}

export const todoAnnouncer = new TodoAnnouncer();

