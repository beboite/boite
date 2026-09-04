/**
 * The old desktop-diagnostics writer, now a shim over `$lib/shared/log`.
 *
 * It used to be a second log: one `invoke` per line into a mutex-guarded
 * synchronous append, tagged with a free-form `scope`, readable only on a
 * desktop and only from the file that window happened to own. A phone talking
 * to a `boite-server` saw none of it, and "what happened to thread X" needed
 * two answers.
 *
 * There is one road now. Every call below becomes a `$lib/shared/log` record,
 * so it is batched, carries a `target` a filter can match on, lifts a thread
 * id to the top level of the record, and lands in whichever host answered.
 * The thirty call sites keep their shape: `logger.warn(scope, message, data)`
 * still reads the way it did, and [`logTarget`] and [`logFields`] are the whole
 * of the translation.
 *
 * Kept rather than replaced at each call site because the two signatures do not
 * line up: the old one takes a sentence and a loose payload, the new one an
 * event name and named fields. Rewriting thirty call sites into event names is
 * a separate job, and this shim is what makes it optional.
 */

import { log, printUnmirrored, shortStack, type LogFields, type LogLevel } from "$lib/shared/log";

export type { LogLevel };

/**
 * Whether `debug` does anything. Off in a release build.
 *
 * Two callers sit on timers: the status engine ticks every 500ms per agent
 * thread waiting for a session id, and the session monitor every 12s per
 * thread. Batching made a debug line cheap, not free, and a release build has
 * nobody to read one.
 */
const DEBUG_ENABLED = import.meta.env.DEV;

/**
 * The old `scope` as a `target`.
 *
 * A target reads as a module path, and the old scopes are single words picked
 * per call site (`app`, `worktree`, `ipc`). Prefixing them keeps them apart
 * from the targets written against the new API (`webview.console`,
 * `backend.call`) while staying greppable: `target=app.` answers "everything
 * the window said through the old writer".
 *
 * A scope that already reads as a path is left alone, so a call site that has
 * been rewritten does not get prefixed twice.
 */
export function logTarget(scope: string): string {
  const trimmed = scope.trim();
  if (!trimmed) return "app";
  return trimmed.includes(".") ? trimmed : `app.${trimmed}`;
}

/**
 * The old `data` argument as record fields.
 *
 * It was serialized to one JSON string and stored under a single column, which
 * meant a thread id in it was invisible to a filter. Here an object keeps its
 * keys, so `thread`, `turn` and `request` reach the top level of the record,
 * and `threadId` is renamed on the way because that is what the call sites in
 * this app spell it.
 */
export function logFields(data: unknown): LogFields | undefined {
  if (data === undefined || data === null) return undefined;
  if (data instanceof Error) {
    const stack = shortStack(data.stack);
    return {
      kind: data.name,
      error: data.message,
      ...(stack ? { stack } : {}),
    };
  }
  if (typeof data === "string") return data ? { details: data } : undefined;
  if (typeof data !== "object") return { details: String(data) };

  const fields: LogFields = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (key === "threadId") {
      if (typeof value === "string" && value) fields.thread = value;
      continue;
    }
    fields[key] = value;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function send(level: LogLevel, scope: string, message: string, data?: unknown): void {
  // Through `printUnmirrored`, because `captureWebviewErrors` mirrors
  // `console.error` and `console.warn` into the log: a plain `console.warn`
  // here would file this call site twice, once with its target and once under
  // `webview.console` with the sentence flattened.
  printUnmirrored(level, `[${scope}]`, message, data ?? "");
  log[level](logTarget(scope), message, logFields(data));
}

/** The four levels, with the old signature. */
export const logger = {
  debug(scope: string, message: string, data?: unknown) {
    if (!DEBUG_ENABLED) return;
    send("debug", scope, message, data);
  },
  info(scope: string, message: string, data?: unknown) {
    send("info", scope, message, data);
  },
  warn(scope: string, message: string, data?: unknown) {
    send("warn", scope, message, data);
  },
  error(scope: string, message: string, data?: unknown) {
    send("error", scope, message, data);
  },
};
