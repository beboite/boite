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
  PilotRequestOption,
  PilotRequestOutcome,
  PilotRequestQuestion,
  PilotStatus,
  PilotTurnDiff,
  PilotUsage,
} from "./types";

/**
 * A request as the timeline carries it: what was asked, and how it ended.
 *
 * The outcome is not on the wire type, a driver having no word for it when it
 * asks. It is the row's own, which is why a state rebuilt from rows is the only
 * place it can come from.
 */
export interface PilotStoredRequest extends PilotRequest {
  /** Null while the question is open. */
  outcome: PilotRequestOutcome | null;
}

/** One thread's timeline and everything drawn beside it. */
export interface PilotThreadState {
  /** Every card, in the order the journal minted them. */
  items: PilotItemRow[];
  /** Item id to its position in `items`, so a completion is not a scan. */
  index: Map<string, number>;
  /**
   * Every question this thread has asked, oldest first, answered ones kept.
   *
   * The dock draws a card by looking its request id up here, and it keeps
   * drawing it for the moment between the answer being sent and the approvals
   * row closing. Dropped on resolve, that moment is a card that reads
   * "Loading". `status` is decided on the open ones alone (`openRequests`).
   */
  requests: PilotStoredRequest[];
  status: PilotStatus;
  model: string | null;
  mode: PilotExecMode;
  /** What the last turn cost, or null before one has ended. */
  usage: PilotUsage | null;
  /** The native session the thread resumes on, once the driver named one. */
  nativeSessionId: string | null;
  /**
   * The slash commands the driver declared at init, for the composer's hint.
   *
   * Kept rather than dropped because it is the one list that says what this
   * session understands, and it arrives once: a pane that missed it has no
   * second chance short of a restart. Boite never runs one, so the names go no
   * further than the hint row.
   */
  slashCommands: string[];
  /** Models announced by a live SDK session, which ACP discovers after auth. */
  availableModels: string[];
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
    slashCommands: [],
    availableModels: [],
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
  // Rebuilt whole rather than appended to: a page of rows may update a request
  // this state already carries, and the row is what says how it ended.
  into.requests = requestsOf(into.items);
  return into;
}

/** The open questions, which are the ones a status is decided on. */
export function openRequests(state: PilotThreadState): PilotStoredRequest[] {
  return state.requests.filter((request) => request.outcome === null);
}

/**
 * The questions a page of rows carries, in the order they were asked.
 *
 * A request row's body is the request as the driver sent it, and an answer adds
 * `outcome` to that body rather than replacing it (`boite_core::pilot`). So the
 * tool name, the input and the options the driver offered all survive a reload,
 * which is what the dock draws its card out of: it looks a request id up in
 * `requests` and has nothing else to fall back on.
 */
function requestsOf(items: PilotItemRow[]): PilotStoredRequest[] {
  const requests: PilotStoredRequest[] = [];
  for (const row of items) {
    if (row.kind !== "request") continue;
    const request = storedRequest(row);
    if (request) requests.push(request);
  }
  return requests;
}

function storedRequest(row: PilotItemRow): PilotStoredRequest | null {
  const body = row.body;
  if (!body) return null;
  const id = text(body.id) ?? text(body.requestId);
  if (!id) return null;
  return {
    id,
    kind: (text(body.kind) as PilotRequest["kind"] | null) ?? "tool_approval",
    tool_name: text(body.tool_name),
    tool_use_id: text(body.tool_use_id),
    input: body.input,
    title: text(body.title),
    description: text(body.description),
    options: options(body.options),
    questions: questions(body.questions),
    suggestions: body.suggestions,
    outcome: outcomeOf(row),
  };
}

/** The verdict on the row, or null while the question is still open. */
function outcomeOf(row: PilotItemRow): PilotRequestOutcome | null {
  const word = row.state === "open" ? text(row.body?.outcome) : row.state;
  if (word === "allowed" || word === "denied" || word === "cancelled") return word;
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function options(value: unknown): PilotRequestOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (option): option is PilotRequestOption =>
      !!option &&
      typeof (option as PilotRequestOption).value === "string" &&
      typeof (option as PilotRequestOption).label === "string",
  );
}

function questions(value: unknown): PilotRequestQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (question): question is PilotRequestQuestion =>
      !!question &&
      typeof (question as PilotRequestQuestion).id === "string" &&
      typeof (question as PilotRequestQuestion).header === "string" &&
      typeof (question as PilotRequestQuestion).question === "string",
  );
}

/** Applies one event. Answers whether anything a pane draws changed. */
export function reduce(state: PilotThreadState, event: PilotEvent): boolean {
  switch (event.kind) {
    case "session.started": {
      state.nativeSessionId = event.native_session_id ?? state.nativeSessionId;
      if (event.model) state.model = event.model;
      // A restart declares them again; an empty list is a driver that has none
      // and must not wipe what the previous init said.
      if (event.slash_commands && event.slash_commands.length > 0) {
        state.slashCommands = [...event.slash_commands];
      }
      const availableModels = event.extra?.availableModels;
      if (Array.isArray(availableModels)) {
        state.availableModels = availableModels.filter(
          (entry): entry is string => typeof entry === "string" && entry.length > 0,
        );
      }
      return true;
    }
    case "session.exited": {
      state.status = "idle";
      // A process that went takes its open questions with it: nothing is left
      // to answer them, and a card that cannot be answered must not stay up.
      // What was answered stays: it is history, and the dock may still be
      // drawing the card the answer closed.
      state.requests = state.requests.filter((request) => request.outcome !== null);
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
      // The completion is what the item *ended* with, not everything it was:
      // claude names a tool and its input on `item.started` and sends the
      // result alone on `item.completed`, so a body that replaced rather than
      // merged turned "Bash git status" into a card saying nothing. The
      // completion still wins field by field, which is what makes a corrected
      // value stick.
      const at = state.index.get(event.item.id);
      const previous = at === undefined ? null : state.items[at].body;
      const streamed = previous?.text;
      const row = itemRow(state, event.item, "completed");
      row.body = { ...previous, ...row.body };
      if (!row.body?.text && typeof streamed === "string" && streamed.length > 0) {
        row.body = { ...row.body, text: streamed };
      }
      put(state, row);
      return true;
    }
    case "request.opened": {
      state.requests = [...state.requests, { ...event.request, outcome: null }];
      put(state, requestRow(state, event.request, "open"));
      state.status = "waiting";
      return true;
    }
    case "request.resolved": {
      // Marked, not dropped. The dock finds its card by request id, and a
      // request that leaves the list between the answer and the approvals row
      // closing takes the card with it and leaves the word "Loading".
      state.requests = state.requests.map((request) =>
        request.id === event.request_id ? { ...request, outcome: event.outcome } : request,
      );
      const id = `request:${event.request_id}`;
      const body = existingBody(state, id);
      put(state, {
        ...blank(state, id, "request", event.outcome),
        body: { ...body, requestId: event.request_id, outcome: event.outcome },
      });
      // Back to work, unless another question is still up.
      state.status = openRequests(state).length > 0 ? "waiting" : "busy";
      return true;
    }
    case "status.changed": {
      if (state.status === event.status) return false;
      state.status = event.status;
      return true;
    }
    case "model.changed": {
      if (state.model === event.model) return false;
      // The first one of a session is the driver naming what it opened on, not
      // a switch: a notice there would open every thread with a line saying
      // nothing happened.
      const switched = state.model !== null;
      state.model = event.model;
      if (switched) {
        put(state, {
          ...blank(state, `notice:model:${state.cursor + 1}`, "notice", "completed"),
          body: { model: event.model },
        });
      }
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
