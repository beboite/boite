import { SvelteSet } from 'svelte/reactivity';
import type { AgentStatus, Message, MessagePart, Turn } from '@boite/contracts';
import { fill, strings } from './strings';
import { AgentsView } from './agents.svelte';
import type { Store } from './store.svelte';

/**
 * How a persistent agent's thread reads like a message app: a finished turn
 * shows its answer, its steps (the calls, the reasoning and the narration
 * between them) folded away, the count on the quiet line under the answer
 * ("2 min · 4 steps"), and a wake that had nothing for the user folds whole
 * to one "Nothing to report" line. A running turn stays open and live. A
 * click on the count or the line opens the turn as it ran.
 */

/** The id a fold row takes in the timeline: the prefix, then its turn. */
export const FOLD_PREFIX = 'fold:';

export interface TurnFold {
  turnId: string;
  /** `worked`: the steps above an answer. `quiet`: the whole of a wake that needed nothing. */
  kind: 'worked' | 'quiet';
  /** The calls the turn made. */
  steps: number;
  /** How long it ran, when both ends are known. */
  ms: number | null;
  /** What a quiet wake says it checked, after `[quiet]`; empty when it said nothing. */
  reason: string;
  open: boolean;
}

/** The folded turns the user opened, for as long as the app runs: turn ids are unique across threads. */
export const openedTurns = new SvelteSet<string>();

/** `40 s`, `3 min`, `1 h 05 min`: how long a turn worked, said the way a person would. */
export function workedTime(ms: number): string {
  const t = strings.chat.fold;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return fill(t.seconds, { count: String(Math.max(1, seconds)) });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return fill(t.minutes, { count: String(minutes) });
  return fill(t.hours, { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60).padStart(2, '0') });
}

export function stepsLabel(count: number): string {
  return count === 1 ? strings.chat.fold.stepOne : fill(strings.chat.fold.stepMany, { count: String(count) });
}

/** The row's words: "Worked 3 min · 14 steps", or "Nothing to report · <reason> · 3 steps". */
export function foldText(fold: TurnFold): string {
  const t = strings.chat.fold;
  const steps = fold.steps > 0 ? [stepsLabel(fold.steps)] : [];
  if (fold.kind === 'quiet') return [t.quiet, ...(fold.reason ? [fold.reason] : []), ...steps].join(' · ');
  return [fold.ms === null ? t.workedBare : fill(t.worked, { time: workedTime(fold.ms) }), ...steps].join(' · ');
}

const QUIET = /^\[quiet\]\s*(.*)$/i;
const settled = (turn: Pick<Turn, 'status'>) => turn.status === 'done' || turn.status === 'stopped' || turn.status === 'error';
const isStep = (part: MessagePart) => part.type === 'tool' || part.type === 'thinking';
/** Narration is a plain text part; one that carries a notice (a move, a thread started) is not. */
const narration = (part: MessagePart) => part.type === 'text' && !part.moved && !part.started && !part.startedBy && !part.activity;

/** The final text block of a turn's final assistant message, as the core reads it for `[quiet]`. */
export function finalText(messages: readonly Message[]): string | null {
  const last = messages.findLast(message => message.role === 'assistant');
  const part = last?.parts.findLast(part => part.type === 'text');
  return part?.type === 'text' ? part.text : null;
}

/**
 * What a quiet wake checked, or null when the turn is not one: a routine or
 * event turn, done, that the core marked quiet or whose final text block
 * opens or ends with a `[quiet] <what it checked>` line. A wake that failed or
 * was stopped after writing its marker is not quiet, as in the core: its
 * failure stays in view.
 */
