import type { MessageId, MessagePart, ToolStatus, Usage } from '@boite/contracts';
import type { PromptCacheLife, TurnContext, TurnResult } from '../types.ts';
import type { PiUsage, ToolView } from './protocol.ts';

interface ToolEntry {
  index: number;
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}

/**
 * One `prompt` command and what it wrote. The parts are drawn the way every
 * other driver draws them: one text part the deltas append to, one thinking
 * part, one part per tool call.
 */
export class PiTurn {
  private messageId: MessageId | null = null;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private thinkingIndex: number | null = null;
  private readonly tools = new Map<string, ToolEntry>();

  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  private resolve: (result: TurnResult) => void = () => undefined;
  private decide: () => void = () => undefined;
  private wake: () => void = () => undefined;

  readonly done: Promise<TurnResult>;
  /** Resolves the moment the outcome is known, before anything is journalled. */
  readonly finished: Promise<void>;
  /** Resolves on `stop()`, so anything waiting on the user can move on. */
  readonly stopped: Promise<void>;

  /** The pi session id the process was launched with, kept as the thread's. */
  sessionId: string | null;
  usage: Usage | null = null;
  /** The prompt cache lifetime of the last request that named one. */
  cacheLife: PromptCacheLife | null = null;
  decided = false;
  isStopped = false;
  settled = false;
  /** The error of the last assistant message, promoted only if the run settles on it. */
  pendingError: string | null = null;
  /** Set once the stop deadline runs for this turn. */
  stopDeadline = false;
  /**
   * Set while `runTurn` waits on pi's answer to a command of its own: the
   * setup, the prompt, the state check after it. pi holds the prompt's answer
   * through its preflight, so a stop there decides the turn and nothing else
   * ends it.
   */
  awaitingPi = false;

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

  /**
   * How the last assistant message ended: its error, or null when it went well.
   * pi retries an overloaded or dropped request by itself (`auto_retry_*`) and
   * recovers from a context overflow by compacting, inside the same run, so an
   * error may still be followed by a good answer. Nothing is drawn until
   * `agent_settled`, and only the outcome standing then counts.
   */
  noteOutcome(error: string | null): void {
    this.pendingError = error;
  }

  /**
   * `agent_settled`: the run is over, whatever happened inside it. A stop wins
   * over the error of a request the stop itself cut short.
   */
  settleRun(): void {
    if (this.decided) return;
    if (this.error === null && this.pendingError !== null && !this.isStopped) {
      this.error = this.pendingError;
      this.part(this.takeIndex(), { type: 'error', message: this.error });
    }
    if (this.error !== null) this.status = 'error';
    else if (this.isStopped) this.status = 'stopped';
    this.decided = true;
    this.decide();
  }

  /** The turn cannot go on: a dead child, a refused command. */
  fail(reason: string): void {
    if (this.decided) return;
    this.decided = true;
    this.status = 'error';
    if (this.error === null) {
      this.error = reason;
      this.part(this.takeIndex(), { type: 'error', message: reason });
    }
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
      usage: this.usage,
      error: this.error ?? undefined,
      promptCache: this.cacheLife,
    });
  }

  /** pi reports usage per assistant message, so a turn is the sum of its calls. */
  addUsage(usage: PiUsage): void {
    const base = this.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdEquivalent: null,
    };
    const cost = usage.cost?.total;
    this.usage = {
      inputTokens: base.inputTokens + (usage.input ?? 0),
      outputTokens: base.outputTokens + (usage.output ?? 0),
      cacheReadTokens: base.cacheReadTokens + (usage.cacheRead ?? 0),
      cacheWriteTokens: base.cacheWriteTokens + (usage.cacheWrite ?? 0),
      costUsdEquivalent:
        typeof cost === 'number' ? (base.costUsdEquivalent ?? 0) + cost : base.costUsdEquivalent,
    };
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

  /** The reasoning deltas, which the UI folds. Their own part, like the text. */
  writeThinking(text: string): void {
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

  /** `tool_execution_start` opens the part, `tool_execution_end` replaces it. */
  upsertTool(toolCallId: string, view: ToolView): void {
    const entry = this.tools.get(toolCallId) ?? {
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
    this.tools.set(toolCallId, entry);
    this.part(entry.index, {
      type: 'tool',
      toolId: toolCallId,
      name: entry.name,
      input: entry.input,
      output: entry.output,
      status: entry.status,
    });
  }
}
