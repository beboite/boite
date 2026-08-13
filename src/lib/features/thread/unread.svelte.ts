/**
 * Which threads did something while nobody was looking.
 *
 * The dot on a row says what a thread is doing now. What the sidebar could
 * never say is what happened while you were somewhere else, which is the
 * question a window with six agents in it is actually asked: one of them
 * finished twenty minutes ago and the row has looked exactly the same ever
 * since. The finish flash answers it for six seconds and then it is gone.
 *
 * So a turn that ends off screen leaves a mark, and the mark is cleared by
 * looking. Nothing about it is persisted: it describes this session in front of
 * this person, and a mark restored on the next launch would be a claim about a
 * turn nobody was there for.
 *
 * Whether a thread is on screen cannot be asked from here. The pane store
 * imports the app store, so anything below it importing the pane store closes a
 * cycle; the window registers a probe instead, and until it does nothing counts
 * as watched, which errs towards a mark rather than towards silence.
 */

const marks = $state<Record<string, number>>({});

let watching: (threadId: string) => boolean = () => false;

/** The window says which threads the user can see. Returns a cleanup. */
export function setUnreadWatcher(probe: (threadId: string) => boolean): () => void {
  watching = probe;
  return () => {
    watching = () => false;
  };
}

/**
 * Something worth knowing happened to this thread.
 *
 * A no-op while it is on screen: the user watched it happen, so a mark would
 * only be something to dismiss.
 */
export function noteUnread(threadId: string, at = Date.now()): void {
  if (watching(threadId)) return;
  marks[threadId] = at;
}

/** Looking at it is reading it. */
export function markThreadRead(threadId: string): void {
  if (marks[threadId] === undefined) return;
  delete marks[threadId];
}

export function isThreadUnread(threadId: string): boolean {
  return marks[threadId] !== undefined;
}

/** When the unseen thing happened, or null if there is nothing unseen. */
export function unreadSince(threadId: string): number | null {
  return marks[threadId] ?? null;
}

/** How many of these threads carry a mark. For a project's own summary. */
export function unreadCount(threadIds: readonly string[]): number {
  let n = 0;
  for (const id of threadIds) if (marks[id] !== undefined) n++;
  return n;
}

export function forgetUnread(threadId: string): void {
  delete marks[threadId];
}

/** A workspace switch replaces every thread; no mark describes the new ones. */
export function resetUnread(): void {
  for (const id of Object.keys(marks)) delete marks[id];
}
