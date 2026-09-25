import type { MessageId, MessagePart, ToolStatus, Usage } from '@boite/contracts';
import type { PromptCacheLife, TurnContext, TurnResult } from '../types.ts';
import type { CodexTurnRecord, ToolView } from './protocol.ts';

// ---------------------------------------------------------------------------
// The turn and what it draws
// ---------------------------------------------------------------------------

/** How much of a running command's output the card carries, and how often it is redrawn. */
const LIVE_OUTPUT_MAX = 16_000;
const LIVE_OUTPUT_BEAT_MS = 250;

interface ToolEntry {
  index: number;
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}

/**
 * One `turn/start` and what it wrote. The parts are drawn the way every other
 * driver draws them: one text part the deltas append to, one part per item that
 * is a tool, one part per approval question.
 */
export class CodexTurn {
  private messageId: MessageId | null = null;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private thinkingIndex: number | null = null;
  /** The reasoning section the last thinking delta belonged to. */
  private thinkingSection: string | null = null;
  private readonly tools = new Map<string, ToolEntry>();
  /** Tools whose streamed output waits for the next flush, so a chatty command costs one write per beat. */
  private readonly dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  private resolve: (result: TurnResult) => void = () => undefined;
  private decide: () => void = () => undefined;
  private wake: () => void = () => undefined;

  readonly done: Promise<TurnResult>;
  /** Resolves the moment the outcome is known, before anything is journalled. */
  readonly finished: Promise<void>;
  /** Resolves on `stop()`, so an approval still waiting can decline and move on. */
  readonly stopped: Promise<void>;

  sessionId: string | null;
  /** The Codex turn id, known once `turn/start` answers. */
  turnId: string | null = null;
  usage: Usage | null = null;
  /** The published prompt cache lifetime of the model this turn ran on. */
  cacheLife: PromptCacheLife | null = null;
  decided = false;
  isStopped = false;
  settled = false;
  /** `thread/resume` said the Codex thread is gone. */
  sessionLost = false;

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

  noteSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  markStopped(): void {
    this.isStopped = true;
    this.wake();
  }

  /** `turn/completed`, or a `turn/start` that already answered with a finished turn. */
  finish(record: CodexTurnRecord): void {
    if (this.decided) return;
    switch (record.status) {
      case 'completed':
        break;
      case 'interrupted':
        this.status = 'stopped';
        break;
      case 'failed':
        this.fail(record.error?.message ?? 'the codex agent failed the turn');
        return;
      default:
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

  /** A stop the agent never got to act on: the turn ends stopped, with nothing drawn. */
  endStopped(): void {
    if (this.decided) return;
    this.decided = true;
    this.status = 'stopped';
    this.decide();
  }

  /**
   * The thread this turn resumes no longer exists on the agent's side. No
   * error part: the core starts a fresh session and runs the turn again.
   */
  loseSession(reason: string): void {
    if (this.decided) return;
    this.decided = true;
    this.sessionLost = true;
    this.status = 'error';
    this.error = reason;
    this.decide();
  }

  settle(): void {
    if (this.settled) return;
    this.flushOutput();
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
      usage: this.usage,
      error: this.error ?? undefined,
      promptCache: this.cacheLife,
      ...(this.sessionLost ? { sessionLost: true } : {}),
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

  writeText(text: string): void {
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

  /**
   * The reasoning deltas, which the UI folds. Their own part, like the text.
   * `section` names the reasoning item and its summary or content index: the
   * server streams each section with no newline around it, so a delta of a new
   * section that lands in the same part starts after a blank line.
   */
  writeThinking(text: string, section?: string): void {
    if (text.length === 0) return;
    if (this.thinkingIndex === null) {
      const index = this.nextIndex;
      this.nextIndex += 1;
      this.thinkingIndex = index;
      this.textIndex = null;
      this.part(index, { type: 'thinking', text: '' });
    } else if (section !== undefined && this.thinkingSection !== null && section !== this.thinkingSection) {
      this.ctx.emit.delta(this.message(), this.thinkingIndex, '\n\n');
    }
    if (section !== undefined) this.thinkingSection = section;
    this.ctx.emit.delta(this.message(), this.thinkingIndex, text);
  }

  /**
   * `item/commandExecution/outputDelta`: what a running command printed so
   * far, drawn under its card while it runs. Only the tail is kept; the
   * completed item carries the whole output anyway.
   */
  appendOutput(itemId: string, delta: string): void {
    const entry = this.tools.get(itemId);
    if (entry === undefined || entry.status !== 'running' || delta.length === 0) return;
    const output = (entry.output ?? '') + delta;
    entry.output = output.length > LIVE_OUTPUT_MAX ? output.slice(output.length - LIVE_OUTPUT_MAX) : output;
    this.dirty.add(itemId);
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => this.flushOutput(), LIVE_OUTPUT_BEAT_MS);
    this.flushTimer.unref?.();
  }

  private flushOutput(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const itemId of this.dirty) {
      const entry = this.tools.get(itemId);
      if (entry !== undefined && entry.status === 'running') this.drawTool(itemId, entry);
    }
    this.dirty.clear();
  }

  /** `item/started` opens the part, `item/completed` replaces the same one by item id. */
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
    this.dirty.delete(itemId);
    this.drawTool(itemId, entry);
  }

  private drawTool(itemId: string, entry: ToolEntry): void {
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
