/**
 * One card somebody asked to be taken to.
 *
 * The panel already knows how to have one card open (`openId`), so this is only
 * the request: something outside the panel — the palette's content search — names
 * a todo, and the panel opens it and scrolls to it the next time it draws.
 *
 * Cleared by the panel once it has acted, so a second request for the same id
 * still lands. A request the panel never sees (the project was switched, the
 * column was closed) is overwritten by the next one rather than replayed.
 */
class TodoFocus {
  requested = $state<string | null>(null);

  request(todoId: string) {
    this.requested = todoId;
  }

  take(): string | null {
    const id = this.requested;
    if (id !== null) this.requested = null;
    return id;
  }
}

export const todoFocus = new TodoFocus();
