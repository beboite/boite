/** One agy turn and the parts it draws from the steps agy reports. */
import type { MessageId, MessagePart, ToolStatus, Usage } from '@boite/contracts';
import type { TurnContext, TurnResult } from '../types.ts';
import { countOf, errorText, rowOf, textOf, type AgyUsage, type Row } from './events.ts';

/** What one tool part keeps of its output in the journal. */
const TOOL_OUTPUT_MAX = 64 * 1024;

interface ToolEntry {
  index: number;
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}

/**
 * One prompt line and what came back for it: one text part the deltas append
 * to, one part per tool step, the usage of its own `agent_response` steps.
 */
export class AgyTurn {
  private messageId: MessageId | null = null;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private readonly tools = new Map<number, ToolEntry>();
  private wroteText = false;
  private lastUsage: AgyUsage | null = null;

  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  private resolve: (result: TurnResult) => void = () => undefined;
  private decide: () => void = () => undefined;
  private wake: () => void = () => undefined;

  readonly done: Promise<TurnResult>;
  /** Resolves the moment the outcome is known, before anything is journalled. */
  readonly finished: Promise<void>;
  /** Resolves on a stop, so a turn still waiting to launch its process stops waiting. */
  readonly stopRequested: Promise<void>;

  /** agy's `conversation_id`, which the next process resumes with `--conversation`. */
  sessionId: string | null;
  usage: Usage | null = null;
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
    this.stopRequested = new Promise<void>((resolve) => {
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

  writeText(text: string): void {
    if (text.length === 0) return;
    this.wroteText = true;
    if (this.textIndex === null) {
      this.textIndex = this.takeIndex();
      this.part(this.textIndex, { type: 'text', text: '' });
    }
    this.ctx.emit.delta(this.message(), this.textIndex, text);
  }

  /** A tool step opens a part on its first update and redraws it on each later one. */
  upsertTool(stepIndex: number, view: { name: string; input: unknown; output: string | null; status: ToolStatus }): void {
    let entry = this.tools.get(stepIndex);
    if (entry === undefined) {
      entry = { index: this.takeIndex(), name: view.name, input: null, output: null, status: 'running' };
      // The text after a tool is a paragraph of its own, below the card.
      this.textIndex = null;
      this.tools.set(stepIndex, entry);
    }
    if (view.name.length > 0) entry.name = view.name;
    if (view.input !== null && view.input !== undefined) entry.input = view.input;
    if (view.output !== null) entry.output = view.output;
    entry.status = view.status;
    this.part(entry.index, {
      type: 'tool',
      toolId: `agy-${this.ctx.turn.id}-${stepIndex}`,
      name: entry.name,
      input: entry.input,
      output: entry.output,
      status: entry.status,
    });
  }

  /**
   * One finished `agent_response`. Thinking is billed as output, so it counts
   * there; the cache reads are reported apart from the input, as agy does.
   */
  addUsage(usage: AgyUsage): void {
    const base = this.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: null };
    this.usage = {
      inputTokens: base.inputTokens + countOf(usage.input_tokens),
      outputTokens: base.outputTokens + countOf(usage.output_tokens) + countOf(usage.thinking_tokens),
      cacheReadTokens: base.cacheReadTokens + countOf(usage.cache_read_tokens),
      cacheWriteTokens: 0,
      costUsdEquivalent: null,
    };
    this.lastUsage = usage;
  }

  /** `result`: the turn is over, with the answer as a fallback when nothing streamed. */
  finish(result: Row): void {
    if (this.decided) return;
    const status = textOf(result['status']);
    if (status === 'ERROR' || (status.length > 0 && status !== 'SUCCESS')) {
      const reason = errorText(result['error']);
      this.noteError(reason.length > 0 ? reason : `the Antigravity CLI ended the turn with ${status}`);
    } else if (!this.wroteText) {
      this.writeText(textOf(result['response']));
    }
    this.reportContext();
    this.settleRun();
  }

  /**
   * The context meter, from the last request of the turn: what it sent, fresh
   * and cached, plus what it answered, which the next request carries. agy
   * names no window, so there is none.
   */
  private reportContext(): void {
    const usage = this.lastUsage;
    if (usage === null) return;
    const input = countOf(usage.input_tokens);
    const cache = countOf(usage.cache_read_tokens);
    const output = countOf(usage.output_tokens);
    this.ctx.context({ tokens: input + cache + output, window: null, breakdown: { input, cache, output } });
  }

  noteError(reason: string): void {
    if (this.error !== null) return;
    this.error = reason;
    this.part(this.takeIndex(), { type: 'error', message: reason });
  }

  settleRun(): void {
    if (this.decided) return;
    if (this.error !== null) this.status = 'error';
    else if (this.isStopped) this.status = 'stopped';
    this.decided = true;
    this.decide();
  }

  /** The turn cannot go on: a dead child, a failed launch. */
  fail(reason: string): void {
    if (this.decided) return;
    this.noteError(reason);
    this.status = 'error';
    this.decided = true;
    this.decide();
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.decided = true;
    this.decide();
    if (this.messageId !== null) {
      this.ctx.emit.complete(this.messageId, this.status === 'error' ? 'error' : 'complete');
    }
    this.resolve({
      status: this.status,
      sessionId: this.sessionId,
      usage: this.usage,
      error: this.error ?? undefined,
    });
  }

  private message(): MessageId {
    if (this.messageId === null) this.messageId = this.ctx.emit.startMessage('assistant');
    return this.messageId;
  }

  private part(index: number, part: MessagePart): void {
    this.ctx.emit.part(this.message(), index, part);
  }

  private takeIndex(): number {
    const index = this.nextIndex;
    this.nextIndex += 1;
    return index;
  }
}

/** One `step_update` drawn on the running turn. Steps of the user's input and the system are not drawn. */
export function drawStep(turn: AgyTurn, step: Row): void {
  const type = textOf(step['step_type']);
  const state = textOf(step['state']);
  if (type === 'agent_response') {
    turn.writeText(textOf(step['text_delta']));
    if (state === 'DONE' && step['usage'] !== undefined) turn.addUsage(rowOf(step['usage']) as AgyUsage);
    return;
  }
  if (type !== 'tool') return;
  const stepIndex = step['step_index'];
  if (typeof stepIndex !== 'number') return;
  const info = rowOf(step['tool_info']);
  const failure = rowOf(info['error']);
  const status: ToolStatus = state === 'ERROR' ? 'error' : state === 'DONE' ? 'done' : 'running';
  // A finished step carries what the tool printed, whole: nothing streams before it.
  let output: string | null = toolOutput(info['output']);
  if (status === 'error') {
    const reason = textOf(failure['message']) || textOf(failure['type']);
    output = reason.length > 0 ? reason : (output ?? 'the tool failed');
  }
  turn.upsertTool(stepIndex, {
    name: textOf(info['name']) || textOf(step['tool_name']),
    input: info['parameters'] ?? null,
    output,
    status,
  });
}

/** `tool_info.output` is text on every tool seen so far; anything else is kept as JSON rather than dropped. */
function toolOutput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > TOOL_OUTPUT_MAX ? `${value.slice(0, TOOL_OUTPUT_MAX)}
[cut at ${TOOL_OUTPUT_MAX} characters]` : value;
  try {
    return toolOutput(JSON.stringify(value));
  } catch {
    return null;
  }
}
