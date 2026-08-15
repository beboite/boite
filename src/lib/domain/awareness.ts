/**
 * What a thread means to somebody who is not looking at it.
 *
 * The window's copy of `boite_core::awareness`. It does **not** re-derive a
 * status: it takes the one the engine or the server already decided and answers
 * what it means, which is the line that keeps this from becoming the second
 * status detector `ARCHITECTURE.md` opens by warning about.
 *
 * The status-to-phase table is not written out here either. It is
 * `awareness.json`, imported below and asserted against the Rust arms by
 * `boite-core`'s own tests, so a phase added on one side and forgotten on the
 * other fails `cargo test`.
 *
 * The strings are the difference between the two copies, and deliberately so. A
 * notification is composed by whoever sends it, with no window and no locale;
 * this side has both, so a phase is turned into words through `messages.ts` at
 * the moment it is drawn.
 */

import type { ThreadStatus } from "$lib/types";
import type { MessageKey } from "$lib/i18n/messages";
import table from "./awareness.json";

export type AwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

const PHASES = table.phases as Record<ThreadStatus, AwarenessPhase>;

/**
 * The phase, from a status somebody else decided.
 *
 * Two things override the table, and both are the machine disagreeing with the
 * row rather than a second opinion about it. Same order as the Rust: an open
 * approval wins over the staleness check, because an approval is a row that
 * outlives the terminal that asked for it.
 */
export function phaseOf(
  status: ThreadStatus,
  hasProcess: boolean,
  hasApproval = false,
): AwarenessPhase {
  if (status === "waiting" && hasApproval) return "waiting_for_approval";
  if (!hasProcess && (status === "running" || status === "waiting")) return "stale";
  return PHASES[status] ?? "stale";
}

/** Nothing moves until a person does something. */
export function needsAHuman(phase: AwarenessPhase): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

const HEADLINES: Record<AwarenessPhase, MessageKey> = {
  starting: "awareness.headline.starting",
  running: "awareness.headline.running",
  waiting_for_approval: "awareness.headline.waitingForApproval",
  waiting_for_input: "awareness.headline.waitingForInput",
  completed: "awareness.headline.completed",
  failed: "awareness.headline.failed",
  stale: "awareness.headline.stale",
};

const DETAILS: Record<AwarenessPhase, MessageKey> = {
  starting: "awareness.detail.starting",
  running: "awareness.detail.running",
  waiting_for_approval: "awareness.detail.waitingForApproval",
  waiting_for_input: "awareness.detail.waitingForInput",
  completed: "awareness.detail.completed",
  failed: "awareness.detail.failed",
  stale: "awareness.detail.stale",
};

/**
 * The two message keys a phase draws with.
 *
 * Spelled out as two records rather than built into a key, so a message the
 * dictionary does not have cannot be produced. Same rule as `ApprovalDock`.
 */
export function phraseKeys(phase: AwarenessPhase): {
  headline: MessageKey;
  detail: MessageKey;
} {
  return { headline: HEADLINES[phase], detail: DETAILS[phase] };
}

/** One keystroke, from the closed set `boite_core::reply` accepts. */
export type ThreadReply =
  | "yes"
  | "no"
  | "enter"
  | "escape"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9";

/**
 * Every token the two backends parse, in the order `TOKENS` lists them.
 *
 * Read off the shared table, so this array and `boite_core::reply::TOKENS` are
 * one list. `awareness.test.ts` pins it against the union above, which is the
 * third corner: a token added to the JSON and not to the type would otherwise
 * typecheck as `string`.
 */
export const THREAD_REPLIES = table.replies as readonly ThreadReply[];

/**
 * Where a thread lives, as a path and query.
 *
 * One format, two resolutions, and neither host can build the other's. The PWA
 * resolves it against the origin it was served from; the desktop has no origin
 * at all and parses the query on the window it already has. `boite_core`'s
 * `awareness::link` writes exactly this, and a server that knows its public
 * address prefixes it on the way into a webhook.
 */
export function threadLink(threadId: string, projectId?: string | null): string {
  const query = new URLSearchParams({ thread: threadId });
  if (projectId) query.set("project", projectId);
  return `/?${query.toString()}`;
}

/**
 * The thread a link names, or null.
 *
 * Takes the query string rather than reading `location` itself: this file is
 * `lib/domain`, so it has to be answerable without a window.
 */
export function parseThreadLink(
  search: string,
): { threadId: string; projectId: string | null } | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const threadId = params.get("thread");
  if (!threadId) return null;
  return { threadId, projectId: params.get("project") };
}
