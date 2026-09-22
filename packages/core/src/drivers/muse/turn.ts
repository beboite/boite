import type { MessageId, MessagePart, ToolStatus, Usage } from '@boite/contracts';
import type { TurnContext, TurnResult } from '../types.ts';
import type { ToolView } from './protocol.ts';

// ---------------------------------------------------------------------------
// The turn and what it draws
// ---------------------------------------------------------------------------

interface ToolEntry {
  index: number;
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}

/**
 * One `turn/start`, or one `session/compact`, and what it wrote. The parts are
 * drawn the way every other driver draws them: one text part the deltas append
 * to, one part per tool item, one part per approval and per question.
 */
export class MuseTurn {
  private messageId: MessageId | null = null;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private thinkingIndex: number | null = null;
  private readonly tools = new Map<string, ToolEntry>();
  /** Per item and field, the text already drawn: a snapshot only adds what is past it. */
  private readonly surfaces = new Map<string, string>();

  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  private resolve: (result: TurnResult) => void = () => undefined;
  private decide: () => void = () => undefined;
  private wake: () => void = () => undefined;

  readonly done: Promise<TurnResult>;
  /** Resolves the moment the outcome is known, before anything is journalled. */
  readonly finished: Promise<void>;
  /** Resolves on `stop()`, so an approval or a question still waiting moves on. */
  readonly stopped: Promise<void>;

  sessionId: string | null;
  /** The Muse turn id: the `commandId` of the `turn/start`, then the one its ack names. */
  turnId: string | null = null;
  usage: Usage | null = null;
  /** `session/tokenUsage` summed over the turn, for a `turn/completed` that carries none. */
  observed: Usage | null = null;
  decided = false;
  isStopped = false;
  settled = false;

  constructor(readonly ctx: TurnContext) {
    this.sessionId = ctx.sessionId;
    this.done = new Promise<TurnResult>((resolve) => {
      this.resolve = resolve;
    });
    this.finished = new Promise<void>((resolve) => {
      this.decide = resolve;
    });
    this.stopped = new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  get compacting(): boolean {
    return this.ctx.turn.execution?.operation === 'compact';
  }

  markStopped(): void {
    this.isStopped = true;
    this.wake();
  }

  /** The turn's outcome as `turn/completed` states it. */
  finish(terminal: string, error: string | null): void {
    if (this.decided) return;
    if (terminal === 'cancelled') this.status = 'stopped';
    else if (terminal !== 'completed') {
      this.fail(error ?? `the muse turn ended ${terminal}`);
      return;
    }
    this.decided = true;
    this.decide();
  }

  fail(reason: string): void {
    if (this.decided) return;
    this.decided = true;
    this.status = 'error';
    this.error = reason;
    this.part(this.takeIndex(), { type: 'error', message: reason });
    this.decide();
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.decided = true;
    this.wake();
    this.decide();
    if (this.messageId !== null) {
      this.ctx.emit.complete(this.messageId, this.status === 'error' ? 'error' : 'complete');
    }
    this.resolve({
      status: this.status,
      sessionId: this.sessionId,
      usage: this.usage ?? this.observed,
      error: this.error ?? undefined,
    });
  }

  // -- parts ----------------------------------------------------------------

  private message(): MessageId {
    if (this.messageId === null) this.messageId = this.ctx.emit.startMessage('assistant');
    return this.messageId;
  }

  part(index: number, part: MessagePart): void {
    this.ctx.emit.part(this.message(), index, part);
  }

  takeIndex(): number {
    this.textIndex = null;
    this.thinkingIndex = null;
    const index = this.nextIndex;
    this.nextIndex += 1;
    return index;
  }

  private writeText(text: string): void {
    if (text.length === 0) return;
    if (this.textIndex === null) {
      const index = this.nextIndex;
      this.nextIndex += 1;
      this.textIndex = index;
      this.thinkingIndex = null;
      this.part(index, { type: 'text', text: '' });
    }
    this.ctx.emit.delta(this.message(), this.textIndex, text);
  }

  private writeThinking(text: string): void {
    if (text.length === 0) return;
    if (this.thinkingIndex === null) {
      const index = this.nextIndex;
      this.nextIndex += 1;
      this.thinkingIndex = index;
      this.textIndex = null;
      this.part(index, { type: 'thinking', text: '' });
    }
    this.ctx.emit.delta(this.message(), this.thinkingIndex, text);
  }

  private write(kind: 'text' | 'thinking', text: string): void {
    if (kind === 'text') this.writeText(text);
    else this.writeThinking(text);
  }

  /** An `item/delta`: appended as it comes, and remembered so the next snapshot skips it. */
  appendDelta(itemId: string, field: string, kind: 'text' | 'thinking', delta: string): void {
    const key = `${itemId}:${field}`;
    this.surfaces.set(key, (this.surfaces.get(key) ?? '') + delta);
    this.write(kind, delta);
  }

  /**
   * A snapshot of the whole text so far. Only the suffix nobody drew yet goes
   * out; a snapshot that does not extend what was drawn replaces nothing,
   * because a delta already sent cannot be taken back.
   */
  appendSnapshot(itemId: string, field: string, kind: 'text' | 'thinking', text: string | undefined): void {
    if (text === undefined || text.length === 0) return;
    const key = `${itemId}:${field}`;
    const drawn = this.surfaces.get(key) ?? '';
    if (text.length <= drawn.length || !text.startsWith(drawn)) return;
    this.surfaces.set(key, text);
    this.write(kind, text.slice(drawn.length));
  }

  /** Every item notification redraws the same card, found by item id. */
  upsertTool(itemId: string, view: ToolView): void {
    const entry = this.tools.get(itemId) ?? {
      index: this.takeIndex(),
      name: view.name,
      input: null,
      output: null,
      status: 'running' as ToolStatus,
    };
    entry.name = view.name;
    if (view.input !== undefined) entry.input = view.input;
    if (view.output !== null) entry.output = view.output;
    entry.status = view.status;
    this.tools.set(itemId, entry);
    this.part(entry.index, {
      type: 'tool',
      toolId: itemId,
      name: entry.name,
      input: entry.input,
      output: entry.output,
      status: entry.status,
    });
  }
}
