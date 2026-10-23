import { SvelteSet } from 'svelte/reactivity';
import type { Message, MessagePart, Turn } from '@boite/contracts';
import { fill, strings } from './strings';

/**
 * How a persistent agent's thread reads like a message app: a finished turn
 * shows its answer, its steps (the calls, the reasoning and the narration
 * between them) folded behind one "Worked 3 min · 14 steps" row above it,
 * and a wake that had nothing for the user folds whole to one "Nothing to
 * report" line. A running turn stays open and live. Either row opens again
 * on a click, and the turn reads as it ran.
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
 * event turn, settled, that the core marked quiet or whose final text block
 * opens or ends with a `[quiet] <what it checked>` line.
 */
export function quietReason(turn: Pick<Turn, 'status' | 'execution' | 'quiet'>, messages: readonly Message[]): string | null {
  const operation = turn.execution?.operation;
  if ((operation !== 'routine' && operation !== 'event') || !settled(turn)) return null;
  const lines = (finalText(messages) ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  const line = [lines[0], lines.at(-1)].find(line => line !== undefined && QUIET.test(line));
  if (line) return QUIET.exec(line)![1]!.trim();
  return turn.quiet ? '' : null;
}

/** What the fold rows and the trimmed messages were last time: a row that did not change keeps its object, so the list measures nothing again. */
export class TurnFolds {
  #rows = new Map<string, { key: string; message: Message }>();
  #trimmed = new WeakMap<Message, { key: string; message: Message }>();
  /** The folds of the last build, by row id. */
  folds: ReadonlyMap<string, TurnFold> = new Map();

  /**
   * `timeline` with each finished turn folded: a fold row before its first
   * answer and the steps left out of its messages, or a quiet wake down to
   * its row alone. The turns in `opened` keep every message, under their row.
   * The same array comes back when nothing folds.
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
    /** Where each folded turn's last step sits: what comes after it is the answer. */
    const lastStep = new Map<string, { message: Message; index: number }>();
    for (const [, fold] of folds) {
      for (const message of byTurn.get(fold.turnId) ?? []) {
        if (message.role !== 'assistant') continue;
        const index = message.parts.findLastIndex(isStep);
        if (index >= 0) lastStep.set(fold.turnId, { message, index });
      }
    }
    for (const message of timeline) {
      const fold = folds.get(FOLD_PREFIX + message.turnId);
      if (!fold) { out.push(message); continue; }
      const id = FOLD_PREFIX + fold.turnId;
      // A quiet wake's row comes before its opening line; a worked row before its first answer.
      const here = fold.kind === 'quiet' || message.role === 'assistant';
      if (here && !placed.has(id)) { placed.add(id); out.push(this.#row(id, fold, message)); }
      if (fold.open) { out.push(message); continue; }
      if (fold.kind === 'quiet' || message.role !== 'assistant') { if (fold.kind !== 'quiet') out.push(message); continue; }
      const kept = this.#trim(message, lastStep.get(fold.turnId));
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
  #trim(message: Message, last: { message: Message; index: number } | undefined): Message | null {
    // Messages after the one holding the last step are all answer.
    const cut = last?.message === message ? last.index : last && message.createdAt <= last.message.createdAt ? message.parts.length : -1;
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
