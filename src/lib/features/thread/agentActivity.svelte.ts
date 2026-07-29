import { TransientMark } from "$lib/shared/utils/transientMark.svelte";

/**
 * When an agent reaches into Boite itself.
 *
 * Everything else an agent does happens inside its terminal, where you can read
 * it. The MCP endpoint is the one thing that does not: `todo_add`,
 * `thread_move`, `worktree_branch`, `project_create` and `thread_spawn` change
 * the app from the outside, and until now the only trace was the result
 * appearing somewhere with nothing to say who did it or when.
 *
 * So a call marks two things. The thread that made it, because that is the
 * answer to "which of these agents just did that", and the surface it touched,
 * because that is the answer to "why did this list change". Both fade on their
 * own; this is a notification, not a state.
 */

// Long enough to be caught out of the corner of an eye, short enough that an
// agent making a dozen calls in a row does not leave the whole window pulsing.
const PULSE_MS = 1600;

/** Surfaces an agent's call can be about. A closed set so a component can ask
    for its own without inventing a key nothing writes. */
export type McpSurface = "todo" | "worktree" | "project" | "thread";

const SURFACES = new Set<string>(["todo", "worktree", "project", "thread"]);

const threads = new TransientMark(PULSE_MS);
const surfaces = new TransientMark(PULSE_MS);

/**
 * A verb was called. `threadId` is the caller, when it is known: the endpoint is
 * scoped per thread through the `x-boite-thread` header, but an agent registered
 * from a credentials file presents a project instead, and an unattributed call
 * still has to show that something happened.
 */
export function noteMcpCall(surface: McpSurface, threadId?: string | null) {
  surfaces.mark(surface);
  if (threadId) threads.mark(threadId);
}

export const mcpPulse = {
  /** Whether this thread made a call just now. Pane ids of thread panes are
      thread ids, so a pane header can pass its own id straight in. */
  has(threadId: string): boolean {
    return threads.has(threadId);
  },
  /** Whether this surface was just written to by an agent. */
  surface(surface: McpSurface): boolean {
    return surfaces.has(surface);
  },
  reset() {
    threads.reset();
    surfaces.reset();
  },
};

/**
 * Listen for the desktop endpoint's activity events.
 *
 * Desktop only, and that asymmetry is on purpose rather than an oversight: on a
 * remote boite the same calls arrive as control events (`todos.changed` and
 * friends) which carry no caller, so that path marks the surface and leaves the
 * thread unattributed. Adding a caller to the server protocol is a four-edit
 * change across `backend/types.ts`, both implementations and `rpc.rs`, and it
 * is worth doing once the pulse has earned its place.
 */
export function watchAgentActivity(): () => void {
  let stop: (() => void) | null = null;
  let cancelled = false;
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ surface?: string; threadId?: string }>(
        "boite://agent-activity",
        (event) => {
          const surface = event.payload?.surface;
          if (!surface || !SURFACES.has(surface)) return;
          noteMcpCall(surface as McpSurface, event.payload?.threadId || null);
        },
      ),
    )
    .then((un) => {
      if (cancelled) un();
      else stop = un;
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    stop?.();
  };
}
