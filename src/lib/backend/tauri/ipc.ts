import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { log } from "$lib/shared/log";

/**
 * The door every Tauri command goes through, so a failure at the boundary is
 * written down somewhere.
 *
 * A rejected `invoke` used to reach whichever caller was awaiting it and stop
 * there. Most of them catch, turn it into a toast or an empty list, and the
 * sentence Rust wrote is gone. What is left afterwards is a user saying a panel
 * is empty and nothing anywhere saying why, which is the exact shape of problem
 * an agent cannot solve without asking a human what they see.
 *
 * Wrapped here rather than at each of the hundred call sites: the facades in
 * `rpc.ts`, `pty.ts` and `db.ts` import this one instead of the real one, and
 * the next command somebody adds is covered by having been written at all.
 *
 * It lands on the timeline through the log: `workspace_timeline` merges the
 * `warn` and `error` lines of this app's log into the same answer as the
 * journal, the todo rows and the thread rows. So "the git panel went blank at
 * 14:02" and "an agent reserved a branch at 14:02" are finally on one clock.
 *
 * Frontend `info` lines stay off that clock, and that is a decision rather than
 * a gap: they are written on the way through working code, several per second
 * while a workspace is loading, and merging them would bury the three sources
 * that are actually about the workspace under a trace of the app running
 * normally.
 */

/** How long the same failure stays quiet after being written down once. */
const QUIET_FOR_MS = 5_000;

/**
 * Reporting one of these would come straight back through this door. The two
 * file commands are here because a log panel that cannot read the file polls,
 * and each attempt would append the reason it failed to the file it cannot
 * read.
 */
const OWN_DOOR = new Set([
  "clear_app_log",
  "log_file_path",
  // The bus's five. `logs_write` above all: a batch that fails would be
  // reported through the batcher that just failed, and the next flush would
  // carry the report of the flush before it.
  "logs_write",
  "logs_tail",
  "logs_query",
  "logs_level",
  "logs_subscribe",
]);

const lastSaid = new Map<string, number>();

/**
 * Whether this failure is worth a line right now.
 *
 * A command that fails once fails again: a panel on a timer, a poll waiting for
 * something to come up, a path that is not there yet. Written every time, the
 * log would be one message repeated until the disk filled, and the merge that
 * feeds the timeline would show nothing else.
 */
function worthSaying(key: string, now: number): boolean {
  const seen = lastSaid.get(key);
  if (seen !== undefined && now - seen < QUIET_FOR_MS) return false;
  // Keyed by command and message, so a path in the reason makes its own entry.
  // Bounded rather than pruned one by one: this is a cache of what was said
  // recently, and forgetting all of it costs one extra line.
  if (lastSaid.size > 200) lastSaid.clear();
  lastSaid.set(key, now);
  return true;
}

function say(cmd: string, err: unknown) {
  if (OWN_DOOR.has(cmd)) return;
  const message = err instanceof Error ? err.message : String(err);
  if (!worthSaying(`${cmd}:${message}`, Date.now())) return;
  // One line, on the bus's log, where a reader filters it by method rather
  // than by matching a sentence.
  log.warn("backend.call", "call.refused", { method: cmd, reason: message });
}

/**
 * Calls a Tauri command, and leaves a line behind when it refuses.
 *
 * The rejection is re-thrown untouched. Every caller already handles it, and a
 * wrapper that swallowed one would turn a failure into an undefined further
 * down, which is worse than the silence this exists to fix.
 */
export async function invoke<T>(
  cmd: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args, options);
  } catch (err) {
    say(cmd, err);
    throw err;
  }
}
