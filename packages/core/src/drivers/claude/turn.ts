import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MessageId, MessagePart, ToolDocument, ToolStatus, Usage } from '@boite/contracts';
import type { PromptCacheLife, TurnContext, TurnResult } from '../types.ts';
import {
  cacheLifeOf,
  commandsOf,
  contentBlocks,
  contextWindowOf,
  editDocuments,
  errorSentence,
  mapUsage,
  requestTokens,
  resultText,
  subagentOf,
} from './mapping.ts';
import type { StreamEvent } from './mapping.ts';
import { PROMPT_EFFORT } from './query.ts';
import type { ClaudeSession } from './session.ts';

/** What the CLI answers a `resume` whose transcript is gone (CLI 2.1.282, probed offline). */
const MISSING_SESSION = /^No conversation found with session ID: /;

interface ToolEntry {
  index: number;
  name: string;
  input: unknown;
  /** The JSON of `input` while the model types it; null once the parsed input has landed. */
  inputText: string | null;
  output: string | null;
  status: ToolStatus;
  documents: ToolDocument[];
}

type UserMessage = Extract<SDKMessage, { type: 'user' }>;

/** One turn: what it wrote, what it cost, and the promise the scheduler waits on. */
export class ClaudeTurn {
  private messageId: MessageId | null = null;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private thinkingIndex: number | null = null;
  private apiMessageId = '';
  private readonly tools = new Map<string, ToolEntry>();
  private readonly textBlocks = new Map<number, number>();
  private readonly thinkingBlocks = new Map<number, number>();
  /** Block index to tool id, so an `input_json_delta` reaches the part its block opened. */
  private readonly toolBlocks = new Map<number, string>();
  private readonly streamedText = new Map<string, string>();
  private readonly streamedThinking = new Map<string, string>();

  private sessionId: string | null;
  private usage: Usage | null = null;
  private costBefore = 0;
  /** What the last API request of the turn carried, the context meter's reading. */
  private contextTokens: number | null = null;
  /** The lifetime of the last cache write the main loop made in this turn. */
  private cacheLife: PromptCacheLife | null = null;
  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  private resolve: (result: TurnResult) => void = () => undefined;
  private wake: () => void = () => undefined;

  readonly done: Promise<TurnResult>;
  /** Resolves on a stop and on the settle, so a card still waiting can answer "cancelled". */
  readonly stopped: Promise<void>;
  isStopped = false;
  settled = false;
  /** The CLI refused to resume: the transcript this turn asked for is gone. */
  sessionLost = false;
  /** The session holding it right now: a stranded turn moves to another one. */
  session: ClaudeSession | null = null;

