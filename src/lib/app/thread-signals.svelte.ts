/**
 * What the app remembers about a thread until something consumes it.
 *
 * Five small things with one property in common: none of them is on the row,
 * none survives a reload, and each is written by one place and read once by
 * another. They lived in `AppState` beside the projects, the threads, the
 * navigation and the boot sequence, where their only relation to any of it was
 * that a thread id appeared in them.
 *
 * Nothing here writes to the database. If a value belongs in a column, it does
 * not belong in this file.
 */
export class ThreadSignals {
  /**
   * Bumped to make a mounted terminal relaunch its PTY.
   *
   * One key, not a new record: the record is a `$state` proxy, so writing the
   * key is already reactive, and replacing the whole object woke every mounted
   * terminal's relaunch effect on every single reload.
   */
  respawnNonce = $state<Record<string, number>>({});

  /**
   * Threads whose `sessionId` was nulled by legacy dedup.
   *
   * Reactive so the sidebar can show a red dot on each until the binding comes
   * back, which happens when the agent's own `/resume` lets the session monitor
   * steal it.
   */
  unbound = $state<string[]>([]);

  /**
   * Threads something outside the page wants running again.
   *
   * Terminals mount lazily — the page only mounts a thread the user has visited,
   * and mounting is what spawns the PTY. The post-update resume queues an id
   * here instead of reaching into the page's local state.
   */
  requestedActivations = $state<string[]>([]);

  /** Threads born in this session, so a first launch can behave differently. */
  #fresh = new Set<string>();

  /**
   * One line to hand the agent the moment its next PTY starts, as the CLI's own
   * initial prompt.
   *
   * A moved thread uses it to say where it landed and what was left behind; a
   * spawned one to say what it is for. In memory and consumed on read: it
   * describes one launch, and replaying it on a later relaunch would re-brief an
   * agent about a move it already knows about.
   */
  #prompts = new Map<string, string>();

  bumpRespawn(threadId: string) {
    this.respawnNonce[threadId] = (this.respawnNonce[threadId] ?? 0) + 1;
  }

  markUnbound(id: string) {
    if (!this.unbound.includes(id)) this.unbound = [...this.unbound, id];
  }

  clearUnbound(id: string) {
    if (this.unbound.includes(id)) this.unbound = this.unbound.filter((x) => x !== id);
  }

  requestActivation(threadId: string) {
    if (this.requestedActivations.includes(threadId)) return;
    this.requestedActivations = [...this.requestedActivations, threadId];
  }

  clearRequestedActivations() {
    if (this.requestedActivations.length > 0) this.requestedActivations = [];
  }

  markFresh(threadId: string) {
    this.#fresh.add(threadId);
  }

  consumeFresh(threadId: string): boolean {
    return this.#fresh.delete(threadId);
  }

  setPendingPrompt(threadId: string, prompt: string) {
    const text = prompt.trim();
    if (text) this.#prompts.set(threadId, text);
  }

  consumePendingPrompt(threadId: string): string | null {
    const prompt = this.#prompts.get(threadId) ?? null;
    this.#prompts.delete(threadId);
    return prompt;
  }

  /** Everything here describes one workspace, so a switch drops all of it. */
  reset() {
    this.#fresh.clear();
    this.#prompts.clear();
    this.respawnNonce = {};
    this.unbound = [];
    this.requestedActivations = [];
  }
}
