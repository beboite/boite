import { app } from "$lib/app/store.svelte";
import { backend } from "$lib/backend/active.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";
import type { DispatchLine } from "$lib/backend/types";
import type { Thread } from "$lib/types";

/**
 * The device half of dispatch: the queue lives on the boite, the typing
 * happens here, in the window that owns the target PTY.
 *
 * `boite_core::reply` forbids typing bytes from the bus on purpose, so a
 * dispatch is a row until a device drains it. This file is that device. The
 * policy it applies is a mirror of `boite_core::orchestrator::dispatch::flush`
 * — same guards, same order, same reason words — because the desktop and the
 * headless server must not drift on when a line is allowed to land.
 *
 * Ownership is the sink: every mounted Terminal registers one, and a window
 * without the target's terminal leaves the row queued for the window that has
 * it. Settling is first-writer-wins on the boite, so two windows racing the
 * same line deliver it once.
 */

/** What a Terminal hands over: a dim notice line, and typed-then-submitted text. */
export interface DispatchSink {
  notice(line: string): void;
  type(text: string): void;
}

const sinks = new Map<string, DispatchSink>();

/** A mounted Terminal owning a live PTY. Registering looks at the queue. */
export function registerDispatchSink(threadId: string, sink: DispatchSink): () => void {
  sinks.set(threadId, sink);
  scheduleFlush(0);
  return () => {
    if (sinks.get(threadId) === sink) sinks.delete(threadId);
  };
}

function enabled(): boolean {
  return settings.state.experimentOrchestrator && !!backend().conduct;
}

/**
 * The device-side verdict, mirroring the core table. `waiting` is the status
 * engine's word for a dialog or a permission prompt being up, which is guard
 * two: a dispatch landing in a permission prompt would answer the question in
 * the orchestrator's voice.
 */
function decide(
  thread: Thread,
  line: DispatchLine,
): "type" | "hold" | { state: string; reason: string } {
  if (thread.status === "waiting") return { state: "refused", reason: "WAITING_ON_USER" };
  if (thread.role) return { state: "refused", reason: "NO_ORCHESTRATOR_TO_ORCHESTRATOR" };
  if (thread.acceptDispatch === false) return { state: "refused", reason: "MUTED" };
  const owner = app.threads.find(
    (th) =>
      th.role === "orchestrator" &&
      th.orchestratorScope === thread.projectId &&
      !th.settledAt,
  );
  if (owner && owner.id !== line.fromThreadId)
    return { state: "refused", reason: "SCOPE_TAKEN" };
  if (thread.status !== "ready" && thread.status !== "idle")
    return line.mode === "now" ? { state: "refused", reason: "TARGET_BUSY" } : "hold";
  return "type";
}

let flushing = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** While a queued line waits on a busy target, look again in a few seconds. */
function scheduleFlush(delayMs = 4000) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushDispatches();
  }, delayMs);
}

/** Drain the queue and act on every line whose target terminal is here. */
export async function flushDispatches(): Promise<void> {
  if (!enabled()) return;
  const conduct = backend().conduct;
  if (!conduct) return;
  if (flushing) {
    again = true;
    return;
  }
  flushing = true;
  try {
    const lines = await conduct.drainDispatches({});
    let held = false;
    for (const line of lines) {
      const thread = app.threadById(line.toThreadId);
      const sink = sinks.get(line.toThreadId);
      // Not this device's PTY: leave the row queued for the window that has it.
      if (!thread?.ptyId || !sink) continue;
      const verdict = decide(thread, line);
      if (verdict === "hold") {
        held = true;
        continue;
      }
      if (verdict === "type") {
        // Settle first: if this window dies mid-type the line is marked
        // delivered rather than typed twice by the next drain. First writer
        // wins, so a row another device already settled is skipped.
        const { settled } = await conduct.settleDispatch({
          dispatchId: line.id,
          state: "delivered",
        });
        if (!settled) continue;
        sink.notice(t("dispatch.notice"));
        // Any newline would split the prompt; the submit is the one \r below.
        const oneLine = line.text.replace(/\s*[\r\n]+\s*/g, " ").trim();
        sink.type(oneLine + "\r");
      } else {
        await conduct.settleDispatch({
          dispatchId: line.id,
          state: verdict.state,
          reason: verdict.reason,
        });
      }
    }
    if (held) scheduleFlush();
  } catch (err) {
    logger.warn("dispatch", "flush failed", String(err));
  } finally {
    flushing = false;
    if (again) {
      again = false;
      void flushDispatches();
    }
  }
}

/** The boite put a thread away (`thread.dismiss`); mirror the row here. */
export function onThreadDismissed(threadId: string) {
  const thread = app.threadById(threadId);
  if (thread && !thread.settledAt) thread.settledAt = Date.now();
}

/** The user's mute switch, one thread. `Grant::Local` on the bus: no agent rearms it. */
export async function setThreadAcceptDispatch(threadId: string, accept: boolean) {
  const conduct = backend().conduct;
  if (!conduct) return;
  try {
    await conduct.acceptDispatch({ threadId, accept });
    const thread = app.threadById(threadId);
    if (thread) thread.acceptDispatch = accept;
  } catch (err) {
    logger.error("dispatch", "acceptDispatch failed", String(err));
  }
}

/** Mute every worker of one project. Orchestrators are refused the queue anyway. */
export async function muteProjectDispatches(projectId: string) {
  const rows = app.threads.filter(
    (th) =>
      th.projectId === projectId &&
      !th.role &&
      !th.settledAt &&
      th.acceptDispatch !== false,
  );
  for (const row of rows) await setThreadAcceptDispatch(row.id, false);
}

/**
 * The home header's « take everything back »: mute every live worker, which
 * on the boite also drops every queued line (a mute that lets queued lines
 * land later is not a mute).
 */
export async function takeEverythingBack() {
  const rows = app.threads.filter(
    (th) => !th.role && !th.settledAt && th.acceptDispatch !== false,
  );
  for (const row of rows) await setThreadAcceptDispatch(row.id, false);
}

/**
 * Desktop wiring: Tauri events wake the flush, exactly like the todo and
 * approval stores. On the web there is no Tauri bus and `control-events.ts`
 * calls `flushDispatches` directly.
 */
export function watchDispatches(): () => void {
  const stops: (() => void)[] = [];
  let cancelled = false;
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      Promise.all([
        listen("boite://dispatch-queued", () => void flushDispatches()),
        listen<{ threadId: string }>("boite://thread-dismissed", (e) =>
          onThreadDismissed(e.payload.threadId),
        ),
      ]),
    )
    .then((uns) => {
      if (cancelled) uns.forEach((un) => un());
      else stops.push(...uns);
    })
    .catch(() => {});
  // Whatever queued while no window was up: one look at boot, which is also
  // the TTL sweep for lines nobody was there to type.
  scheduleFlush(0);
  return () => {
    cancelled = true;
    stops.forEach((un) => un());
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