  constructor(readonly ctx: TurnContext) {
    this.sessionId = ctx.sessionId;
    this.done = new Promise<TurnResult>((resolve) => {
      this.resolve = resolve;
    });
    this.stopped = new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  /** `ultrathink` is not an option of the CLI: the word in the prompt is what asks for it. */
  promptText(): string {
    const text = this.ctx.prompt;
    if (this.ctx.turn.execution?.operation === 'compact') return text;
    if (this.ctx.thread.effort !== PROMPT_EFFORT) return text;
    return text.length === 0 ? PROMPT_EFFORT : `${text} ${PROMPT_EFFORT}`;
  }

  noteSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  markStopped(): void {
    this.isStopped = true;
    this.wake();
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.wake();
    if (this.isStopped) this.status = 'stopped';
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

  // -- messages -------------------------------------------------------------

  /** What the CLI process had already charged to earlier turns when this one's result arrived. */
  noteCostBefore(costUsd: number): void {
    this.costBefore = costUsd;
  }

  handle(message: SDKMessage): void {
    const parent = subagentOf(message);
    if (parent !== null) {
      this.handleSubagent(message, parent);
      return;
    }
    switch (message.type) {
      case 'stream_event':
        this.handleStream(message.event as StreamEvent);
        break;
      case 'assistant':
        this.handleAssistant(message);
        break;
      case 'user':
        this.handleUser(message);
        break;
      case 'result':
        this.handleResult(message);
        break;
      case 'system':
        this.handleSystem(message);
        break;
      default:
        break;
    }
  }

  /**
   * `commands_changed`: the CLI relearned its slash commands mid-session.
   * `compact_boundary`: it compacted the conversation, drawn as a divider.
   */
  private handleSystem(message: Extract<SDKMessage, { type: 'system' }>): void {
    if (message.subtype === 'commands_changed') this.ctx.commands(commandsOf(message.commands));
    if (message.subtype === 'compact_boundary') {
      const meta = message.compact_metadata;
      this.part(this.takeIndex(), {
        type: 'compaction',
        trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
        preTokens: meta.pre_tokens,
        postTokens: typeof meta.post_tokens === 'number' ? meta.post_tokens : null,
      });
    }
  }

  private handleStream(event: StreamEvent): void {
    switch (event.type) {
      case 'message_start':
        this.apiMessageId = event.message?.id ?? '';
        this.textBlocks.clear();
        this.thinkingBlocks.clear();
        this.toolBlocks.clear();
        break;
      case 'content_block_start': {
        const block = event.content_block;
        if (block === undefined) break;
        if (block.type === 'text' && event.index !== undefined) this.textBlocks.set(event.index, this.openText());
        else if (block.type === 'thinking' && event.index !== undefined) {
          this.thinkingBlocks.set(event.index, this.openThinking());
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          // The input arrives as `input_json_delta` after this: an empty object now,
          // and an empty `inputText` the deltas grow until the parsed input lands.
          if (event.index !== undefined) this.toolBlocks.set(event.index, block.id);
          this.upsertTool(block.id, block.name ?? 'tool', block.input ?? {}, '');
        }
        // `redacted_thinking` carries no readable text: nothing to show.
        break;
      }
      case 'content_block_delta': {
        // `signature_delta` signs the thinking block; it is not text.
        if (event.delta?.type === 'thinking_delta') {
          this.streamContent('thinking', event.index, event.delta.thinking ?? '');
          break;
        }
        if (event.delta?.type === 'input_json_delta') {
          const partial = event.delta.partial_json ?? '';
          if (partial.length === 0 || event.index === undefined) break;
          const toolId = this.toolBlocks.get(event.index);
          const entry = toolId === undefined ? undefined : this.tools.get(toolId);
          if (entry === undefined) break;
          entry.inputText = (entry.inputText ?? '') + partial;
          this.write(entry.index, partial);
          break;
        }
        if (event.delta?.type !== 'text_delta') break;
        this.streamContent('text', event.index, event.delta.text ?? '');
        break;
      }
      default:
        break;
    }
  }

  private streamContent(kind: 'text' | 'thinking', blockIndex: number | undefined, text: string): void {
    if (!text.length) return;
    const blocks = kind === 'text' ? this.textBlocks : this.thinkingBlocks;
    const accumulated = kind === 'text' ? this.streamedText : this.streamedThinking;
    const known = blockIndex === undefined ? undefined : blocks.get(blockIndex);
    const index = known ?? (kind === 'text' ? this.openText() : this.openThinking());
    if (blockIndex !== undefined) blocks.set(blockIndex, index);
    this.write(index, text);
    accumulated.set(this.apiMessageId, (accumulated.get(this.apiMessageId) ?? '') + text);
  }

  /**
   * What a subagent (the Agent or Task tool) writes, tagged with the tool call
   * that runs it. Its text, thinking and tool calls are its own conversation,
   * which the main message does not show, as an imported transcript drops the
   * sidechain too; the Agent tool's own result is what the main loop reads. Its
   * usage is not the thread's context, and an API error it hits is its own:
   * the main loop recovers or fails on its own result.
   */
  private handleSubagent(message: SDKMessage, parentToolId: string): void {
    if (message.type !== 'assistant' || message.error === undefined) return;
    this.ctx.log('warn', `claude: the subagent of ${parentToolId} hit an error: ${errorSentence(message.error)}`);
  }

  private handleAssistant(message: SDKAssistantMessage): void {
    if (message.error !== undefined) {
      this.fail(errorSentence(message.error));
      return;
    }
    const body = message.message as { id?: string; content?: unknown; usage?: unknown } | undefined;
    const apiId = body?.id ?? '';
    const carried = requestTokens(body?.usage);
    if (carried !== null) this.contextTokens = carried;
    this.cacheLife = cacheLifeOf(body?.usage) ?? this.cacheLife;
    for (const block of contentBlocks(body?.content)) {
      if (block.type === 'text') {
        const text = block.text ?? '';
        // With includePartialMessages the deltas already carried this block.
        if (text.length === 0 || (this.streamedText.get(apiId) ?? '').includes(text)) continue;
        this.write(this.openText(), text);
        continue;
      }
      if (block.type === 'thinking') {
        const thinking = block.thinking ?? '';
        // Same dedupe as text: the deltas already carried this block.
        if (thinking.length === 0 || (this.streamedThinking.get(apiId) ?? '').includes(thinking)) continue;
        this.write(this.openThinking(), thinking);
        continue;
      }
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        this.upsertTool(block.id, block.name ?? 'tool', block.input ?? {});
      }
    }
  }

  private handleUser(message: UserMessage): void {
    const body = message.message as { content?: unknown } | undefined;
    for (const block of contentBlocks(body?.content)) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      this.finishTool(block.tool_use_id, resultText(block.content), block.is_error === true ? 'error' : 'done');
    }
  }

