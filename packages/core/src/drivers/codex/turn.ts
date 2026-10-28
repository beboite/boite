import type { MessageId, MessagePart, ToolStatus, Usage } from '@boite/contracts';
import type { PromptCacheLife, TurnContext, TurnRefusal, TurnResult } from '../types.ts';
import { codexRefusal } from './availability.ts';
import type { CodexTokenCounts } from './mapping.ts';
import type { CodexTurnRecord, ToolView } from './protocol.ts';

// ---------------------------------------------------------------------------
// The turn and what it draws
// ---------------------------------------------------------------------------

/**
 * How much of a running command's output the card carries, and how often it
 * is redrawn: each redraw is a journal write and a part frame to every client.
 * The completed item carries the whole output anyway.
 */
const LIVE_OUTPUT_MAX = 4_000;
const LIVE_OUTPUT_BEAT_MS = 1_000;

interface ToolEntry {
  exitCode?: number | null;
  nativeAgents?: ToolView['nativeAgents'];
  index: number;
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
  /** Output deltas since the last redraw, joined into `output` once per beat. */
  pending?: { pieces: string[]; length: number };
}

/** Folds the deltas waiting since the last redraw into the kept tail, with one join. */
function foldOutput(entry: ToolEntry): void {
  const pending = entry.pending;
  if (pending === undefined) return;
  entry.pending = undefined;
  const output = (entry.output ?? '') + pending.pieces.join('');
  entry.output = output.length > LIVE_OUTPUT_MAX ? output.slice(output.length - LIVE_OUTPUT_MAX) : output;
}

/**
 * One `turn/start` and what it wrote. The parts are drawn the way every other
 * driver draws them: one text part the deltas append to, one part per item that
 * is a tool, one part per approval question.
 */
export class CodexTurn {
  #messageId: MessageId | null = null;
  #nextIndex = 0;
  #textIndex: number | null = null;
  #thinkingIndex: number | null = null;
  /** The reasoning section the last thinking delta belonged to. */
  #thinkingSection: string | null = null;
  readonly #tools = new Map<string, ToolEntry>();
  readonly #textItems = new Map<string, { index: number; text: string; complete: boolean }>();
  /** Tools whose streamed output waits for the next flush, so a chatty command costs one write per beat. */
  readonly #dirty = new Set<string>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  #completedTurnId: string | null = null;
  #status: TurnResult['status'] = 'done';
  #error: string | null = null;
  #diagnosticError: string | undefined;
  #resolve: (result: TurnResult) => void = () => undefined;
  #decide: () => void = () => undefined;
  #wake: () => void = () => undefined;

  readonly done: Promise<TurnResult>;
  /** Resolves the moment the outcome is known, before anything is journalled. */
  readonly finished: Promise<void>;
  /** Resolves on `stop()`, so an approval still waiting can decline and move on. */
  readonly stopped: Promise<void>;

  sessionId: string | null;
  /** The Codex turn id, known once `turn/start` answers. */
  turnId: string | null = null;
  usage: Usage | null = null;
  /** Every model request of this turn so far, in Codex's counts. */
  usageCounts: CodexTokenCounts | null = null;
  /** The thread's cumulative `total` at this turn's latest usage update. */
  usageTotal: CodexTokenCounts | null = null;
  /** The published prompt cache lifetime of the model this turn ran on. */
  cacheLife: PromptCacheLife | null = null;
  decided = false;
  isStopped = false;
  settled = false;
  /** `thread/resume` said the Codex thread is gone. */
  sessionLost = false;
  /** The code of the last `error` notification Codex sent without retrying, for a failure that carries none. */
  lastErrorInfo: unknown = null;
  /** When the account's spent window resets, from `account/rateLimits/updated`; null when none is spent or nothing was said. */
  spentWindowResetsAt: number | null = null;
  #refusal: TurnRefusal | undefined;

