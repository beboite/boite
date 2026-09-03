/**
 * What one pilot event does to a thread's timeline, with no Svelte in it.
 *
 * The store owns the reactivity and the frame budget; this owns the reduction,
 * which is the half worth testing. A client arriving mid-turn reads items by
 * cursor and then subscribes, so the same functions have to build a state out
 * of stored rows and out of live events and land on the same thing. That is why
 * [`fromRows`] and [`reduce`] write into one shape rather than two.
 *
 * Mutating on purpose. A turn of two hundred deltas would otherwise copy the
 * item array two hundred times, and the store already knows when to hand the
 * result to `$state`.
 */

import type {
  PilotEvent,
  PilotExecMode,
  PilotItem,
  PilotItemRow,
  PilotRequest,
  PilotStatus,
  PilotTurnDiff,
  PilotUsage,
} from "./types";

/** One thread's timeline and everything drawn beside it. */
export interface PilotThreadState {
  /** Every card, in the order the journal minted them. */
  items: PilotItemRow[];
  /** Item id to its position in `items`, so a completion is not a scan. */
  index: Map<string, number>;
  /** The requests still waiting for an answer, oldest first. */
  requests: PilotRequest[];
  status: PilotStatus;
  model: string | null;
  mode: PilotExecMode;
  /** What the last turn cost, or null before one has ended. */
  usage: PilotUsage | null;
  /** The native session the thread resumes on, once the driver named one. */
  nativeSessionId: string | null;
  /** The highest sequence read, which is what a reconnect pages from. */
  cursor: number;
}

export function emptyState(): PilotThreadState {
  return {
    items: [],
    index: new Map(),
    requests: [],
    status: "idle",
    model: null,
    mode: "ask",
    usage: null,
    nativeSessionId: null,
    cursor: 0,
  };
}

/**
 * The state a cursor read of `pilot.items` leaves behind.
 *
 * A turn still running when the rows were read is left running: its item is
 * there in state `running`, and the `turn.completed` that arrives on the
 * subscription updates it in place. An open request is one whose row still
 * reads `open`, which is how a client that reloaded mid-approval still draws
 * the card the dock is drawing.
 */
export function fromRows(rows: PilotItemRow[], into = emptyState()): PilotThreadState {
  for (const row of rows) put(into, row);
  return into;
}

