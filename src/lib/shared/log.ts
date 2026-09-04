/**
 * The webview's half of the log.
 *
 * `boite_core::log` owns the format, the files and the ring; the browser has
 * none of those, so a record produced here goes over the bus (`logs.write`) and
 * lands in whichever host answered. That is the whole reason this module
 * exists: on a phone talking to a `boite-server`, "what happened to thread X"
 * has to include what the window did, and a `console.log` nobody keeps is not
 * an answer.
 *
 * `services/logger.svelte.ts` is a shim over this module and nothing else, so
 * the thirty call sites written against the old signature take this road too.
 * There is one webview log path.
 *
 * Two things it is careful about, because both have bitten this codebase:
 *
 * - **Batched, never one call per line.** A busy second writes hundreds, and an
 *   IPC hop per line was measured as a couple of file writes a second forever
 *   for a thread that had simply got stuck. 500 ms or fifty records, whichever
 *   comes first, and the queue is flushed on `pagehide` so the last thing a
 *   window said before it went away is the thing that is kept.
 * - **It never logs about itself.** A flush that fails is dropped. Reporting it
 *   would put the report in the batch that just failed, and the next flush
 *   would carry the report of the flush before it.
 */

import { backend } from "$lib/backend";
import type { LogRecordInput } from "$lib/backend/types";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Free-form context. `thread`, `turn` and `request` are lifted to the top level. */
export interface LogFields {
  thread?: string;
  turn?: string;
  request?: string;
  [key: string]: unknown;
}

/** The window between a first queued record and the flush that carries it. */
export const FLUSH_INTERVAL_MS = 500;

/** A batch this size goes at once rather than waiting out the window. */
export const MAX_BATCH = 50;

/**
 * How many records may wait at most.
 *
 * A host that is down rejects every flush, and the queue would otherwise grow
 * for as long as the window is open. The oldest go: what happened just now is
 * what a reader is asking about.
 */
const MAX_QUEUE = 500;

/**
 * How many stack frames of an unhandled error are worth keeping.
 *
 * The host redacts user directories, so a full stack is safe: it is just
 * useless. Every frame past the third is framework, and a webview stack is
 * twenty `file:///` URLs of bundled chunks. The first three name the code that
 * actually threw.
 */
const STACK_FRAMES = 3;

let queue: LogRecordInput[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let device: string | null = null;
/** A flush is in flight; a second one would reorder the two batches. */
let flushing = false;

/**
 * Names the device these records came from.
 *
 * The server stamps `logs.write` with the pairing id it authenticated, so this
 * is only ever a hint, and the host's answer wins. It is here for the desktop,
 * which authenticates nobody and would otherwise file every webview record
 * under no device at all.
 */
export function identify(id: string | null): void {
  device = id && id.trim() ? id.trim() : null;
}

function enqueue(level: LogLevel, target: string, msg: string, fields?: LogFields): void {
  const record: LogRecordInput = {
    ts: Date.now(),
    level,
    target,
    msg,
    // Forced by the host too. Sent so a record read straight back out of the
    // queue in a test says what it is.
    ...(device ? { device } : {}),
  };
  if (fields) {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (key === "thread" || key === "turn" || key === "request") {
        if (typeof value === "string" && value) record[key] = value;
        continue;
      }
      rest[key] = value;
    }
    if (Object.keys(rest).length > 0) record.fields = rest;
  }
  queue.push(record);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (queue.length >= MAX_BATCH) {
    void flush();
    return;
  }
  if (timer === null) timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
}

/**
 * Sends what is queued. Safe to call at any time, and called on `pagehide`.
 *
 * The queue is taken before the await, so records produced while the write is
 * in flight belong to the next batch rather than being lost to the `length = 0`
 * of a naive implementation.
 */
export async function flush(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0 || flushing) return;
  const batch = queue;
  queue = [];
  flushing = true;
  try {
    await backend().logs.write(batch);
  } catch {
    // Dropped on purpose. See the module comment: a line about a failed flush
    // rides the next flush, which fails for the same reason.
  } finally {
    flushing = false;
    // Records that arrived during the write, or the ones that were dropped:
    // either way there is something waiting and nothing armed to carry it.
    if (queue.length > 0 && timer === null) {
      timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
    }
  }
}

/**
 * The four levels.
 *
 * `target` reads as a module path (`ui.pane`, `backend.call`), `msg` as an
 * event name (`pane.opened`) rather than a sentence: `text=` matches on it, and
 * a sentence with a path in it matches nothing twice.
 */
