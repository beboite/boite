/**
 * The app's half of the pane driver.
 *
 * The other half is `src-tauri/scripts/pane-driver.js`, injected by the
 * webview into every frame it creates. This side holds the iframe elements by
 * pane, posts one question at a time into the frame that owns it, and matches
 * the answers back by id. postMessage is the entire channel: the frame stays
 * sandboxed and cross-origin, and nothing here ever reads its document.
 *
 * Every answer is validated by *source*, not by content: a reply only counts
 * when it arrives from the `contentWindow` of the very frame that was asked.
 * The page can post whatever it likes at us; a message from anywhere else is
 * dropped unread.
 *
 * Timeouts resolve to `{ error }` rather than rejecting: what rides back to
 * the agent is a sentence either way, and the distinction between "the page
 * said no" and "the page said nothing" is in the sentence.
 */

type Answer = Record<string, unknown>;

interface Waiting {
  paneId: string;
  resolve: (answer: Answer) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long a page has to answer before the agent is told it did not. */
const ANSWER_MS = 3500;

class PaneDriver {
  private frames = new Map<string, HTMLIFrameElement>();
  private waiting = new Map<number, Waiting>();
  private nextId = 1;
  private listening = false;

  /** BrowserPane hands its frame over on mount and takes it back on unmount. */
  attach(paneId: string, frame: HTMLIFrameElement) {
    this.frames.set(paneId, frame);
  }

  detach(paneId: string) {
    this.frames.delete(paneId);
  }

  /** Where the pane's frame sits in the viewport, for the screenshot crop. */
  frameBox(paneId: string): DOMRect | null {
    const el = this.frames.get(paneId);
    return el ? el.getBoundingClientRect() : null;
  }

  /**
   * One question into the pane's frame, one answer or a timeout sentence out.
   */
  ask(paneId: string, verb: string, args: Record<string, unknown>): Promise<Answer> {
    this.listen();
    const frame = this.frames.get(paneId);
    const into = frame?.contentWindow;
    if (!into) {
      return Promise.resolve({
        error: "that pane is not drawn right now; bring it on screen and ask again",
      });
    }
    const id = this.nextId++;
    return new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({
          error:
            "the page did not answer; it may still be loading, run no scripts, or predate the driver. browser_wait_for first, then ask again",
        });
      }, ANSWER_MS);
      this.waiting.set(id, { paneId, resolve, timer });
      // targetOrigin "*" is right here: the frame's real origin is unknowable
      // from outside (it may have navigated, it may be opaque), and nothing
      // in the question is a secret worth keeping from the page it is about.
      into.postMessage({ boite: "drive", id, verb, args }, "*");
    });
  }

  private listen() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("message", (event) => {
      const m = event.data as { boite?: string; id?: number } | null;
      if (!m || m.boite !== "driver" || typeof m.id !== "number") return;
      const entry = this.waiting.get(m.id);
      if (!entry) return;
      // The one check that matters: the answer must come from the window of
      // the frame that was asked. Any other source is a page guessing ids.
      const asked = this.frames.get(entry.paneId)?.contentWindow;
      if (!asked || event.source !== asked) return;
      this.waiting.delete(m.id);
      clearTimeout(entry.timer);
      const { boite: _tag, id: _id, ...answer } = m as Record<string, unknown>;
      entry.resolve(answer as Answer);
    });
  }
}

export const paneDriver = new PaneDriver();
