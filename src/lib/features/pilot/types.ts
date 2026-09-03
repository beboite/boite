/**
 * The JSON of `boite-pilot`, written once.
 *
 * Every shape here is what the crate serializes, not a second model of it: the
 * event union is tagged on `kind` with the dotted names `pilot_events.kind`
 * stores, and an item body is the free object the crate leaves free. Both
 * transports and the store read these, so a field the crate renames is one edit
 * here and a type error everywhere it mattered.
 */

/** What a pilot thread is doing right now. `waiting` outranks `busy`. */
export type PilotStatus = "busy" | "waiting" | "idle";

/** How boite asks the agent to treat tool permissions. */
export type PilotExecMode = "ask" | "edit_alone" | "yolo";

/** What a model switch actually did, so the picker can say so before the click. */
export type PilotSwitchKind = "in_session" | "restart" | "unsupported";

/** The kinds of timeline card a driver can open. `notice` is boite's own. */
export type PilotItemKind =
  | "assistant_text"
  | "reasoning"
  | "tool_call"
  | "command"
  | "file_change"
  | "plan"
  | "user_message"
  | "error"
  | "notice"
  /** `turn` and `request` are projected rows rather than driver items. */
  | "turn"
  | "request";

/** Where a driver gets its credentials. A fastpick route is virtual. */
export type PilotInstance =
  | { type: "native"; config_dir?: string | null }
  | { type: "fastpick"; provider: string; model: string };

/** A model, optionally on another account. Naming one is a restart. */
export interface PilotModelSelection {
  model?: string | null;
  instance?: PilotInstance | null;
}

/** Tokens and cost for a turn, in the units the driver reports. */
export interface PilotUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd?: number | null;
  context_window?: number | null;
}

/** One answer a driver offered, exactly as it offered it. `value` is opaque. */
export interface PilotRequestOption {
  value: string;
  label: string;
}

export type PilotRequestKind = "tool_approval" | "question" | "plan";

/** An open question, mirrored into the approvals dock. */
export interface PilotRequest {
  id: string;
  kind: PilotRequestKind;
  tool_name?: string | null;
  tool_use_id?: string | null;
  input?: unknown;
  title?: string | null;
  description?: string | null;
  options?: PilotRequestOption[];
  suggestions?: unknown;
}

/** How a request ended. */
export type PilotRequestOutcome = "allowed" | "denied" | "cancelled";

/**
 * The answer sent back for an open request.
 *
 * The wire takes the option's own `value`, not this union: `pilot.request.respond`
 * carries `option`, and the machine holding the process maps it against what the
 * driver actually offered. This type is what a caller passes.
 */
export type PilotRequestAnswer = string;

/** One entry of the driver's own event stream. */
export interface PilotItem {
  id: string;
  turn_id?: string | null;
  kind: PilotItemKind;
  body?: Record<string, unknown> | null;
}

/** One row of the projected timeline, as `pilot.items` answers it. */
export interface PilotItemRow {
  id: string;
  threadId: string;
  seq: number;
  turnId: string | null;
  kind: PilotItemKind;
  state: string;
  body: Record<string, unknown> | null;
  createdMs: number;
  updatedMs: number;
}

/** One row of the raw journal, as `pilot.events` answers it. */
export interface PilotEventRow {
  seq: number;
  tsMs: number;
  kind: string;
  payload: unknown;
}

/** Why a session ended. */
export type PilotExitReason =
  | { reason: "stopped" }
  | { reason: "crashed"; code?: number | null }
  | { reason: "killed" };

/** The canonical event set. Fourteen kinds, tagged on `kind`. */
export type PilotEvent =
  | {
      kind: "session.started";
      native_session_id?: string | null;
      model?: string | null;
      slash_commands?: string[];
      extra?: Record<string, unknown>;
    }
  | { kind: "session.exited"; reason: PilotExitReason }
  | { kind: "turn.started"; turn_id: string }
  | { kind: "turn.completed"; turn_id: string; duration_ms: number; usage?: PilotUsage }
  | { kind: "turn.aborted"; turn_id: string; reason?: string | null }
  | { kind: "item.started"; item: PilotItem }
  | { kind: "item.delta"; item_id: string; text: string }
  | { kind: "item.completed"; item: PilotItem }
  | { kind: "request.opened"; request: PilotRequest }
  | { kind: "request.resolved"; request_id: string; outcome: PilotRequestOutcome }
  | { kind: "status.changed"; status: PilotStatus }
  | { kind: "model.changed"; model: string }
  | { kind: "usage.updated"; usage: PilotUsage }
  | { kind: "error"; message: string; turn_id?: string | null };

/** What a driver can do, asked before the interface offers it. */
export interface PilotCapabilities {
  model_switch: PilotSwitchKind;
  rollback: boolean;
  modes: PilotExecMode[];
  interrupt: boolean;
}

/** One driver of the catalog, with the models it ships a list for. */
export interface PilotDriverEntry {
  id: string;
  capabilities: PilotCapabilities | null;
  models: string[];
}

/**
 * One account the picker can open a thread on.
 *
 * A `fastpick` entry is virtual and never stored as anything but its `name`,
 * which is the `fastpick:<provider>:<model>` string the launcher's combo uses.
 */
export interface PilotInstanceEntry {
  name: string;
  driver: string;
  kind: "native" | "fastpick";
  configDir?: string | null;
  provider?: string | null;
  model?: string | null;
  label: string;
}

export interface PilotCatalog {
  drivers: PilotDriverEntry[];
  instances: PilotInstanceEntry[];
}

/** What `pilot.thread.open` answers with. */
export interface PilotOpened {
  thread_id: string;
  native_session_id?: string | null;
  model?: string | null;
  pid?: number | null;
}

/** The diff summary a completed turn item carries. */
export interface PilotTurnDiff {
  files: number;
  additions: number;
  deletions: number;
  fileList: {
    path: string;
    status: string;
    origPath: string | null;
    additions: number;
    deletions: number;
    binary: boolean;
  }[];
}