  private handleResult(message: SDKResultMessage): void {
    this.usage = mapUsage(message, this.costBefore);
    if (this.contextTokens !== null) {
      this.ctx.context({ tokens: this.contextTokens, window: contextWindowOf(message, this.ctx.thread.model) });
    }
    const refused = this.resumeRefused(message);
    if (refused !== null) {
      // No error part: the core starts a fresh session and runs the turn again,
      // so the conversation shows the answer, not the refusal.
      this.sessionLost = true;
      this.status = 'error';
      this.error = refused;
      return;
    }
    // The CLI answers an interrupt with an error result (`error_during_execution`,
    // `[ede_diagnostic] ...`): that is the stop the user asked for, not a failure.
    // An aborted result Boite did not ask for still fails below.
    if (this.isStopped) return;
    if (message.subtype !== 'success') {
      this.fail(message.errors.length > 0 ? message.errors.join('; ') : message.subtype);
    } else if (message.is_error) {
      this.fail(message.result.length > 0 ? message.result : 'the turn ended on an API error');
    }
  }

  /**
   * The one refusal that means the native session is gone for good: a resume
   * whose transcript the CLI cannot find, before the turn wrote anything. Any
   * other failure keeps the session.
   */
  private resumeRefused(message: SDKResultMessage): string | null {
    if (message.subtype !== 'error_during_execution' || this.ctx.sessionId === null || this.messageId !== null) return null;
    return message.errors.some((error) => MISSING_SESSION.test(error)) ? message.errors.join('; ') : null;
  }

  // -- parts ----------------------------------------------------------------

  private message(): MessageId {
    if (this.messageId === null) this.messageId = this.ctx.emit.startMessage('assistant');
    return this.messageId;
  }

  /**
   * Nothing is drawn once the turn has settled: `message.completed` and
   * `turn.finished` are already out, so a part written here lands behind both
   * and reopens a closed message. What used to write one is the `canUseTool`
   * continuation of a CLI that died with its card open.
   */
  part(index: number, part: MessagePart): void {
    if (this.settled) return;
    this.ctx.emit.part(this.message(), index, part);
  }

  /** The same guard as `part`, for the text and thinking the stream appends. */
  private write(index: number, text: string): void {
    if (this.settled) return;
    this.ctx.emit.delta(this.message(), index, text);
  }

  private openText(): number {
    if (this.textIndex !== null) return this.textIndex;
    const index = this.takeIndex();
    this.textIndex = index;
    this.part(index, { type: 'text', text: '' });
    return index;
  }

  /** The reasoning of one block, folded in the UI. Text after it opens its own part. */
  private openThinking(): number {
    if (this.thinkingIndex !== null) return this.thinkingIndex;
    const index = this.takeIndex();
    this.thinkingIndex = index;
    this.part(index, { type: 'thinking', text: '' });
    return index;
  }

  takeIndex(): number {
    this.textIndex = null;
    this.thinkingIndex = null;
    const index = this.nextIndex;
    this.nextIndex += 1;
    return index;
  }

  /**
   * `inputText` is the streamed JSON: an empty string when the block opens, null
   * once `input` is the parsed object, which is what makes the card switch over.
   */
  upsertTool(toolId: string, name: string, input: unknown, inputText: string | null = null): void {
    const entry = this.tools.get(toolId) ?? this.newTool(name);
    entry.name = name;
    entry.input = input;
    entry.inputText = inputText;
    // A streamed input is half-typed JSON: there is nothing to read a diff out
    // of until the parsed object lands, and then it lands whole.
    if (inputText === null) entry.documents = editDocuments(name, input);
    this.tools.set(toolId, entry);
    this.emitTool(toolId, entry);
  }

  /** The tool's card already carries its parsed input. */
  hasParsedTool(toolId: string): boolean {
    const entry = this.tools.get(toolId);
    return entry !== undefined && entry.inputText === null;
  }

  finishTool(toolId: string, output: string, status: ToolStatus): void {
    const entry = this.tools.get(toolId) ?? this.newTool(toolId);
    entry.output = output;
    entry.status = status;
    this.tools.set(toolId, entry);
    this.emitTool(toolId, entry);
  }

  private newTool(name: string): ToolEntry {
    return {
      index: this.takeIndex(),
      name,
      input: {},
      inputText: null,
      output: null,
      status: 'running',
      documents: [],
    };
  }

  private emitTool(toolId: string, entry: ToolEntry): void {
    this.part(entry.index, {
      type: 'tool',
      toolId,
      name: entry.name,
      input: entry.input,
      inputText: entry.inputText,
      output: entry.output,
      status: entry.status,
      ...(entry.documents.length > 0 ? { documents: entry.documents } : {}),
    });
  }

  fail(reason: string): void {
    if (this.status === 'error') return;
    this.status = 'error';
    this.error = reason;
    this.part(this.takeIndex(), { type: 'error', message: reason });
  }
}