  constructor(readonly ctx: TurnContext) {
    this.sessionId = ctx.sessionId;
    this.done = new Promise<TurnResult>((resolve) => {
      this.#resolve = resolve;
    });
    this.finished = new Promise<void>((resolve) => {
      this.#decide = resolve;
    });
    this.stopped = new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
  }

  noteSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  markStopped(): void {
    this.isStopped = true;
    this.#wake();
  }

  /** `turn/completed`, or a `turn/start` that already answered with a finished turn. */
  finish(record: CodexTurnRecord): void {
    if (this.decided) return;
    switch (record.status) {
      case 'completed':
        this.#completedTurnId = record.id;
        break;
      case 'interrupted':
        this.#status = 'stopped';
        break;
      case 'failed':
        this.#refusal = codexRefusal(record.error?.codexErrorInfo ?? this.lastErrorInfo, record.error?.message, this.spentWindowResetsAt);
        this.fail(record.error?.message ?? 'the codex agent failed the turn');
        return;
      default:
        return;
    }
    this.decided = true;
    this.#decide();
  }

  fail(reason: string, diagnostic?: string): void {
    if (this.decided) return;
    this.decided = true;
    this.#status = 'error';
    this.#error = reason;
    this.#diagnosticError = diagnostic;
    this.part(this.takeIndex(), { type: 'error', message: reason });
    this.#decide();
  }

  /** A stop the agent never got to act on: the turn ends stopped, with nothing drawn. */
  endStopped(): void {
    if (this.decided) return;
    this.decided = true;
    this.#status = 'stopped';
    this.#decide();
  }

  /**
   * The thread this turn resumes no longer exists on the agent's side. No
   * error part: the core starts a fresh session and runs the turn again. A
   * turn the user stopped meanwhile ends stopped, so nothing runs it again.
   */
  loseSession(reason: string): void {
    if (this.decided) return;
    this.decided = true;
    this.sessionLost = true;
    if (this.isStopped) {
      this.#status = 'stopped';
    } else {
      this.#status = 'error';
      this.#error = reason;
    }
    this.#decide();
  }

