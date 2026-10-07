import type { MessagePart } from '@boite/contracts';
import { planOf } from './plan';
import { fill, strings } from './strings';
import { describeTool, fileName, partialSummaryOf, summaryOf, type ToolFamily } from './tool-summary';

/*
 * How a message's activity reads in the timeline: a run of calls and
 * reasoning with no answer between them folds under one sentence ("Ran 3
 * commands, read 2 files"), each call is a plain line rather than a card, and a
 * command reads as what it runs rather than as the shell that wraps it.
 */

export type ToolPart = Extract<MessagePart, { type: 'tool' }>;

/** A reasoning step: it folds into the activity around it like a call. */
export type ThinkingStep = Extract<MessagePart, { type: 'thinking' }>;

/** What an activity run holds: the calls and the reasoning between them. */
export type ActivityPart = ToolPart | ThinkingStep;

/** One entry of a message's parts as the timeline draws it: a part on its own, or a run of activity. */
export type PartRun = { kind: 'part'; index: number } | { kind: 'activity'; indices: number[] };

/**
 * A call that produced a diff, a page or an image stands alone: what it made is
 * the point. So does an edit whose input spells out its change, the diff
 * `ToolCard` draws when the driver attaches none. Failed attempts stay in the run.
 */
function standsAlone(part: ToolPart): boolean {
  if ((part.documents?.length ?? 0) > 0) return true;
  if (typeof part.inputText === 'string' || part.status === 'error' || part.status === 'denied') return false;
  return describeTool(part.name, part.input).change !== null;
}

/**
 * Whether a reasoning step has anything to show: its words, a running clock, or
 * at least a whole second spent. An empty step that took no time is noise.
 */
export function thinkingShown(part: ThinkingStep, live: boolean): boolean {
  if (live || part.text.trim() !== '') return true;
  return part.startedAt !== undefined && part.finishedAt != null && part.finishedAt - part.startedAt >= 1000;
}

/** Whether a run draws anything: any call does, reasoning only when `thinkingShown`. */
export function activityShown(parts: readonly ActivityPart[], thinkingLive: boolean): boolean {
  return parts.some((part, index) => part.type === 'tool' || thinkingShown(part, thinkingLive && index === parts.length - 1));
}

/**
 * Splits the parts into runs. Calls and reasoning with nothing written between
 * them are one run, drawn as one line that opens on its steps; blank text does
 * not break it. Answer text, a call that made something and a proposed plan
 * each keep their own place in the timeline. `from` and `to` read a stretch of
 * the message only, its runs indexed as in the whole message: what one row of
 * a long message draws, and what a memory notice cuts a message into.
 */
export function partRuns(parts: readonly MessagePart[], from = 0, to = parts.length): PartRun[] {
  const runs: PartRun[] = [];
  let open: { kind: 'activity'; indices: number[] } | null = null;
  for (let index = from; index < to; index += 1) {
    const part = parts[index];
    if (!part) continue;
    // Blank text is skipped unless it ends the message itself: that one carries the caret.
    if (part.type === 'text' && part.text.trim() === '' && index < parts.length - 1) continue;
    const folds = part.type === 'thinking' || (part.type === 'tool' && planOf(part.name, part.input) === null);
    if (!folds) {
      open = null;
      runs.push({ kind: 'part', index });
    } else if (part.type === 'tool' && standsAlone(part)) {
      open = null;
      runs.push({ kind: 'activity', indices: [index] });
    } else if (open) {
      open.indices.push(index);
    } else {
      open = { kind: 'activity', indices: [index] };
      runs.push(open);
    }
  }
  return runs;
}

/** The runs' keys: a run keeps its first part, so a lone step that gains a neighbour stays the same block. */
export function runKey(run: PartRun): string {
  return run.kind === 'part' ? `part-${run.index}` : `activity-${run.indices[0] ?? 0}`;
}

/** First start to last finish over the steps that recorded both, or null when none did. */
export function runSpan(parts: readonly ActivityPart[]): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const part of parts) {
    if (part.startedAt == null) continue;
    start = Math.min(start, part.startedAt);
    if (part.finishedAt != null) end = Math.max(end, part.finishedAt);
  }
  return Number.isFinite(start) ? { start, end: Number.isFinite(end) ? end : start } : null;
}

/** The shells an agent wraps its commands in, and the flag the command follows. */
const WRAPPERS: { names: string[]; flag: RegExp }[] = [
  { names: ['pwsh', 'powershell'], flag: /(?:^|\s)-(?:c|command)\s+/i },
  { names: ['cmd'], flag: /(?:^|\s)\/c\s+/i },
  { names: ['bash', 'sh', 'zsh'], flag: /(?:^|\s)-l?c\s+/i }
];

/** The first word of a command, quotes and all, and what follows it. */
function splitFirst(command: string): { first: string; rest: string } {
  const trimmed = command.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const close = trimmed.indexOf(quote, 1);
    if (close > 0) return { first: trimmed.slice(1, close), rest: trimmed.slice(close + 1).trim() };
  }
  const space = trimmed.search(/\s/);
  return space < 0 ? { first: trimmed, rest: '' } : { first: trimmed.slice(0, space), rest: trimmed.slice(space).trim() };
}

/** `C:\Program Files\PowerShell\7\pwsh.exe` reads `pwsh`. */
function baseName(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  return name.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

function stripQuotes(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length > 1 && value.endsWith(first)) return value.slice(1, -1);
  return value;
}

/**
 * The command a shell wrapper runs: `"C:\...\pwsh.exe" -Command 'git status'`
 * reads `git status`. Anything that is not a known wrapper comes back as sent.
 */