/** Applies one event. Answers whether anything a pane draws changed. */
export function reduce(state: PilotThreadState, event: PilotEvent): boolean {
  switch (event.kind) {
    case "session.started": {
      state.nativeSessionId = event.native_session_id ?? state.nativeSessionId;
      if (event.model) state.model = event.model;
      return true;
    }
    case "session.exited": {
      state.status = "idle";
      // A process that went takes its open questions with it: nothing is left
      // to answer them, and a card that cannot be answered must not stay up.
      state.requests = [];
      return true;
    }
    case "turn.started": {
      put(state, turnRow(state, event.turn_id, "running", { turnId: event.turn_id }));
      state.status = "busy";
      return true;
    }
    case "turn.completed": {
      const body = existingBody(state, `turn:${event.turn_id}`);
      put(
        state,
        turnRow(state, event.turn_id, "completed", {
          ...body,
          turnId: event.turn_id,
          durationMs: event.duration_ms,
          usage: event.usage,
        }),
      );
      if (event.usage) state.usage = event.usage;
      state.status = "idle";
      return true;
    }
    case "turn.aborted": {
      const body = existingBody(state, `turn:${event.turn_id}`);
      put(
        state,
        turnRow(state, event.turn_id, "aborted", {
          ...body,
          turnId: event.turn_id,
          reason: event.reason ?? null,
        }),
      );
      state.status = "idle";
      return true;
    }
    case "item.started": {
      put(state, itemRow(state, event.item, "started"));
      return true;
    }
    // The one event a frame is spent on rather than a write. The store joins
    // them per item and calls this once, so a two hundred token turn is one
    // paint per frame and not one per token.
    case "item.delta": {
      const at = state.index.get(event.item_id);
      if (at === undefined) return false;
      const row = state.items[at];
      const text = typeof row.body?.text === "string" ? row.body.text : "";
      row.body = { ...row.body, text: text + event.text };
      return true;
    }
    case "item.completed": {
      // A driver that streamed its text and completed the item with an empty
      // body means what the deltas carried, not an empty card.
      const at = state.index.get(event.item.id);
      const streamed = at === undefined ? undefined : state.items[at].body?.text;
      const row = itemRow(state, event.item, "completed");
      if (!row.body?.text && typeof streamed === "string" && streamed.length > 0) {
        row.body = { ...row.body, text: streamed };
      }
      put(state, row);
      return true;
    }
    case "request.opened": {
      state.requests = [...state.requests, event.request];
      put(state, requestRow(state, event.request, "open"));
      state.status = "waiting";
      return true;
    }
    case "request.resolved": {
      state.requests = state.requests.filter((request) => request.id !== event.request_id);
      const id = `request:${event.request_id}`;
      const body = existingBody(state, id);
      put(state, {
        ...blank(state, id, "request", event.outcome),
        body: { ...body, requestId: event.request_id, outcome: event.outcome },
      });
      // Back to work, unless another question is still up.
      state.status = state.requests.length > 0 ? "waiting" : "busy";
      return true;
    }
    case "status.changed": {
      if (state.status === event.status) return false;
      state.status = event.status;
      return true;
    }
    case "model.changed": {
      if (state.model === event.model) return false;
      state.model = event.model;
      return true;
    }
    case "usage.updated": {
      state.usage = event.usage;
      return true;
    }
    case "error": {
      put(state, {
        ...blank(state, `error-${state.cursor + 1}`, "error", "completed"),
        turnId: event.turn_id ?? null,
        body: { message: event.message },
      });
      return true;
    }
    default:
      return false;
  }
}

/** What a completed turn changed, or null before the diff was written. */
export function turnDiff(state: PilotThreadState, turnId: string): PilotTurnDiff | null {
  const at = state.index.get(`turn:${turnId}`);
  if (at === undefined) return null;
  const diff = state.items[at].body?.diff;
  return (diff as PilotTurnDiff | undefined) ?? null;
}

/** Inserts a row, or replaces the one already carrying its id. */
function put(state: PilotThreadState, row: PilotItemRow): void {
  const at = state.index.get(row.id);
  if (at === undefined) {
    state.index.set(row.id, state.items.length);
    state.items.push(row);
  } else {
    // The position is kept: a card that finishes does not jump to the bottom
    // of a timeline somebody is reading.
    state.items[at] = { ...state.items[at], ...row, createdMs: state.items[at].createdMs };
  }
  if (row.seq > state.cursor) state.cursor = row.seq;
}

function existingBody(state: PilotThreadState, id: string): Record<string, unknown> {
  const at = state.index.get(id);
  return at === undefined ? {} : { ...state.items[at].body };
}

function blank(
  state: PilotThreadState,
  id: string,
  kind: PilotItemRow["kind"],
  itemState: string,
): PilotItemRow {
  const now = Date.now();
  return {
    id,
    threadId: "",
    seq: state.cursor + 1,
    turnId: null,
    kind,
    state: itemState,
    body: null,
    createdMs: now,
    updatedMs: now,
  };
}

function turnRow(
  state: PilotThreadState,
  turnId: string,
  itemState: string,
  body: Record<string, unknown>,
): PilotItemRow {
  return {
    ...blank(state, `turn:${turnId}`, "turn", itemState),
    turnId,
    body,
  };
}

function itemRow(state: PilotThreadState, item: PilotItem, itemState: string): PilotItemRow {
  return {
    ...blank(state, item.id, item.kind, itemState),
    turnId: item.turn_id ?? null,
    body: (item.body as Record<string, unknown> | null) ?? null,
  };
}

function requestRow(
  state: PilotThreadState,
  request: PilotRequest,
  itemState: string,
): PilotItemRow {
  return {
    ...blank(state, `request:${request.id}`, "request", itemState),
    body: request as unknown as Record<string, unknown>,
  };
}