export const log = {
  debug: (target: string, msg: string, fields?: LogFields) =>
    enqueue("debug", target, msg, fields),
  info: (target: string, msg: string, fields?: LogFields) => enqueue("info", target, msg, fields),
  warn: (target: string, msg: string, fields?: LogFields) => enqueue("warn", target, msg, fields),
  error: (target: string, msg: string, fields?: LogFields) =>
    enqueue("error", target, msg, fields),
  flush,
  identify,
};

/** The first few frames of a stack, one string, or nothing at all. */
export function shortStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (frames.length === 0) return undefined;
  return frames.slice(0, STACK_FRAMES).join(" | ");
}

function describe(value: unknown): { msg: string; fields: LogFields } {
  if (value instanceof Error) {
    const stack = shortStack(value.stack);
    return {
      msg: value.message || value.name,
      fields: { kind: value.name, ...(stack ? { stack } : {}) },
    };
  }
  return { msg: String(value), fields: {} };
}

/**
 * Sends what the window throws on its own, and mirrors the console.
 *
 * Both halves are the same complaint: a packaged desktop app opens no devtools,
 * and a phone has none to open. What used to reach a console and stop there now
 * reaches the same file as everything else, on the same clock.
 *
 * The console is **mirrored**, not replaced. Replacing it costs the devtools
 * their source location, which is the one thing a console line is good for.
 *
 * Idempotent: hot reload calls it again, and two handlers would double every
 * record.
 */
let installed = false;

export function captureWebviewErrors(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // A failure inside the log path comes back through here. One record about the
  // loop is worth having; the rest are not.
  let reporting = false;
  const report = (msg: string, fields: LogFields) => {
    if (reporting) return;
    reporting = true;
    try {
      log.error("webview.unhandled", msg, fields);
    } finally {
      reporting = false;
    }
  };

  window.addEventListener(
    "error",
    (event) => {
      if (event.error instanceof Error) {
        const { msg, fields } = describe(event.error);
        report(msg, fields);
        return;
      }
      // `error` also fires for an <img> or a <script> that failed to load, and
      // those carry no Error: the element is the target. Worth a record, a
      // missing asset being exactly the kind of thing that renders as nothing.
      const target = event.target as { tagName?: string; src?: string } | null;
      if (target?.tagName) {
        report("resource.failed", { tag: target.tagName.toLowerCase() });
        return;
      }
      report(event.message || "unknown error", {
        line: event.lineno,
        column: event.colno,
      });
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    const { msg, fields } = describe(event.reason);
    report(msg, { ...fields, kind: fields.kind ?? "rejection" });
  });

  // The last batch of a window that is going away. `pagehide` rather than
  // `beforeunload`: a phone backgrounding a PWA fires the first and may never
  // fire the second.
  window.addEventListener("pagehide", () => void flush());

  mirrorConsole();
}

/** What the console had before the mirror wrapped it, so a reset can put it back. */
const consoleBefore = new Map<"error" | "warn", (...args: unknown[]) => void>();

function mirrorConsole(): void {
  if (typeof console === "undefined") return;
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    consoleBefore.set(level, console[level]);
    console[level] = (...args: unknown[]) => {
      original(...args);
      // A throw in here would come out of the caller's `console.error`, which
      // is the one place code never expects to be interrupted.
      try {
        log[level]("webview.console", summarize(args));
      } catch {
        /* the console is not the place to complain about the log */
      }
    };
  }
}

/**
 * One console line the mirror does not see.
 *
 * For code that writes its own record and wants a devtools line as well:
 * printing through the wrapped console would have the mirror write a second
 * record about the line, so the same call site would land in the file twice,
 * once with its own target and once under `webview.console`.
 *
 * Only `error` and `warn` are wrapped, so the other two are the console's own.
 */
export function printUnmirrored(level: LogLevel, ...args: unknown[]): void {
  if (typeof console === "undefined") return;
  if (level === "error" || level === "warn") {
    const original = consoleBefore.get(level);
    if (original) original.apply(console, args);
    else console[level](...args);
    return;
  }
  if (level === "debug") console.debug(...args);
  else console.log(...args);
}

/** One line out of whatever was handed to the console. */
function summarize(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.message || arg.name;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ")
    .slice(0, 2000);
}

/**
 * Test seam: forget what is queued and what is armed.
 *
 * The console is put back rather than left wrapped, because `installed` going
 * false again means the next `captureWebviewErrors` wraps a second time, and a
 * suite of ten tests would then mirror every console line ten times.
 */
export function resetLogForTest(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  queue = [];
  flushing = false;
  device = null;
  installed = false;
  for (const [level, original] of consoleBefore) console[level] = original;
  consoleBefore.clear();
}
