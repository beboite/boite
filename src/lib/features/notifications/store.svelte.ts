import { uuid } from "$lib/shared/utils/uuid";

/**
 * `warning` is not a weaker error: an error is something that failed, a warning
 * is something that worked differently than asked. A thread that starts in the
 * project folder because the checkout was busy has not failed, and reporting it
 * in red would teach the user to ignore red.
 */
export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  /**
   * The specifics under the message: the files that caused it, the branch it
   * happened on. Kept apart from the message rather than glued onto it with a
   * colon, because the message is what deduplicates a repeating card and the
   * specifics are what change between two of them.
   */
  detail?: string;
  durationMs: number | null;
  // Bumped when the same message is raised again; the component restarts its
  // dismiss timer on a change instead of a second card appearing.
  resetKey: number;
}

interface AddOptions {
  kind?: ToastKind;
  durationMs?: number | null;
  detail?: string;
}

// Nothing dismisses a toast the user never saw, and the panels raise theirs
// from polls that repeat forever. Without a ceiling a repeatedly failing
// refresh grows this array for the whole session.
const MAX_TOASTS = 5;

/**
 * How long a card stays up when the caller does not say.
 *
 * The floor is per kind, because a card is not read the same way: a success is
 * recognised, an error is read, a warning is read and then acted on. Every one
 * of them used to expire on a fixed count that assumed six words — long enough
 * for "Copié", and gone before a sentence naming three files had been found on
 * screen, let alone read.
 */
const DWELL_FLOOR: Record<ToastKind, number> = {
  success: 3000,
  info: 4500,
  warning: 8000,
  error: 10000,
};

/** Unhurried reading, in words per minute: this is glanced at, not studied. */
const READING_WPM = 130;

/** Nothing sits on screen longer than this on its own. */
const DWELL_CEILING = 20000;

function dwellFor(kind: ToastKind, message: string, detail?: string): number {
  const words = `${message} ${detail ?? ""}`.trim().split(/\s+/).length;
  const reading = (words / READING_WPM) * 60_000;
  // Time to notice the card at all, then time to read it.
  return Math.min(DWELL_CEILING, Math.max(DWELL_FLOOR[kind], 1200 + reading));
}

/**
 * Every toast raised this session, newest last. Development builds only.
 *
 * A toast is how this app reports a failure, and it dismisses itself after a
 * few seconds — so an agent driving the app through the MCP bridge, which is
 * how Boite is developed, arrives after the only account of what went wrong has
 * gone. Read through `window.__boite.toasts()`.
 *
 * Never rendered and never read by the app itself: `vite build` sets
 * `import.meta.env.DEV` false, the push below compiles away, and this stays an
 * empty array nothing appends to.
 */
const raised: { at: number; kind: ToastKind; message: string }[] = [];
const MAX_RAISED = 100;

export function raisedToasts() {
  return raised.map((t) => ({ ...t }));
}

class NotificationsStore {
  toasts = $state<Toast[]>([]);

  private push(message: string, opts: AddOptions = {}): string {
    if (import.meta.env.DEV) {
      raised.push({ at: Date.now(), kind: opts.kind ?? "info", message });
      if (raised.length > MAX_RAISED) raised.shift();
    }
    // A git or explorer poll that keeps failing raises the same text every
    // 10s. Refresh the card that is already up rather than stacking a new one.
    const existing = this.toasts.find((t) => t.message === message);
    if (existing) {
      if (opts.kind) existing.kind = opts.kind;
      if (opts.durationMs !== undefined) existing.durationMs = opts.durationMs;
      // The newer specifics win: the same failure on a second file is the same
      // card saying what it is about now, not the first one repeated.
      existing.detail = opts.detail;
      existing.resetKey++;
      return existing.id;
    }

    const id = uuid();
    this.toasts.push({
      id,
      kind: opts.kind ?? "info",
      message,
      detail: opts.detail,
      // Already resolved by `raise`: undefined only reaches here from a caller
      // that went through `push` itself, and a readable default beats a guess.
      durationMs: opts.durationMs === undefined ? dwellFor(opts.kind ?? "info", message) : opts.durationMs,
      resetKey: 0,
    });
    if (this.toasts.length > MAX_TOASTS) {
      this.toasts.splice(0, this.toasts.length - MAX_TOASTS);
    }
    return id;
  }

  // Leaving the duration out is "however long this one takes to read"; `null`
  // is a card that waits to be dismissed by hand, which is what the comment
  // here promised while `?? 3000` quietly gave it three seconds like the rest.
  info(message: string, durationMs?: number | null, detail?: string) {
    return this.raise("info", message, durationMs, detail);
  }
  success(message: string, durationMs?: number | null, detail?: string) {
    return this.raise("success", message, durationMs, detail);
  }
  warning(message: string, durationMs?: number | null, detail?: string) {
    return this.raise("warning", message, durationMs, detail);
  }
  error(message: string, durationMs?: number | null, detail?: string) {
    return this.raise("error", message, durationMs, detail);
  }

  private raise(
    kind: ToastKind,
    message: string,
    durationMs: number | null | undefined,
    detail?: string,
  ) {
    return this.push(message, {
      kind,
      durationMs: durationMs === undefined ? dwellFor(kind, message, detail) : durationMs,
      detail,
    });
  }

  // Splice, not a filtered reassignment: replacing the array invalidates every
  // consumer of the list, including the other cards' own render.
  dismiss(id: string) {
    const i = this.toasts.findIndex((t) => t.id === id);
    if (i !== -1) this.toasts.splice(i, 1);
  }
}

export const notifications = new NotificationsStore();
