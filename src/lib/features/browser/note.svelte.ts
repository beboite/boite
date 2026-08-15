/**
 * Whether the user has read what a browser pane is.
 *
 * Deliberately not a setting: nobody would go looking for it in a panel, and
 * what it holds is one note that stops coming back once it has been read. It
 * lives out here rather than in the component so that every pane agrees about
 * it, the ones already open and the ones an agent opens next.
 *
 * Device-scoped, like everything else describing the glass rather than the
 * machine the threads run on.
 */
const KEY = "boite.browserNoteRead";

function stored(): boolean {
  // Module init runs wherever this is imported, prerender included, and there
  // is no storage there. Unread is the right answer for a window that has none.
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

class BrowserNote {
  read = $state(stored());

  markRead() {
    this.read = true;
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // A note shown once more is not worth failing a pane over.
    }
  }

  /** Reopened from the pane's own button, so nothing is written back. */
  reopen() {
    this.read = false;
  }

  toggle() {
    if (this.read) this.reopen();
    else this.markRead();
  }
}

export const browserNote = new BrowserNote();
