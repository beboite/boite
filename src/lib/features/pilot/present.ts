/**
 * What a timeline row looks like, decided without a DOM.
 *
 * The component draws; this answers the questions that have a right answer, so
 * they are tests rather than a scroll and a squint. Three of them are the ones
 * the first version of the pane got wrong.
 *
 * **A row with nothing in it is not a card.** `item.started` mints a row before
 * the driver has said anything, and the driver's own echo of a user line often
 * carries no body at all. Drawn anyway, both come out as an empty rounded bar
 * of surface colour with a border and no text, which is what the first
 * screenshot of the pane is full of. [`hasBody`] is the one gate, and it is
 * asked per kind because "empty" means something different for a tool call than
 * for a paragraph.
 *
 * **A tool call is named by its input, not by its JSON.** A bash call is its
 * command and a file call is its path; everything else is the first line of
 * whatever the driver sent. That is one line the reader can scan, against the
 * three-line `{ "command": ... }` block a raw dump gives.
 *
 * **A caret belongs to the row that is still growing**, never to the last row
 * of a finished turn, or a thread reopened cold blinks at its own history.
 */

import type { PilotItemRow } from "./types";

/** The tool families worth their own icon. Everything else is `other`. */
export type PilotToolKind = "bash" | "read" | "write" | "edit" | "search" | "other";

/** How a tool call ended, or that it has not. */
export type PilotRunState = "running" | "done" | "denied" | "failed";

const BASH = /^(bash|shell|run|exec|terminal|command|powershell)/i;
const READ = /^(read|cat|open|view|notebookread|fetch)/i;
const WRITE = /^(write|create|notebookedit|multiedit_new)/i;
const EDIT = /^(edit|patch|apply|replace|multiedit|update)/i;
const SEARCH = /^(search|grep|glob|find|ls|list|ripgrep)/i;

/** Which icon a tool name earns, from the name alone. */
export function toolKind(name: string): PilotToolKind {
  const trimmed = name.trim();
  if (BASH.test(trimmed)) return "bash";
  if (SEARCH.test(trimmed)) return "search";
  if (EDIT.test(trimmed)) return "edit";
  if (WRITE.test(trimmed)) return "write";
  if (READ.test(trimmed)) return "read";
  return "other";
}