export function quietReason(turn: Pick<Turn, 'status' | 'execution' | 'quiet'>, messages: readonly Message[]): string | null {
  const operation = turn.execution?.operation;
  if ((operation !== 'routine' && operation !== 'event') || turn.status !== 'done') return null;
  const lines = (finalText(messages) ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  const line = [lines[0], lines.at(-1)].find(line => line !== undefined && QUIET.test(line));
  if (line) return QUIET.exec(line)![1]!.trim();
  return turn.quiet ? '' : null;
}

/** A turn's last step: the message holding it, the part, and the message's index in the timeline. */
type Step = { message: Message; index: number; at: number };

/** What the fold rows and the trimmed messages were last time: a row that did not change keeps its object, so the list measures nothing again. */
export class TurnFolds {
  #rows = new Map<string, { key: string; message: Message }>();
  #trimmed = new WeakMap<Message, { key: string; message: Message }>();
  /** The folds of the last build, by row id. */
  folds: ReadonlyMap<string, TurnFold> = new Map();

  /**
   * `timeline` with each finished turn folded: the steps left out of its
   * messages (the summary line under the answer carries the count), or a
   * quiet wake down to one row alone. The turns in `opened` keep every
   * message. The same array comes back when nothing folds.
   */
  build(timeline: readonly Message[], turns: readonly Turn[], opened: ReadonlySet<string>): Message[] {
    const folds = new Map<string, TurnFold>();
    const byTurn = new Map<string, Message[]>();
    for (const message of timeline) {
      const list = byTurn.get(message.turnId);
      if (list) list.push(message); else byTurn.set(message.turnId, [message]);
    }
    for (const turn of turns) {
      const messages = byTurn.get(turn.id);
      if (!messages || !settled(turn)) continue;
      const steps = messages.reduce((sum, message) => sum + (message.role === 'assistant' ? message.parts.filter(part => part.type === 'tool').length : 0), 0);
      const reason = quietReason(turn, messages);
      if (reason === null && steps === 0) continue;
      const ms = turn.startedAt !== null && turn.finishedAt !== null ? Math.max(0, turn.finishedAt - turn.startedAt) : null;
      folds.set(FOLD_PREFIX + turn.id, { turnId: turn.id, kind: reason === null ? 'worked' : 'quiet', steps, ms, reason: reason ?? '', open: opened.has(turn.id) });
    }
    this.folds = folds;
    if (folds.size === 0) return timeline as Message[];

    const out: Message[] = [];
    const placed = new Set<string>();
    /** Where each folded turn's last step sits, its part and its place in the timeline: what comes after it is the answer. */
    const lastStep = new Map<string, Step>();
    timeline.forEach((message, at) => {
      if (message.role !== 'assistant' || !folds.has(FOLD_PREFIX + message.turnId)) return;
      const index = message.parts.findLastIndex(isStep);
      if (index >= 0) lastStep.set(message.turnId, { message, index, at });
    });
    for (const [at, message] of timeline.entries()) {
      const fold = folds.get(FOLD_PREFIX + message.turnId);
      if (!fold) { out.push(message); continue; }
      const id = FOLD_PREFIX + fold.turnId;
      // A quiet wake's row comes before its opening line; a worked turn gets no row, its count sits under the answer.
      if (fold.kind === 'quiet' && !placed.has(id)) { placed.add(id); out.push(this.#row(id, fold, message)); }
      if (fold.open) { out.push(message); continue; }
      if (fold.kind === 'quiet' || message.role !== 'assistant') { if (fold.kind !== 'quiet') out.push(message); continue; }
      const kept = this.#trim(message, at, lastStep.get(fold.turnId));
      if (kept) out.push(kept);
    }
    return out;
  }

  #row(id: string, fold: TurnFold, at: Message): Message {
    const key = `${fold.kind}|${fold.steps}|${fold.ms}|${fold.reason}|${fold.open}|${at.createdAt}`;
    const known = this.#rows.get(id);
    if (known?.key === key) return known.message;
    const message: Message = { id, threadId: at.threadId, turnId: fold.turnId, role: 'system', parts: [], state: 'complete', createdAt: at.createdAt };
    this.#rows.set(id, { key, message });
    return message;
  }

  /** The message with its steps left out: the calls, the reasoning and the narration before the last of them. */
  #trim(message: Message, at: number, last: Step | undefined): Message | null {
    // Messages after the one holding the last step are all answer, by their order: two can share a millisecond.
    const cut = last?.message === message ? last.index : last && at < last.at ? message.parts.length : -1;
    const parts = message.parts.filter((part, index) => index > cut || !(isStep(part) || narration(part)));
    if (parts.length === message.parts.length) return message;
    if (parts.length === 0) return null;
    const key = `${cut}|${parts.length}`;
    const known = this.#trimmed.get(message);
    if (known?.key === key) return known.message;
    const trimmed = { ...message, parts };
    this.#trimmed.set(message, { key, message: trimmed });
    return trimmed;
  }
}

/** An agent's last memory pass, as its status reports it. */
export type MemoryPass = NonNullable<AgentStatus['memory']>;

/**
 * The turn a memory pass followed: the last one that ended before it with an
 * answer the user saw. A quiet wake, a cache ping or a compaction starts none.
 */
export function memoryTurn(turns: readonly Turn[], pass: Pick<MemoryPass, 'at'>): string | null {
  let best: Turn | null = null;
  for (const turn of turns) {
    const operation = turn.execution?.operation;
    if (!settled(turn) || turn.status === 'stopped' || turn.quiet || operation === 'keepalive' || operation === 'compact') continue;
    if (turn.finishedAt === null || turn.finishedAt > pass.at) continue;
    if (!best || turn.finishedAt >= (best.finishedAt ?? 0)) best = turn;
  }
  return best?.id ?? null;
}

/** The last memory pass of the agent whose own thread this is, null before its first; undefined for any other thread. */
export function memoryPassOf(store: Store, threadId: string): MemoryPass | null | undefined {
  if (store.openThread?.id !== threadId || !store.openThread.agentSessionId) return undefined;
  return AgentsView.of(store).snapshot?.status?.find(status => status.threadId === threadId)?.memory ?? null;
}

const NO_FOLDS: ReadonlyMap<string, TurnFold> = new Map();

/** A persistent agent's thread as it reads: its finished turns folded, and the turn its last memory pass followed, whose summary line carries the mark. */
export class AgentTimeline {
  #folds = new TurnFolds();
  /** `pass` undefined: not an agent's own thread, and the timeline stays as it is. */
  build(timeline: Message[], turns: readonly Turn[], pass: MemoryPass | null | undefined): ShapedTimeline {
    if (pass === undefined) return { timeline, folds: NO_FOLDS, memoryTurnId: null, pass: null };
    const shaped = this.#folds.build(timeline, turns, openedTurns);
    return { timeline: shaped, folds: this.#folds.folds, memoryTurnId: pass ? memoryTurn(turns, pass) : null, pass };
  }
}

export interface ShapedTimeline {
  timeline: Message[];
  folds: ReadonlyMap<string, TurnFold>;
  /** The turn the last memory pass followed. */
  memoryTurnId: string | null;
  pass: MemoryPass | null;
}

/** Opens a folded turn again, or folds it, for the app session. */
export function toggleTurn(turnId: string): void {
  if (openedTurns.has(turnId)) openedTurns.delete(turnId);
  else openedTurns.add(turnId);
}

/** What a turn's summary line carries in an agent's thread: its folded steps, opened from the line, and the mark of the memory pass that followed it. */
export function summaryMarks(shaped: ShapedTimeline, turnId: string, openDesk: () => void): { steps?: { count: number; open: boolean; toggle: () => void }; memory?: { pass: MemoryPass; open: () => void } } {
  const fold = shaped.folds.get(FOLD_PREFIX + turnId);
  return {
    ...(fold?.kind === 'worked' ? { steps: { count: fold.steps, open: fold.open, toggle: () => toggleTurn(turnId) } } : {}),
    ...(shaped.memoryTurnId === turnId && shaped.pass ? { memory: { pass: shaped.pass, open: openDesk } } : {}),
  };
}
