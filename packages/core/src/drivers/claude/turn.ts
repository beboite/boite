import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MessageId, MessagePart, ToolDocument, ToolStatus, Usage } from '@boite/contracts';
import type { PromptCacheLife, ToolPatch, TurnContext, TurnRefusal, TurnResult } from '../types.ts';
import { isoTime } from './diagnostics.ts';
import {
  agentTotalsOf,
  apiErrorReason,
  apiErrorStatusOf,
  cacheLifeOf,
  commandsOf,
  contentBlocks,
  contextWindowOf,
  editDocuments,
  errorSentence,
  FORBIDDEN,
  forbiddenReason,
  mapUsage,
  requestTokens,
  resultText,
  subagentOf,
} from './mapping.ts';
import type { StreamEvent } from './mapping.ts';
import { hookEndPart } from './hooks.ts';
import { PROMPT_EFFORT } from './query.ts';
import type { ClaudeSession } from './session.ts';
import { claudeProgress } from './progress.ts';

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
  /** What the CLI's `tool_use_summary` said of the batch this call ran in. */
  summary: string | null;
  /**
   * The call finished and its card was written: `input`, `output` and
   * `documents` live in the stored part only, and a later change patches it.
   */
  released: boolean;
}

type UserMessage = Extract<SDKMessage, { type: 'user' }>;

/** One block of the API message being read: what tells a progress update from reasoning. */
interface BlockEntry {
  kind: 'thinking' | 'other';
  /** The part a thinking block writes into. */
  index: number | null;
  text: string;
}

/**
 * Claude 5.1 and later write the short line they put ahead of a tool call
 * ("Now I'll check the tests.") as a thinking block, at most one per call,
 * instead of a text block. Older models write it as text.
 */
export function writesProgressAsThinking(model: string | null): boolean {
  const match = model === null ? null : /claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model);
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 5 || (major === 5 && Number(match[2] ?? 0) >= 1);
}

/** One turn: what it wrote, what it cost, and the promise the scheduler waits on. */
export class ClaudeTurn {
  private messageId: MessageId | null = null;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private thinkingIndex: number | null = null;
  private apiMessageId = '';
  /** Parts of the current API attempt, until a message_delta confirms its completion. */
  private attemptStart: number | null = null;
  private readonly tools = new Map<string, ToolEntry>();
  private readonly textBlocks = new Map<number, number>();
  private readonly thinkingBlocks = new Map<number, number>();
  /** Block index to tool id, so an `input_json_delta` reaches the part its block opened. */
  private readonly toolBlocks = new Map<number, string>();
  /**
   * The text and thinking the deltas carried for the current API message, so
   * its `assistant` frame is not written twice. The CLI yields that frame before
   * the next `message_start`, which clears them.
   */
  private streamedText = '';
  private streamedThinking = '';
  /** The API message `streamedText` and `streamedThinking` belong to. */
  private streamedFor = '';
  /** The blocks of the API message `blocksOf` names, in order, and the streamed ones by block index. */
  private blocks: BlockEntry[] = [];
  private blocksOf = '';
  /** API messages the stream opened blocks of: their snapshots log nothing again. */
  private readonly streamedIds = new Set<string>();
  private readonly streamedBlocks = new Map<number, BlockEntry>();
  /** The model the API message being read came from, as its `message_start` said. */
  private apiModel: string | null = null;

