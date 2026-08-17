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

import { untrack } from "svelte";

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

  /**
   * **A writer, and it reads nothing.** That is the fix, not a simplification.
   *
   * This used to skip an identical write by comparing with the current value,
   * and `BrowserPane` notes `loading` from the same effect that arms the stall
   * timer — so that read subscribed the effect to its own output. The frame's
   * `load` wrote `loaded`, the effect re-ran, put `settled` back to false and
   * wrote `loading` again, and four seconds later the timer it had just
   * re-armed wrote `stalled` and started the round over. A page that was up
   * said `loading` for as long as the pane was open, the overlay never came
   * off, and every `browser_wait_for` timed out on it.
   *
   * Nothing is lost by dropping the guard: a `$state` proxy already ignores a
   * write of the value it holds, so the same-state case still notifies nobody.
   */
  note(paneId: string, state: PageState) {
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
    // Untracked for the same reason as `note`: this is called from a button and
    // from an agent request today, and the day it is called from an effect that
    // effect would re-arm itself for ever.
    this.nonces[paneId] = untrack(() => this.nonceOf(paneId)) + 1;
  }
}

export const browserPanes = new BrowserPanes();
