import type { OrchestratorMessage } from "$lib/backend/types";

/** How the conversation asks for what it has not seen yet. */
export type FetchMessages = (
  sinceId: string | null,
) => Promise<OrchestratorMessage[]>;

/**
 * The orchestrator conversation, as a cursor over an append-only log.
 *
 * Event-driven and nothing else: `refresh` runs when something announced a
 * change — a Tauri event on desktop, a control event on remote, this window's
 * own post — and never on a timer. The test pins that by counting calls.
 *
 * The cursor is the last message id we hold, so a refresh only carries what is
 * new; two refreshes racing coalesce into one fetch plus one follow-up rather
 * than interleaving appends out of order.
 */
export class Conversation {
  messages = $state<OrchestratorMessage[]>([]);
  #fetch: FetchMessages;
  #inFlight: Promise<void> | null = null;
  #again = false;

  constructor(fetch: FetchMessages) {
    this.#fetch = fetch;
  }

  get cursor(): string | null {
    const last = this.messages[this.messages.length - 1];
    return last ? last.id : null;
  }

  /** Pulls what arrived since the cursor. Safe to call from several events. */
  refresh(): Promise<void> {
    if (this.#inFlight) {
      // A refresh is already reading; remember that something changed under it
      // rather than starting a second fetch against the same cursor.
      this.#again = true;
      return this.#inFlight;
    }
    this.#inFlight = this.#pull().finally(() => {
      this.#inFlight = null;
      if (this.#again) {
        this.#again = false;
        void this.refresh();
      }
    });
    return this.#inFlight;
  }

  async #pull(): Promise<void> {
    const fresh = await this.#fetch(this.cursor);
    if (!fresh.length) return;
    const seen = new Set(this.messages.map((m) => m.id));
    const news = fresh.filter((m) => !seen.has(m.id));
    if (news.length) this.messages = [...this.messages, ...news];
  }

  /** A workspace switch invalidates everything: the rows live in that DB. */
  reset() {
    this.messages = [];
    this.#again = false;
  }
}