/** The tool a row names, however the driver spelled the key. */
export function toolName(body: Record<string, unknown> | null | undefined): string {
  for (const key of ["name", "tool", "tool_name", "toolName"]) {
    const value = body?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * The one line that says what a tool was asked to do.
 *
 * The command for a shell call and the path for a file call, both read off the
 * input object the driver sent; a driver that sent a bare string gets its first
 * line. Truncated here rather than by CSS so the value is the same on a phone
 * and in a test, and collapsed to single spaces because a command written over
 * three lines is still one command.
 */
export function toolSummary(
  body: Record<string, unknown> | null | undefined,
  limit = 160,
): string {
  const input = body?.input ?? body?.command ?? body?.args ?? null;
  const direct = pickString(input, ["command", "cmd", "script"]);
  if (direct) return clamp(direct, limit);
  const path = pickString(input, ["file_path", "path", "file", "filePath", "pattern", "query"]);
  if (path) return clamp(path, limit);
  if (typeof input === "string") return clamp(input, limit);
  const own = pickString(body, ["file_path", "path", "file", "command", "summary"]);
  if (own) return clamp(own, limit);
  return input === null || input === undefined ? "" : clamp(json(input), limit);
}

/** How a tool call is going, off the row's state and whatever the body says. */
export function runState(row: PilotItemRow): PilotRunState {
  const outcome = row.body?.outcome;
  if (outcome === "denied") return "denied";
  if (outcome === "cancelled") return "failed";
  const errored =
    row.body?.is_error === true ||
    row.body?.isError === true ||
    row.state === "failed" ||
    row.state === "error";
  if (errored) return "failed";
  return row.state === "started" || row.state === "running" ? "running" : "done";
}

/**
 * Whether this row is worth a card at all.
 *
 * The defect it removes: a bordered box with nothing inside it, between two
 * real cards. Whitespace counts as nothing, because a driver that streamed a
 * newline and stopped said nothing.
 */
export function hasBody(row: PilotItemRow): boolean {
  switch (row.kind) {
    case "assistant_text":
    case "user_message":
    case "reasoning":
      return textOf(row).trim().length > 0;
    case "notice":
      // A notice boite wrote itself carries a field rather than a sentence, so
      // the key stays a literal at the call site that draws it.
      return textOf(row).trim().length > 0 || typeof row.body?.model === "string";
    case "plan":
      return textOf(row).trim().length > 0 || hasKeys(row.body);
    case "tool_call":
    case "command":
      return (
        toolName(row.body).length > 0 ||
        toolSummary(row.body).length > 0 ||
        outputOf(row.body).length > 0
      );
    case "file_change":
      return filePath(row).length > 0;
    case "error":
      return String(row.body?.message ?? "").trim().length > 0;
    case "request":
    case "turn":
      // A request is always drawable and a turn row is the footer, which says
      // something ("running") even before it has a duration.
      return true;
    default:
      return hasKeys(row.body);
  }
}

/** The rows worth drawing, in the order they came. */
export function drawable(rows: readonly PilotItemRow[]): PilotItemRow[] {
  return rows.filter(hasBody);
}

/** The file a change card names, however the driver spelled the key. */
export function filePath(row: PilotItemRow): string {
  return pickString(row.body, ["path", "file", "file_path", "filePath"]) ?? "";
}

/** A row's text, or the empty string when it carries none. */
export function textOf(row: PilotItemRow): string {
  const value = row.body?.text;
  return typeof value === "string" ? value : "";
}

/** Whatever a tool printed, as text. */
export function outputOf(body: Record<string, unknown> | null | undefined): string {
  const value = body?.output ?? body?.result ?? body?.content;
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : json(value);
}

/** The tail of an output, which is the half that says how it went. */
export function tailOf(text: string, lines = 12): string {
  if (!text) return "";
  const rows = text.split("\n");
  return rows.slice(Math.max(0, rows.length - lines)).join("\n");
}

/**
 * Whether this row draws the streaming caret.
 *
 * Only the assistant text of a turn that is still running, and only while the
 * thread is busy: a reload lands rows in state `started` that nothing will ever
 * complete, and a caret on those would blink at a conversation that ended
 * yesterday.
 */
export function caretOn(row: PilotItemRow, busy: boolean): boolean {
  if (!busy) return false;
  if (row.kind !== "assistant_text" && row.kind !== "reasoning") return false;
  return row.state === "started" || row.state === "running";
}

/**
 * Whether the "jump to latest" pill is up.
 *
 * Not simply "the user scrolled": an empty thread has no latest to jump to, and
 * the pill over a thread of one card is an affordance pointing at itself.
 */
export function jumpVisible(stick: boolean, rows: number): boolean {
  return !stick && rows > 1;
}

/** The eight characters that tell one session from another. */
export function shortSession(id: string | null): string | null {
  return id ? id.slice(0, 8) : null;
}

/**
 * The model name as a chip wears it.
 *
 * A route id carries its provider (`anthropic/claude-fable-5-1`) and a chip has
 * room for one of the two; the sidebar's tint already says which family is
 * answering, so the segment after the last slash is the half worth the space.
 * Never shortened past a name somebody could confuse with another: this trims a
 * prefix and nothing else.
 */
export function shortModel(model: string | null): string | null {
  if (!model) return null;
  const last = model.split("/").pop()?.trim();
  return last && last.length > 0 ? last : model;
}

function pickString(
  value: unknown,
  keys: readonly string[],
): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = record[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return null;
}

function hasKeys(body: Record<string, unknown> | null | undefined): boolean {
  return !!body && Object.keys(body).length > 0;
}

function clamp(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
