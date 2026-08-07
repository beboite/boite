import { localBackend } from "$lib/backend";
import { hasTauri } from "$lib/backend/env";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  tsMs: number;
  level: string;
  source: string;
  message: string;
  details: string | null;
}

function serializeDetails(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause ?? undefined,
    });
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Whether `debug` does anything. Off in a release build.
 *
 * Every call is a console write plus an IPC hop into a mutex-guarded synchronous
 * append, and two callers sit on timers: the status engine ticks every 500ms per
 * agent thread waiting for a session id, and the session monitor every 12s per
 * thread. Ungated that was a couple of file writes a second, forever, for a
 * thread that had simply got stuck.
 */
const DEBUG_ENABLED = import.meta.env.DEV;

/**
 * The log is written by this window, about this window, so it never follows the
 * workspace: every call below goes to `localBackend()` rather than `backend()`.
 * Routed through the active transport, a connected boite put the whole thing on
 * `RemoteBackend`'s stub, where an event resolves into nothing: the desktop's own
 * log file stopped recording, `captureWindowErrors` included, for as long as the
 * link was up.
 */
class Logger {
  private send(level: LogLevel, scope: string, message: string, data?: unknown) {
    const tag = `[${scope}]`;
    if (level === "error") console.error(tag, message, data ?? "");
    else if (level === "warn") console.warn(tag, message, data ?? "");
    else if (level === "debug") console.debug(tag, message, data ?? "");
    else console.log(tag, message, data ?? "");

    // The local transport is a `TauriBackend` in every build, so on a PWA there
    // is no IPC behind it and the console line above is the whole log. Gated
    // rather than left to the catch: an invoke that throws on every line is a
    // rejected promise per log call, forever, for a file that cannot exist.
    if (!hasTauri()) return;
    void localBackend()
      .log.event(level, scope, message, data == null ? null : serializeDetails(data))
      .catch(() => {});
  }

  debug(scope: string, message: string, data?: unknown) {
    if (!DEBUG_ENABLED) return;
    this.send("debug", scope, message, data);
  }
  info(scope: string, message: string, data?: unknown) {
    this.send("info", scope, message, data);
  }
  warn(scope: string, message: string, data?: unknown) {
    this.send("warn", scope, message, data);
  }
  error(scope: string, message: string, data?: unknown) {
    this.send("error", scope, message, data);
  }

  read(scope: "current" | "previous" = "current"): Promise<LogEntry[]> {
    return localBackend().log.read(scope);
  }

  clear(): Promise<void> {
    return localBackend().log.clear();
  }

  filePath(): Promise<string> {
    return localBackend().log.filePath();
  }
}

export const logger = new Logger();

/**
 * Sends what the window throws on its own to the same log as everything else.
 *
 * Anything an `await` never caught, a listener that threw, a rejected promise
 * nobody handled: none of it went anywhere. It reached the devtools console,
 * which a packaged desktop app does not open, and then it was gone. The symptom
 * a user reports is "a panel stopped updating"; the cause was one line in a
 * console that no longer exists.
 *
 * Idempotent, because hot reload calls it again and two handlers would write
 * every error twice.
 */
let capturing = false;

export function captureWindowErrors() {
  if (capturing || typeof window === "undefined") return;
  capturing = true;

  // A failure inside the logger itself would come back through here and loop.
  // One record about the loop is worth having; the rest are not.
  let reporting = false;
  const report = (source: string, message: string, data: unknown) => {
    if (reporting) return;
    reporting = true;
    try {
      logger.error(source, message, data);
    } finally {
      reporting = false;
    }
  };

  window.addEventListener("error", (event) => {
    // `error` also fires for an <img> or a <script> that failed to load, and
    // those carry no Error — the element is the target. Worth recording: a
    // missing asset is exactly the kind of thing that renders as nothing.
    if (event.error instanceof Error) {
      report("window.error", event.error.message, event.error);
      return;
    }
    const target = event.target as { tagName?: string; src?: string } | null;
    if (target?.tagName) {
      report("window.resource", `${target.tagName.toLowerCase()} failed to load`, target.src ?? "");
      return;
    }
    report("window.error", event.message || "unknown error", {
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    report(
      "window.rejection",
      reason instanceof Error ? reason.message : String(reason),
      reason,
    );
  });
}