  private sessionId: string | null;
  /**
   * The uuid of the last main-chain entry the CLI wrote for this turn: an
   * assistant message, a tool result, a compaction boundary. What a later
   * rewind or fork resumes at (`resumeSessionAt`).
   */
  private lastEntry: string | null = null;
  private usage: Usage | null = null;
  private costBefore: number | null = 0;
  /** The CLI's running totals as its result for this turn left them. */
  private agentTotals: { costUsd: number; tokens: number } | null = null;
  /** What the last API request of the turn carried, the context meter's reading. */
  private contextTokens: number | null = null;
  /** The lifetime of the last cache write the main loop made in this turn. */
  private cacheLife: PromptCacheLife | null = null;
  /**
   * When the main loop's last API message started: its `message_start`, or the
   * first snapshot of a message that streamed nothing. A little after the
   * request left, by the time to the first token (`TurnResult.cacheAt`).
   */
  private requestAt: number | null = null;
  /** An `authentication_failed` frame waiting for the result that says whether it was a 401 or a 403. */
  private authFrame: { content: unknown } | null = null;
  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  /** Availability refusal the API error named: `overloaded` or a spent subscription window. */
  private refusal: TurnRefusal | undefined;
  /** When the window the CLI reported rejected resets (`rate_limit_event`), in milliseconds. */
  private rejectedUntil: number | null = null;
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
    // A keepalive keeps the word: another thinking budget would miss the cached messages.
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
      ...(this.requestAt !== null ? { cacheAt: this.requestAt } : {}),
      ...(this.sessionLost ? { sessionLost: true } : {}),
      ...(this.status === 'error' && this.refusal ? { refusal: this.refusal } : {}),
      ...(this.sessionId !== null && this.lastEntry !== null ? { checkpoint: { sessionId: this.sessionId, entry: this.lastEntry } } : {}),
      ...(this.agentTotals !== null ? { agentTotals: this.agentTotals } : {}),
    });
  }

  // -- messages -------------------------------------------------------------

  /** What the CLI process had already charged to earlier turns when this one's result arrived. */
  noteCostBefore(costUsd: number | null): void {
    this.costBefore = costUsd;
  }

  handle(message: SDKMessage): void {
    if (!this.settled) claudeProgress(this.ctx, message);
    const parent = subagentOf(message);
    if (parent !== null) {
      this.handleSubagent(message, parent);
      return;
    }
    this.noteEntry(message);
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
      case 'tool_use_summary':
        this.summarizeTools(message.preceding_tool_use_ids, message.summary);
        break;
      case 'rate_limit_event':
        this.noteRateLimit(message.rate_limit_info as { status?: unknown; resetsAt?: unknown } | null | undefined);
        break;
      default:
        break;
    }
  }

  /** Only what the transcript chains: a streamed delta, a result or an init is no entry of it. */
  private noteEntry(message: SDKMessage): void {
    const chained = message.type === 'assistant' || message.type === 'user' || (message.type === 'system' && message.subtype === 'compact_boundary');
    const uuid = (message as { uuid?: unknown }).uuid;
    if (chained && typeof uuid === 'string' && uuid.length > 0) this.lastEntry = uuid;
  }

  /**
   * `commands_changed`: the CLI relearned its slash commands mid-session.
   * `compact_boundary`: it compacted the conversation, drawn as a divider.
   * `informational` with `prevent_continuation`: one of the user's hooks ended
   * the turn, drawn as a quiet line; the CLI writes nothing else for it.
   */
  private handleSystem(message: Extract<SDKMessage, { type: 'system' }>): void {
    if (message.subtype === 'api_retry') this.discardAttempt();
    if (message.subtype === 'commands_changed') this.ctx.commands(commandsOf(message.commands));
    if (message.subtype === 'informational' && message.prevent_continuation === true) {
      this.part(this.takeIndex(), hookEndPart(message.content));
    }
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
        // Give each request its own parts so a retry can replace just its failed attempt.
        this.textIndex = null;
        this.thinkingIndex = null;
        this.attemptStart = this.nextIndex;
        this.requestAt = Date.now();
        this.apiMessageId = event.message?.id ?? '';
        this.streamedText = '';
        this.streamedThinking = '';
        this.streamedFor = this.apiMessageId;
        this.apiModel = event.message?.model ?? null;
        this.textBlocks.clear();
        this.thinkingBlocks.clear();
        this.toolBlocks.clear();
        this.streamedBlocks.clear();
        this.startBlocks(this.apiMessageId);
        break;
      case 'content_block_start': {
        const block = event.content_block;
        if (block === undefined) break;
        this.streamedIds.add(this.apiMessageId);
        if (block.type === 'thinking' && event.index !== undefined) {
          const index = this.openThinkingBlock();
          this.thinkingBlocks.set(event.index, index);
          this.streamedBlocks.set(event.index, this.logBlock('thinking', index, ''));
          break;
        }
        if (block.type === 'tool_use') this.progressBeforeTool();
        this.logBlock('other', null, '');
        if (block.type === 'text' && event.index !== undefined) this.textBlocks.set(event.index, this.openText());
        else if (block.type === 'tool_use' && typeof block.id === 'string') {
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
          const entry = event.index === undefined ? undefined : this.streamedBlocks.get(event.index);
          if (entry !== undefined) entry.text += event.delta.thinking ?? '';
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
      case 'message_delta':
        // The CLI also synthesizes message_stop when a stream is interrupted.
        if (event.delta?.stop_reason) this.attemptStart = null;
        break;
      default:
        break;
    }
  }

  /** An interrupted response is replaced on retry; earlier requests and tools remain. */
  private discardAttempt(): void {
    const start = this.attemptStart;
    if (start === null) return;
    for (let index = start; index < this.nextIndex; index += 1) this.part(index, { type: 'text', text: '' });
    for (const [id, tool] of this.tools) if (tool.index >= start) this.tools.delete(id);
    this.nextIndex = start;
    this.textIndex = null;
    this.thinkingIndex = null;
    this.attemptStart = null;
  }

  private streamContent(kind: 'text' | 'thinking', blockIndex: number | undefined, text: string): void {
    if (!text.length) return;
    const blocks = kind === 'text' ? this.textBlocks : this.thinkingBlocks;
    const known = blockIndex === undefined ? undefined : blocks.get(blockIndex);
    const index = known ?? (kind === 'text' ? this.openText() : this.openThinking());
    if (blockIndex !== undefined) blocks.set(blockIndex, index);
    this.write(index, text);
    if (kind === 'text') this.streamedText += text;
    else this.streamedThinking += text;
  }

  /** What the deltas carried for API message `apiId`: nothing once another message started. */
  private streamed(kind: 'text' | 'thinking', apiId: string): string {
    if (apiId !== this.streamedFor) return '';
    return kind === 'text' ? this.streamedText : this.streamedThinking;
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

  /** A rejected window's reset, kept for a usage limit failure that follows; an allowed one clears it. */
  private noteRateLimit(info: { status?: unknown; resetsAt?: unknown } | null | undefined): void {
    if (info === null || info === undefined) return;
    if (info.status === 'allowed') { this.rejectedUntil = null; return; }
    if (info.status !== 'rejected') return;
    const at = isoTime(info.resetsAt);
    if (at !== null) this.rejectedUntil = Date.parse(at);
  }

  private handleAssistant(message: SDKAssistantMessage): void {
    if (message.error !== undefined) {
      const content = (message.message as { content?: unknown } | undefined)?.content;
      // The CLI says `authentication_failed` for a 403 too: the result names the status.
      if (message.error === 'authentication_failed') {
        if (apiErrorStatusOf(message) === FORBIDDEN) this.fail(forbiddenReason(apiErrorReason('unknown', content)));
        else this.authFrame = { content };
        return;
      }
      if (this.status !== 'error') this.refusal = message.error === 'overloaded' ? { kind: 'capacity' } : message.error === 'rate_limit' ? { kind: 'usage-limit', resetsAt: this.rejectedUntil } : undefined;
      this.fail(apiErrorReason(message.error, content));
      return;
    }
    const body = message.message as { id?: string; model?: string; content?: unknown; usage?: unknown } | undefined;
    const apiId = body?.id ?? '';
    // A streamed message logged its blocks as they opened; a snapshot alone logs them here.
    const logs = !this.streamedIds.has(apiId);
    if (logs && apiId !== this.blocksOf) {
      this.startBlocks(apiId);
      this.apiModel = body?.model ?? null;
      this.requestAt = Date.now();
    }
    const carried = requestTokens(body?.usage);
    if (carried !== null) this.contextTokens = carried;
    this.cacheLife = cacheLifeOf(body?.usage) ?? this.cacheLife;
    for (const block of contentBlocks(body?.content)) {
      if (block.type === 'text') {
        const text = block.text ?? '';
        // With includePartialMessages the deltas already carried this block.
        if (text.length === 0 || this.streamed('text', apiId).includes(text)) continue;
        if (logs) this.logBlock('other', null, text);
        this.write(this.openText(), text);
        continue;
      }
      if (block.type === 'thinking') {
        const thinking = block.thinking ?? '';
        // Same dedupe as text: the deltas already carried this block.
        if (thinking.length === 0 || this.streamed('thinking', apiId).includes(thinking)) continue;
        const index = this.openThinkingBlock();
        if (logs) this.logBlock('thinking', index, thinking);
        this.write(index, thinking);
        continue;
      }
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        if (logs && !this.tools.has(block.id)) {
          this.progressBeforeTool();
          this.logBlock('other', null, '');
        }
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
    this.agentTotals = agentTotalsOf(message);
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
    const auth = this.authFrame;
    this.authFrame = null;
    if (auth !== null) {
      this.fail(apiErrorStatusOf(message) === FORBIDDEN
        ? forbiddenReason(message.subtype === 'success' && message.result.length > 0 ? message.result : apiErrorReason('unknown', auth.content))
        : apiErrorReason('authentication_failed', auth.content));
    }
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
    // A resume cut at an entry (a rewind or a fork) that failed before writing
    // anything: whatever the CLI's words, the core must not keep the whole
    // session, which still holds the part the user removed. It starts fresh
    // with the kept history instead.
    if (this.ctx.resumeAt) return message.errors.length > 0 ? message.errors.join('; ') : 'the agent could not resume its session at the cut';
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

  private startBlocks(apiId: string): void {
    this.blocks = [];
    this.blocksOf = apiId;
  }

  private logBlock(kind: BlockEntry['kind'], index: number | null, text: string): BlockEntry {
    const entry = { kind, index, text };
    this.blocks.push(entry);
    return entry;
  }

  /**
   * A thinking block's part. A model that writes its progress updates as
   * thinking gets one part per block, so the update can turn into text without
   * taking the reasoning before it along; other models keep consecutive blocks
   * in one part.
   */
  private openThinkingBlock(): number {
    if (writesProgressAsThinking(this.apiModel ?? this.ctx.thread.model)) this.thinkingIndex = null;
    return this.openThinking();
  }

  /**
   * A tool call opens: when the two blocks before it in the same API message
   * are non-empty thinking, on a model that writes its progress updates that
   * way, the second is that update, not reasoning. Its part becomes text in
   * place, so it reads as the agent's narration between tool calls. One
   * thinking block alone before a call is real reasoning and stays folded.
   */
  private progressBeforeTool(): void {
    const [before, last] = this.blocks.slice(-2);
    if (before?.kind !== 'thinking' || last?.kind !== 'thinking' || last.index === null) return;
    if (before.text.trim().length === 0 || last.text.trim().length === 0) return;
    if (!writesProgressAsThinking(this.apiModel ?? this.ctx.thread.model)) return;
    this.part(last.index, { type: 'text', text: last.text });
    // The text the next block writes must not land in this part.
    this.textIndex = null;
    this.thinkingIndex = null;
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
    // A streamed input is half-typed JSON: there is nothing to read a diff out
    // of until the parsed object lands, and then it lands whole.
    const documents = inputText === null ? editDocuments(name, input) : null;
    entry.name = name;
    entry.inputText = inputText;
    this.tools.set(toolId, entry);
    if (entry.released) {
      // The result came first (a replayed or adopted call): the card keeps its output.
      this.patchTool(entry, {
        name, input, inputText,
        ...(documents === null ? {} : { documents: documents.length > 0 ? documents : undefined }),
      });
      return;
    }
    entry.input = input;
    if (documents !== null) entry.documents = documents;
    this.emitTool(toolId, entry);
  }

  /** The tool's card already carries its parsed input. */
  hasParsedTool(toolId: string): boolean {
    const entry = this.tools.get(toolId);
    return entry !== undefined && entry.inputText === null;
  }

  finishTool(toolId: string, output: string, status: ToolStatus): void {
    const entry = this.tools.get(toolId) ?? this.newTool(toolId);
    entry.status = status;
    this.tools.set(toolId, entry);
    if (entry.released) {
      this.patchTool(entry, { output, status });
      return;
    }
    entry.output = output;
    this.emitTool(toolId, entry);
    // The stored part holds the call now; a screenshot's base64 or a written
    // file is not kept a second time for the rest of the turn.
    if (status !== 'running') {
      entry.released = true;
      entry.input = null;
      entry.output = null;
      entry.documents = [];
    }
  }

  private patchTool(entry: ToolEntry, fields: ToolPatch): void {
    if (this.settled || this.messageId === null) return;
    this.ctx.emit.patchTool(this.messageId, entry.index, fields);
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
      summary: null,
      released: false,
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
      ...(entry.summary === null ? {} : { summary: entry.summary }),
    });
  }

  /**
   * `tool_use_summary`: a line the CLI writes once a batch of calls finished
   * (`CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`), naming the calls it covers. Each
   * card it names carries it; the timeline reads it as the batch's label. A call
   * of an earlier turn on the same warm query is not this turn's to redraw.
   */
  private summarizeTools(toolIds: readonly string[], summary: string): void {
    const text = summary.trim();
    if (text.length === 0) return;
    for (const toolId of toolIds) {
      const entry = this.tools.get(toolId);
      if (entry === undefined || entry.summary === text) continue;
      entry.summary = text;
      if (entry.released) this.patchTool(entry, { summary: text });
      else this.emitTool(toolId, entry);
    }
  }

  fail(reason: string): void {
    if (this.status === 'error') return;
    // A CLI gone before the result of its `authentication_failed` frame: that frame is the cause.
    const auth = this.authFrame;
    this.authFrame = null;
    if (auth !== null) reason = apiErrorReason('authentication_failed', auth.content);
    this.status = 'error';
    this.error = reason;
    this.part(this.takeIndex(), { type: 'error', message: reason });
  }
}
