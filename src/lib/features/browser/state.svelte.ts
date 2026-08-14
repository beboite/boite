/**
 * What the container knows about the page in a browser pane, which is not much.
 *
 * The pane is a sandboxed cross-origin `<iframe>`, so the app cannot read the
 * document, query a selector in it or synthesise a click on anything inside it.
 * The `load` event is the whole of what crosses that boundary, and this is where
 * it is kept so the window can report it (`app/screen.svelte.ts`) and an agent
 * can ask about it (`browser_status`, `browser_wait_for`).
 *
 * Deliberately not where `drivenBy` lives. That mark belongs to the pane and
 * rides on `PaneContent`; this is about a mounted frame, and it is dropped when
 * the frame goes.
 */

/**
 * `stalled` is not `failed`.
 *
 * A frame that never fires `load` is either slow or refused by
 * `X-Frame-Options`, and the two are indistinguishable from outside: the error
 * is delivered to the console of a document the app is not allowed to touch. The
 * name says what was observed rather than guessing which it was.
 */
export type PageState = "loading" | "loaded" | "stalled";

class BrowserPanes {
  private states = $state<Record<string, PageState>>({});
  private nonces = $state<Record<string, number>>({});

  pageOf(paneId: string): PageState | null {
    return this.states[paneId] ?? null;
  }

  note(paneId: string, state: PageState) {
    if (this.states[paneId] === state) return;
    this.states[paneId] = state;
  }

  /**
   * Dropped when the frame unmounts, which is what keeps this from growing for
   * the length of a session. A pane redrawn after a group switch mounts a fresh
   * frame that fires `load` again, so nothing is lost by forgetting.
   */
  forget(paneId: string) {
    delete this.states[paneId];
    delete this.nonces[paneId];
  }

  /**
   * What a remount is counted by.
   *
   * Reloading is remounting: an iframe pointed at the address it is already on
   * does not re-fetch, and `contentWindow.location.reload()` is a cross-origin
   * call the browser refuses. Held here rather than in the component because an
   * agent asks for this from outside it.
   */
  nonceOf(paneId: string): number {
    return this.nonces[paneId] ?? 0;
  }

  reload(paneId: string) {
    this.nonces[paneId] = this.nonceOf(paneId) + 1;
  }
}

export const browserPanes = new BrowserPanes();
