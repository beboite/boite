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

/** A call the agent asked the user to allow: it folds into the run of the call it gates. */
export type PermissionStep = Extract<MessagePart, { type: 'permission' }>;

/** What an activity run holds: the calls, the reasoning between them and the permissions they asked. */
export type ActivityPart = ToolPart | ThinkingStep | PermissionStep;

/** One entry of a message's parts as the timeline draws it: a part on its own, or a run of activity. */
export type PartRun = { kind: 'part'; index: number } | { kind: 'activity'; indices: number[] };

/**
 * A call that produced a diff, a page or an image stands alone: what it made is
 * the point. So does an edit whose input spells out its change, the diff
 * `ToolCard` draws when the driver attaches none. Failed attempts stay in the run.
 */
function standsAlone(part: ToolPart, groupChanges: boolean): boolean {
  if (groupChanges && !(part.documents ?? []).some(doc => doc.kind !== 'diff')) return false;
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

/** Whether a run draws anything: any call or permission does, reasoning only when `thinkingShown`. */
export function activityShown(parts: readonly ActivityPart[], thinkingLive: boolean): boolean {
  return parts.some((part, index) => part.type !== 'thinking' || thinkingShown(part, thinkingLive && index === parts.length - 1));
}

/** Written text or any part that stands on its own between activity: a call's permission never reaches past it. */
function breaksRun(part: MessagePart | undefined): boolean {
  if (!part || part.type === 'thinking' || part.type === 'permission') return false;
  if (part.type === 'text') return part.text.trim() !== '';
  return part.type !== 'tool' || planOf(part.name, part.input) !== null;
}

/**
 * Which call each permission was asked for, as indices into `parts`:
 * permission to call. A permission carries no call id, so it takes the closest
 * call of its tool's name before it that no other permission took (an agent
 * asks right after it announces the call), else the first such call after it
 * (one that asks before it calls). The search never crosses written text or
 * any other part that breaks a run: a call before the answer's last paragraph
 * is not the one asked for. One with no call of its name stays unpaired and
 * draws as its own line. `from` and `to` bound the search.
 */
export function pairPermissions(parts: readonly MessagePart[], from = 0, to = parts.length): Map<number, number> {
  const pairs = new Map<number, number>();
  const taken = new Set<number>();
  for (let at = from; at < to; at += 1) {
    const part = parts[at];
    if (part?.type !== 'permission') continue;
    const fits = (index: number) => {
      const call = parts[index];
      // A proposed plan is its own card, never in a run: its permission keeps its own line.
      return call?.type === 'tool' && call.name === part.toolName && !taken.has(index) && planOf(call.name, call.input) === null;
    };
    let found = -1;
    for (let back = at - 1; back >= from && found < 0 && !breaksRun(parts[back]); back -= 1) if (fits(back)) found = back;
    for (let next = at + 1; next < to && found < 0 && !breaksRun(parts[next]); next += 1) if (fits(next)) found = next;
    if (found < 0) continue;
    pairs.set(at, found);
    taken.add(found);
  }
  return pairs;
}

/**
 * Splits the parts into runs. Calls and reasoning with nothing written between
 * them are one run, drawn as one line that opens on its steps; blank text does
 * not break it. Answer text, a call that made something and a proposed plan
 * each keep their own place in the timeline. A permission goes in the run of
 * the call it was asked for (`pairPermissions`), wherever that call stands.
 * `from` and `to` read a stretch of the message only, its runs indexed as in
 * the whole message: what one row of a long message draws, and what a memory
 * notice cuts a message into.
 */
export function partRuns(parts: readonly MessagePart[], from = 0, to = parts.length, groupChanges = false): PartRun[] {
  const runs: PartRun[] = [];
  let open: { kind: 'activity'; indices: number[] } | null = null;
  const pairs = pairPermissions(parts, from, to);
  const askedFor = new Map([...pairs].map(([permission, call]) => [call, permission]));
  /** The run each folded call landed in, for a permission asked after it. */
  const runOf = new Map<number, { kind: 'activity'; indices: number[] }>();
  for (let index = from; index < to; index += 1) {
    const part = parts[index];
    if (!part) continue;
    // Blank text is skipped unless it ends the message itself: that one carries the caret.
    // The index comes first, so the streaming last part's text is never read and a delta reruns nothing here.
    if (index < parts.length - 1 && part.type === 'text' && part.text.trim() === '') continue;
    const call = part.type === 'permission' ? pairs.get(index) : undefined;
    if (call !== undefined) {
      // Asked after its call: it joins that call's run. Asked before: it waits for its call.
      const run = runOf.get(call);
      if (run || call > index) {
        run?.indices.push(index);
        continue;
      }
    }
    const folds = part.type === 'thinking' || part.type === 'permission' || (part.type === 'tool' && planOf(part.name, part.input) === null);
    let run: { kind: 'activity'; indices: number[] } | null = null;
    if (!folds) {
      open = null;
      runs.push({ kind: 'part', index });
    } else if (part.type === 'tool' && standsAlone(part, groupChanges)) {
      open = null;
      run = { kind: 'activity', indices: [index] };
      runs.push(run);
    } else if (open) {
      open.indices.push(index);
      run = open;
    } else {
      open = run = { kind: 'activity', indices: [index] };
      runs.push(open);
    }
    if (run === null || part.type !== 'tool') continue;
    runOf.set(index, run);
    const asked = askedFor.get(index);
    // Asked before its call: back in timeline order, so the run keeps the key it opened with.
    if (asked !== undefined && asked < index) {
      const at = run.indices.findIndex((step) => step > asked);
      run.indices.splice(at < 0 ? run.indices.length : at, 0, asked);
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
    if (part.type === 'permission' || part.startedAt == null) continue;
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

/** `FOO=bar`, `FOO="a b"` or `FOO='a b'`: a variable set for the command after it. */
const ASSIGNMENT = String.raw`\w+=(?:"[^"]*"|'[^']*'|\S*)`;
/** Steps a reader skips to find what runs: moving somewhere, setting a variable. */
const PREAMBLE = new RegExp(String.raw`^(cd|set-location|pushd|sl|export|set)\b|^\$env:|^${ASSIGNMENT}$`, 'i');
const LEADING_ASSIGNMENTS = new RegExp(String.raw`^(${ASSIGNMENT}\s+)+`);

/** The part of a command that runs the program: `git status` for `cd src && git status`. */
function programSegment(command: string): string {
  const segments = unwrapCommand(command).split(/&&|\|\||;|\|/).map((segment) => segment.trim()).filter(Boolean);
  const segment = segments.find((entry) => !PREAMBLE.test(entry)) ?? segments[0] ?? '';
  // Leading `FOO=bar` assignments and PowerShell's `&` call operator come before the program.
  return segment.replace(/^&\s+/, '').replace(LEADING_ASSIGNMENTS, '');
}

/** The program a command runs, `git` for `cd src && git status`, empty when there is none to name. */
export function programOf(command: string): string {
  const { first } = splitFirst(programSegment(command));
  return first ? baseName(first) : '';
}

/** A word naming what a program does (`agents`, `run`, `status`), not a flag, a path or a value. */
const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;

/**
 * The program and the subcommands that say what it does: `boite threads send`
 * for `boite threads send thr_1 "redo it"`, `git status` for `git status --short`.
 */
export function commandOf(command: string): string {
  const { first, rest } = splitFirst(programSegment(command));
  if (!first) return '';
  const subcommands: string[] = [];
  for (const word of rest.split(/\s+/)) {
    if (subcommands.length === 2 || !SUBCOMMAND.test(word)) break;
    subcommands.push(word);
  }
  return [baseName(first), ...subcommands].join(' ');
}

/** What the agent said a command is for, as Claude's shell tools carry it while they run: its first line. */
function intentOf(part: ToolPart): string {
  const input = part.input;
  const value = typeof input === 'object' && input !== null ? (input as { description?: unknown }).description : undefined;
  return typeof value === 'string' ? value.trim().split('\n')[0]!.trim().slice(0, 160) : '';
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

/**
 * What a running run says on its folded line: the agent's own words for a
 * command when it gave some ("Ask the media step to redo the assets"), else
 * "Running git status", "Reading app.ts".
 */
export function liveLabel(part: ToolPart): string {
  const family = familyOf(part);
  if (typeof part.inputText === 'string') return family === 'command'
    ? fill(strings.chat.toolLive.command, { subject: strings.chat.toolCommandWord })
    : strings.chat.toolBare[family];
  if (family === 'command') {
    const intent = intentOf(part);
    if (intent) return intent;
    const command = commandOf(commandText(part));
    return fill(strings.chat.toolLive.command, { subject: command || strings.chat.toolCommandWord });
  }
  const subject = subjectOf(part, family);
  return subject ? fill(strings.chat.toolLive[family], { subject }) : strings.chat.toolBare[family];
}

/**
 * The agent's own words for a finished run: the distinct `summary` lines its
 * calls carry, in the order they came. Null as soon as one call has none, so a
 * run never reads as a description of only part of what it did.
 */
export function agentSummary(parts: readonly ToolPart[]): string | null {
  const lines: string[] = [];
  for (const part of parts) {
    const line = part.summary?.trim();
    if (!line) return null;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines.length === 0 ? null : lines.join(' · ');
}

/** A line that is only a bold run: the heading Codex opens each reasoning section with. */
const THOUGHT_HEADING = /^[\t ]*\*\*([^*\r\n]+)\*\*[\t ]*\r?$/gm;
/** A line between two newlines that ends a paragraph: spaces and tabs only. */
const BLANK_LINE = /^[\t ]*$/;
/** The white space from a position on, the same set `trim` takes off. */
const SPACE = /\s*/y;

/**
 * The words of the last heading in a stretch that holds no newline. A match
 * never crosses a newline, so each line read alone gives what the whole text
 * gives with `/m`.
 */
function lastHeading(line: string): string | undefined {
  if (!line.includes('**')) return undefined;
  let words: string | undefined;
  for (const match of line.matchAll(THOUGHT_HEADING)) words = match[1];
  return words;
}

/** The first line of a paragraph as a title: markdown off, cut at its first sentence. */
function sentenceOf(firstLine: string): string | null {
  const line = firstLine.replace(/\*\*|__|`/g, '').replace(/^[#>*\-\s]+/, '').trim();
  const end = line.search(/[.!?](\s|$)/);
  const sentence = (end === -1 ? line : line.slice(0, end + 1)).replace(/\.$/, '').trim();
  return sentence || null;
}

/**
 * What a reasoning step is about, in one line: the last heading Codex wrote
 * ("Inspecting the driver"), else the first sentence of the last paragraph,
 * which is where a Claude summary or a raw chain of thought stands now. Null
 * while the step has no words, so the caller falls back to "Thinking".
 */
export function thoughtTitle(text: string): string | null {
  return new ThoughtTitleScan().title(text);
}

/**
 * thoughtTitle for a thought that grows: a text that extends the last one
 * resumes after its last complete line, so a delta reads only its own lines
 * and the unfinished one. Paragraphs split where `text.split(/\n[\t ]*\n/)` would:
 * a blank line ends one only when the newline before it did not already close
 * the previous blank line. Any other text starts over.
 */
export class ThoughtTitleScan {
  /** Where the line after the last newline read starts. */
  #offset = 0;
  /** The words of the last heading in the complete lines, blank words included. */
  #heading: string | undefined;
  /** The newline before the next line is free to open a paragraph break. */
  #free = false;
  /** The first non-space character of the open paragraph, -1 while it has none. */
  #first = -1;
  /** Where the search for it resumes: what lies before is white space. */
  #seek = 0;
  /** The first non-space character of the last closed paragraph with words. */
  #closed = -1;
  /** The title of a first line that ended, by where it starts. */
  #lineAt = -1;
  #lineTitle: string | null = null;
  #text: string | null = null;
  #title: string | null = null;

  title(text: string): string | null {
    if (text === this.#text) return this.#title;
    // What was found in the unfinished line holds only for a text that extends the whole last one.
    if (this.#text === null || !text.startsWith(this.#text)) {
      this.#offset = 0;
      this.#heading = undefined;
      this.#free = false;
      this.#first = -1;
      this.#seek = 0;
      this.#closed = -1;
      this.#lineAt = -1;
    }
    let offset = this.#offset;
    for (let end = text.indexOf('\n', offset); end !== -1; end = text.indexOf('\n', offset)) {
      const line = text.slice(offset, end);
      const heading = lastHeading(line);
      if (heading !== undefined) this.#heading = heading;
      if (this.#free && BLANK_LINE.test(line)) {
        // The break runs from the newline before this line to the one after it.
        if (this.#seekFirst(text, offset - 1)) this.#closed = this.#first;
        this.#first = -1;
        this.#seek = end + 1;
        this.#free = false;
      } else {
        this.#free = true;
      }
      offset = end + 1;
    }
    this.#offset = offset;
    this.#text = text;
    this.#title = this.#titleOf(text, lastHeading(text.slice(offset)) ?? this.#heading);
    return this.#title;
  }

  #titleOf(text: string, heading: string | undefined): string | null {
    const words = heading?.trim();
    if (words) return words;
    const at = this.#seekFirst(text, text.length) ? this.#first : this.#closed;
    if (at < 0) return null;
    if (at === this.#lineAt) return this.#lineTitle;
    const end = text.indexOf('\n', at);
    const title = sentenceOf(text.slice(at, end < 0 ? text.length : end));
    if (end >= 0) {
      this.#lineAt = at;
      this.#lineTitle = title;
    }
    return title;
  }

  /** Whether the open paragraph has a non-space character before `limit`. */
  #seekFirst(text: string, limit: number): boolean {
    if (this.#first >= 0) return true;
    SPACE.lastIndex = this.#seek;
    SPACE.exec(text);
    if (SPACE.lastIndex < limit) {
      this.#first = SPACE.lastIndex;
      return true;
    }
    this.#seek = Math.max(this.#seek, Math.min(SPACE.lastIndex, limit));
    return false;
  }
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