export function unwrapCommand(command: string): string {
  let current = command.trim();
  // A wrapper can wrap a wrapper; two levels is what agents do.
  for (let depth = 0; depth < 2; depth++) {
    const { first, rest } = splitFirst(current);
    const wrapper = WRAPPERS.find((entry) => entry.names.includes(baseName(first).toLowerCase()));
    const match = wrapper?.flag.exec(rest);
    if (!wrapper || !match) break;
    const inner = rest.slice(match.index + match[0].length).trim();
    const opening = inner[0];
    if ((opening === '"' || opening === "'") && !inner.endsWith(opening)) break;
    const unwrapped = stripQuotes(inner).trim();
    if (!unwrapped) break;
    current = unwrapped;
  }
  return current;
}

/** Steps a reader skips to find what runs: moving somewhere, setting a variable. */
const PREAMBLE = /^(cd|set-location|pushd|sl|export|set)\b|^\$env:|^\w+=\S*$/i;

/** The program a command runs, `git` for `cd src && git status`, empty when there is none to name. */
export function programOf(command: string): string {
  const segments = unwrapCommand(command).split(/&&|\|\||;|\|/).map((segment) => segment.trim()).filter(Boolean);
  const segment = segments.find((entry) => !PREAMBLE.test(entry)) ?? segments[0] ?? '';
  // Leading `FOO=bar` assignments and PowerShell's `&` call operator come before the program.
  const words = segment.replace(/^&\s+/, '').replace(/^(\w+=\S*\s+)+/, '');
  const { first } = splitFirst(words);
  return first ? baseName(first) : '';
}

function commandText(part: ToolPart): string {
  if (typeof part.inputText === 'string') return unwrapCommand(partialSummaryOf(part.inputText));
  const { subject } = describeTool(part.name, part.input);
  return unwrapCommand(subject);
}

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

/** What a sentence names for a call: the file, the pattern, the host, or the tool itself. */
function subjectOf(part: ToolPart, family: ToolFamily): string {
  const raw = typeof part.inputText === 'string' ? partialSummaryOf(part.inputText) : describeTool(part.name, part.input).subject;
  switch (family) {
    case 'read': case 'edit': case 'write': return raw ? fileName(raw) : '';
    case 'fetch': return raw ? hostOf(raw) : '';
    case 'other': return part.name;
    default: return raw;
  }
}

export function familyOf(part: ToolPart): ToolFamily {
  return describeTool(part.name, part.input).family;
}

export interface ToolLine {
  /** What the line says. */
  text: string;
  /** A command is set in the code face: it is what ran, word for word. */
  mono: boolean;
  /** The whole of it, for the tooltip when the line is cut. */
  title: string;
}

/**
 * A call's own line: a command as the command it ran, anything else as a short
 * sentence ("Read app.ts"). A running call says it in the present.
 */
export function toolLine(part: ToolPart): ToolLine {
  const family = familyOf(part);
  if (family === 'command') {
    const text = commandText(part);
    return { text, mono: true, title: text };
  }
  const subject = subjectOf(part, family);
  const full = typeof part.inputText === 'string' ? partialSummaryOf(part.inputText) : summaryOf(part.input);
  if (family === 'other') {
    const detail = full && full !== part.name ? ` ${full}` : '';
    return { text: `${part.name}${detail}`, mono: false, title: `${part.name}${detail}` };
  }
  const forms = part.status === 'running' ? strings.chat.toolLive : strings.chat.toolDone;
  const text = subject ? fill(forms[family], { subject }) : strings.chat.toolBare[family];
  return { text, mono: false, title: full || text };
}

/** What a running run says on its folded line: "Running git", "Reading app.ts". */
export function liveLabel(part: ToolPart): string {
  const family = familyOf(part);
  if (typeof part.inputText === 'string') return family === 'command'
    ? fill(strings.chat.toolLive.command, { subject: strings.chat.toolCommandWord })
    : strings.chat.toolBare[family];
  if (family === 'command') {
    const program = programOf(commandText(part));
    return fill(strings.chat.toolLive.command, { subject: program || strings.chat.toolCommandWord });
  }
  const subject = subjectOf(part, family);
  return subject ? fill(strings.chat.toolLive[family], { subject }) : strings.chat.toolBare[family];
}

type SummaryKind = Exclude<ToolFamily, 'write'> | 'attempt';

/**
 * The folded line of a finished run: one clause per kind of call, in the order
 * the kinds first ran, counted the way a person would. Edits and writes are
 * one clause that counts files, so three edits to one file changed one file.
 */
export function runSummary(parts: readonly ToolPart[]): string {
  const order: SummaryKind[] = [];
  const counts = new Map<SummaryKind, number>();
  const files = new Set<string>();
  let pathless = 0;
  for (const part of parts) {
    const { family, subject } = describeTool(part.name, part.input);
    const kind: SummaryKind = part.status === 'denied' || (part.status === 'error' && (family === 'edit' || family === 'write'))
      ? 'attempt' : family === 'write' ? 'edit' : family;
    if (!counts.has(kind)) order.push(kind);
    if (kind === 'edit') {
      if (subject) files.add(subject);
      else pathless++;
      counts.set(kind, files.size + pathless);
    } else {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  const clauses = order.map((kind) => {
    const count = counts.get(kind) ?? 0;
    const template = count === 1 ? strings.chat.toolRunOne[kind] : strings.chat.toolRunMany[kind];
    return fill(template, { count: String(count) });
  });
  const sentence = clauses.map((clause, index) => (index === 0 ? clause : clause.charAt(0).toLowerCase() + clause.slice(1)));
  if (sentence.length < 2) return sentence[0] ?? '';
  return `${sentence.slice(0, -1).join(strings.chat.toolRunJoin)}${strings.chat.toolRunLast}${sentence.at(-1)}`;
}