  settle(): void {
    if (this.settled) return;
    this.#flushOutput();
    this.settled = true;
    this.decided = true;
    this.#wake();
    this.#decide();
    if (this.#messageId !== null) {
      this.ctx.emit.complete(this.#messageId, this.#status === 'error' ? 'error' : 'complete');
    }
    this.#resolve({
      status: this.#status,
      sessionId: this.sessionId,
      usage: this.usage,
      error: this.#error ?? undefined,
      ...(this.#diagnosticError === undefined ? {} : { diagnosticError: this.#diagnosticError }),
      promptCache: this.cacheLife,
      ...(this.#status === 'done' && this.sessionId && this.#completedTurnId
        ? { checkpoint: { sessionId: this.sessionId, entry: this.#completedTurnId } } : {}),
      ...(this.sessionLost ? { sessionLost: true } : {}),
      ...(this.#status === 'error' && this.#refusal ? { refusal: this.#refusal } : {}),
    });
  }

  // -- parts ----------------------------------------------------------------

  #message(): MessageId {
    if (this.#messageId === null) this.#messageId = this.ctx.emit.startMessage('assistant');
    return this.#messageId;
  }

  part(index: number, part: MessagePart): void {
    this.ctx.emit.part(this.#message(), index, part);
  }

  takeIndex(): number {
    this.#textIndex = null;
    this.#thinkingIndex = null;
    const index = this.#nextIndex;
    this.#nextIndex += 1;
    return index;
  }

  writeText(text: string, itemId?: string): void {
    if (text.length === 0) return;
    if (itemId) {
      let entry = this.#textItems.get(itemId);
      if (entry?.complete) return;
      if (!entry) {
        entry = { index: this.takeIndex(), text: '', complete: false };
        this.#textItems.set(itemId, entry);
        this.part(entry.index, { type: 'text', text: '' });
      }
      entry.text += text;
      this.ctx.emit.delta(this.#message(), entry.index, text);
      return;
    }
    if (this.#textIndex === null) {
      const index = this.#nextIndex;
      this.#nextIndex += 1;
      this.#textIndex = index;
      this.#thinkingIndex = null;
      this.part(index, { type: 'text', text: '' });
    }
    this.ctx.emit.delta(this.#message(), this.#textIndex, text);
  }

  completeText(itemId: string, text: string): void {
    const entry = this.#textItems.get(itemId) ?? { index: this.takeIndex(), text: '', complete: false };
    if (entry.complete) return;
    entry.text = text; entry.complete = true;
    this.#textItems.set(itemId, entry);
    this.part(entry.index, { type: 'text', text, complete: true });
  }

  /** A thinking part is open: its deltas already report the `thinking` phase. */
  get thinkingOpen(): boolean {
    return this.#thinkingIndex !== null;
  }

  /**
   * The reasoning deltas, which the UI folds. Their own part, like the text.
   * `section` names the reasoning item and its summary or content index: the
   * server streams each section with no newline around it, so a delta of a new
   * section that lands in the same part starts after a blank line.
   */
  writeThinking(text: string, section?: string): void {
    if (text.length === 0) return;
    if (this.#thinkingIndex === null) {
      const index = this.#nextIndex;
      this.#nextIndex += 1;
      this.#thinkingIndex = index;
      this.#textIndex = null;
      this.part(index, { type: 'thinking', text: '' });
    } else if (section !== undefined && this.#thinkingSection !== null && section !== this.#thinkingSection) {
      this.ctx.emit.delta(this.#message(), this.#thinkingIndex, '\n\n');
    }
    if (section !== undefined) this.#thinkingSection = section;
    this.ctx.emit.delta(this.#message(), this.#thinkingIndex, text);
  }

  /**
   * `item/commandExecution/outputDelta`: what a running command printed so
   * far, drawn under its card while it runs. Only the tail is kept; the
   * completed item carries the whole output anyway.
   */
  appendOutput(itemId: string, delta: string): void {
    const entry = this.#tools.get(itemId);
    if (entry === undefined || entry.status !== 'running' || delta.length === 0) return;
    const pending = entry.pending ??= { pieces: [], length: 0 };
    pending.pieces.push(delta);
    pending.length += delta.length;
    // A flood between two beats is folded early, so the pieces stay bounded.
    if (pending.length > LIVE_OUTPUT_MAX * 4) foldOutput(entry);
    this.#dirty.add(itemId);
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => this.#flushOutput(), LIVE_OUTPUT_BEAT_MS);
    this.#flushTimer.unref?.();
  }

  #flushOutput(): void {
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    for (const itemId of this.#dirty) {
      const entry = this.#tools.get(itemId);
      if (entry === undefined || entry.status !== 'running') continue;
      foldOutput(entry);
      this.#drawTool(itemId, entry);
    }
    this.#dirty.clear();
  }

  /** `item/started` opens the part, `item/completed` replaces the same one by item id. */
  upsertTool(itemId: string, view: ToolView): void {
    const entry = this.#tools.get(itemId) ?? {
      index: this.takeIndex(),
      name: view.name,
      input: null,
      output: null,
      status: 'running' as ToolStatus,
    };
    foldOutput(entry);
    entry.name = view.name;
    if (view.input !== undefined) entry.input = view.input;
    if (view.output !== null) entry.output = view.output;
    entry.status = view.status;
    if (view.exitCode !== undefined) entry.exitCode = view.exitCode;
    entry.nativeAgents = view.nativeAgents;
    this.#tools.set(itemId, entry);
    this.#dirty.delete(itemId);
    this.#drawTool(itemId, entry);
  }

  #drawTool(itemId: string, entry: ToolEntry): void {
    this.part(entry.index, {
      type: 'tool',
      toolId: itemId,
      name: entry.name,
      input: entry.input,
      output: entry.output,
      status: entry.status,
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
      ...(entry.nativeAgents ? { nativeAgents: entry.nativeAgents } : {}),
    });
  }
}
