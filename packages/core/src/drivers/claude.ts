import type {
  CanUseTool,
  EffortLevel,
  HookInput,
  HookJSONOutput,
  Options,
  PermissionResult,
  Query,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SlashCommand,
  SpawnOptions as SdkSpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentCommand,
  BackgroundTask,
  ModelInfo,
  ImageAttachment,
  MessageId,
  MessagePart,
  PermissionMode,
  QuestionAnswer,
  ThreadId,
  ToolDocument,
  ToolStatus,
  Usage,
} from '@boite/contracts';
import { messageOf, unavailable } from '../errors.ts';
import type { SpawnedChild } from '../procs.ts';
import { profileFor, resolveExecutable } from '../providers/resolve.ts';
import { titleRequest } from '../titles.ts';
import type { ProbeContext, ProbeResult, Driver, PromptCacheLife, TitleContext, TurnContext, TurnHandle, TurnResult } from './types.ts';

/** How long `stop()` lets the CLI end its turn before the abort signal takes it. */
const STOP_GRACE_MS = 3_000;
/** How long the CLI has to exit on its own once the prompt stream is over. */
const FINISH_GRACE_MS = 5_000;
const STDERR_MAX = 400;
const DENIED = 'Denied in Boite';
const MINUTE_MS = 60_000;
/**
 * How long a session with nothing left in the background waits for the CLI to
 * go on by itself (it reads the task's notification and answers it) before the
 * usual idle or close rule applies.
 */
const LINGER_MS = 15_000;
/** What a session keeps of the output the CLI writes with no turn attached, until one is. */
const ORPHANS_MAX = 5_000;
/** The system message a turn the agent opened on its own starts with. */
const WAKE_TEXT = 'Background work finished';
/** What the CLI answers a `resume` whose transcript is gone (CLI 2.1.282, probed offline). */
const MISSING_SESSION = /^No conversation found with session ID: /;

/** The effort levels the SDK takes as an option; see `Options['effort']`. */
const SDK_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The one level the CLI has no option for: it is a word in the prompt. */
const PROMPT_EFFORT = 'ultrathink';
/** What writes a thread's title: the CLI's alias for its smallest current model. */
const TITLE_MODEL = 'haiku';
/** How long one title call may take before its CLI is aborted. */
const TITLE_TIMEOUT_MS = 30_000;

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface ClaudeDeps {
  /** Resolved on the first turn: importing the SDK costs about 69 MB of resident memory. */
  loadQuery: () => Promise<QueryFn>;
}

/**
 * The three things a running `query()` can be told to change, as the SDK takes
 * them: `setModel`, `applyFlagSettings({ effortLevel })` and
 * `setPermissionMode`. A session remembers the last one it applied, so a turn
 * on a warm query only sends what actually moved. None of the three is in the
 * session key, which is what lets the CLI live across the change; the one thing
 * the key still holds is whether the mode is `bypassPermissions`, because that
 * one rides on a query-start option no setter can reach (`sessionKey`).
 */
export interface LiveSetup {
  model: string | null;
  /**
   * Null is the model's own default, and both cases land there: a thread with
   * no effort, and `ultrathink`, which is a word in the prompt and no option at
   * all. `applyFlagSettings` takes null as "clear it from the flag layer", so
   * the drift back to the default is one call like any other.
   */
  effortLevel: EffortLevel | null;
  permissionMode: PermissionMode;
}

/** What this turn asks the running query to be, whatever the last one asked for. */
export function liveSetup(thread: { model: string | null; effort: string | null; permissionMode: PermissionMode }): LiveSetup {
  const effort = thread.effort;
  return {
    model: thread.model,
    effortLevel: effort !== null && SDK_EFFORTS.includes(effort) ? (effort as EffortLevel) : null,
    permissionMode: thread.permissionMode,
  };
}

/** The JSON boundary: the SDK types these through the Anthropic API package. */
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface StreamEvent {
  type: string;
  index?: number;
  message?: { id?: string };
  content_block?: ContentBlock;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
}

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

/** The SDK's `SlashCommand` as the contract's `AgentCommand`: an empty field becomes null. */
function commandsOf(list: SlashCommand[]): AgentCommand[] {
  return list.map((command) => ({
    name: command.name,
    description: command.description || null,
    hint: command.argumentHint || null,
  }));
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The diffs a file-writing tool's parsed input already carries, so the card
 * shows the change without waiting for the tool result. `Edit` is one diff,
 * `Write` a diff against nothing, `MultiEdit` one diff per edit on the same
 * path. A tool whose input is still streaming has no parsed object to read, and
 * no other Claude tool describes a file change in its input.
 */
function editDocuments(name: string, input: unknown): ToolDocument[] {
  if (typeof input !== 'object' || input === null) return [];
  const record = input as Record<string, unknown>;
  const path = stringField(record, 'file_path');
  if (path === null || path.length === 0) return [];
  if (name === 'Edit') {
    const oldText = stringField(record, 'old_string');
    const newText = stringField(record, 'new_string');
    if (oldText === null || newText === null) return [];
    return [{ kind: 'diff', path, oldText, newText }];
  }
  if (name === 'Write') {
    const content = stringField(record, 'content');
    return content === null ? [] : [{ kind: 'diff', path, oldText: '', newText: content }];
  }
  if (name !== 'MultiEdit') return [];
  const edits = record['edits'];
  if (!Array.isArray(edits)) return [];
  const documents: ToolDocument[] = [];
  for (const edit of edits) {
    if (typeof edit !== 'object' || edit === null) continue;
    const one = edit as Record<string, unknown>;
    const oldText = stringField(one, 'old_string');
    const newText = stringField(one, 'new_string');
    if (oldText === null || newText === null) continue;
    documents.push({ kind: 'diff', path, oldText, newText });
  }
  return documents;
}

type UserMessage = Extract<SDKMessage, { type: 'user' }>;
type Timer = ReturnType<typeof setTimeout>;

/**
 * The user messages of a warm session, in order. The SDK reads this once and
 * answers every message with its own `result`, so one generator carries every
 * turn of the thread until the session ends.
 */
class PromptQueue {
  private readonly items: SDKUserMessage[] = [];
  private notify: (() => void) | null = null;
  private ended = false;

  push(text: string, attachments: ImageAttachment[]): void {
    const content =
      attachments.length === 0
        ? text
        : [
            { type: 'text', text },
            ...attachments.map((attachment) => ({
              type: 'image',
              source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data },
            })),
          ];
    this.items.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }

  private wake(): void {
    const notify = this.notify;
    this.notify = null;
    notify?.();
  }
}

/** One turn: what it wrote, what it cost, and the promise the scheduler waits on. */
class ClaudeTurn {
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

/** What the driver has to do for a session that ends, and for turns it hands back. */
interface SessionHooks {
  ended(session: ClaudeSession): void;
  /** Turns this query cannot serve: they go on a session started with their own setup. */
  stranded(turns: ClaudeTurn[]): void;
}

/**
 * One `query()` and one prompt stream for a thread. With `warmProcessMinutes`
 * at zero it lives for one turn, which is what the driver did before warm
 * sessions existed; above zero it takes the next turns of the thread too, and
 * only an idle window, a stop, a changed setup or the core going down ends it.
 * A changed model, effort or permission mode is not a changed setup: the SDK
 * has a setter for each of the three, so the CLI takes the new one in place.
 * The one exception is a move in or out of `bypassPermissions`, which needs a
 * query-start option and therefore a new query (`sessionKey`).
 */
class ClaudeSession {
  private readonly abortController = new AbortController();
  private readonly prompts = new PromptQueue();
  private readonly timers = new Set<Timer>();
  private readonly waiting: ClaudeTurn[] = [];
  /** What the CLI runs in the background, as its last `background_tasks_changed` said. */
  private background: BackgroundTask[] = [];
  /** `task_started` by task id: the tool call that launched it and when. */
  private readonly launched = new Map<string, { toolId: string | null; startedAt: number }>();
  /** What the CLI wrote with no turn attached, replayed into the turn the core opens for it. */
  private orphans: SDKMessage[] = [];
  /** The core was asked for a turn for the orphans and has not attached one yet. */
  private woken = false;
  /**
   * Results still owed to a run the CLI started by itself, which a user's turn
   * took over before that run finished: they close that run, not the turn.
   */
  private foreignResults = 0;
  private linger: Timer | null = null;

  private query: Query | null = null;
  private ctx: TurnContext;
  private sessionId: string | null;
  private idle: Timer | null = null;
  private started = false;
  private closing = false;
  private ended = false;
  /** The last `total_cost_usd` this CLI process reported, which the next result includes. */
  private costSoFar = 0;
  /** A resumed session's earlier turns, until the first result says whether the CLI restored them. */
  private carried: { costUsd: number; tokens: number } | null;
  /** What the query was last told to be: the options it opened on, plus every setter since. */
  private applied: LiveSetup | null = null;
  /** The setters of one turn run to the end before the next turn's, and before its prompt. */
  private pending: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly deps: ClaudeDeps,
    private readonly hooks: SessionHooks,
    ctx: TurnContext,
  ) {
    this.ctx = ctx;
    this.sessionId = ctx.sessionId;
    this.carried = ctx.sessionId === null ? null : (ctx.sessionBefore ?? null);
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
  }

  /**
   * Reusable only while the CLI is up and the turn asks for the very same
   * setup. A CLI kept for its background work is reused whatever the warm
   * setting says: starting another would kill what it runs.
   */
  usable(key: string, warmMs: number): boolean {
    return !this.ended && !this.closing && this.key === key && ((warmMs > 0 && this.warmMs > 0) || this.holding());
  }

  /** Background work, or output of the CLI's own that no turn took yet: the CLI must stay. */
  holding(): boolean {
    return this.background.length > 0 || this.woken || this.linger !== null;
  }

  /** The CLI went on by itself and wrote something the next turn is opened for. */
  adoptable(): boolean {
    return !this.ended && !this.closing && this.woken;
  }

  /** A turn is running or queued on it, so nothing may take the CLI away yet. */
  busy(): boolean {
    return this.waiting.length > 0;
  }

  attach(turn: ClaudeTurn, warmMs: number): void {
    this.warmMs = warmMs;
    this.ctx = turn.ctx;
    this.clearIdle();
    this.clearLinger();
    this.waiting.push(turn);
    if (this.woken) {
      // The turn opened for what the CLI writes on its own takes that output
      // and sends no prompt; any other turn takes it first, without its result.
      this.woken = false;
      const adopted = turn.ctx.turn.execution?.operation === 'background';
      const replay = this.orphans;
      this.orphans = [];
      for (const message of replay) {
        if (!adopted && message.type === 'result') continue;
        this.receive(message);
      }
      if (adopted) return;
      // The CLI's own run is still going: its result is not this turn's.
      if (!replay.some(message => message.type === 'result')) this.foreignResults += 1;
    } else {
      // Bookkeeping that no output followed was already applied as it came.
      this.orphans = [];
      if (turn.ctx.turn.execution?.operation === 'background') {
        // Nothing to adopt: whatever woke the core is already gone.
        this.waiting.pop();
        turn.settle();
        this.afterTurns();
        return;
      }
    }
    if (!this.started) {
      this.started = true;
      // The options the query opens on are this turn's: nothing to apply yet.
      this.applied = liveSetup(turn.ctx.thread);
      this.prompts.push(turn.promptText(), turn.ctx.attachments);
      void this.run(turn);
      return;
    }
    // A warm query takes a changed model, effort or mode through the SDK's own
    // setters, and this turn's prompt only goes in once they landed. The chain
    // keeps the prompts in the order the turns attached.
    this.pending = this.pending.then(() => this.follow(turn));
  }

  /** A turn on a warm query: its setup first, its prompt after, or it moves house. */
  private async follow(turn: ClaudeTurn): Promise<void> {
    if (turn.isStopped || this.closing || this.ended) return;
    // The query is built after the SDK import: a turn that arrives during it
    // would otherwise send its prompt with nothing applied.
    await this.ready;
    if (turn.isStopped || this.closing || this.ended) return;
    if (!(await this.applyLive(turn))) return;
    if (turn.isStopped || this.closing || this.ended) return;
    this.prompts.push(turn.promptText(), turn.ctx.attachments);
  }

  /**
   * The thread's model, effort and permission mode on a query that is already
   * up. Each one goes out only when it moved, through the setter that changes
   * it in place, so nothing is sent on a turn that changed nothing. False means
   * the turn is no longer this session's.
   */
  private async applyLive(turn: ClaudeTurn): Promise<boolean> {
    const query = this.query;
    const applied = this.applied;
    if (query === null || applied === null) return true;
    const wanted = liveSetup(turn.ctx.thread);
    const live = { ...applied };
    try {
      if (wanted.model !== live.model) {
        // `undefined` is the SDK's "back to the default model".
        await query.setModel(wanted.model ?? undefined);
        live.model = wanted.model;
      }
      if (wanted.effortLevel !== live.effortLevel) {
        // Null clears the level from the flag layer: the model's own default,
        // which is what a thread with no effort and `ultrathink` both want.
        await query.applyFlagSettings({ effortLevel: wanted.effortLevel });
        live.effortLevel = wanted.effortLevel;
      }
      if (wanted.permissionMode !== live.permissionMode) {
        // Never a move in or out of `bypassPermissions`: that one is in the
        // session key, so such a turn never reaches a query opened on the other
        // side of it.
        await query.setPermissionMode(wanted.permissionMode);
        live.permissionMode = wanted.permissionMode;
      }
    } catch (error) {
      this.applied = live;
      this.strand(turn, messageOf(error));
      return false;
    }
    this.applied = live;
    return true;
  }

  /**
   * A setter the CLI refused. That query keeps the setup it opened on, so it
   * cannot serve this turn: it ends, and the driver puts this turn and
   * everything queued behind it on a query started with the new setup, which is
   * what a changed model did before the setters existed. One warning, never a
   * failed turn.
   */
  private strand(turn: ClaudeTurn, reason: string): void {
    const at = this.waiting.indexOf(turn);
    const moved = at < 0 ? [turn] : this.waiting.splice(at);
    turn.ctx.log('warn', `claude: the warm session refused the new setup (${reason}); starting a new one`);
    this.close(null);
    this.hooks.stranded(moved);
  }

  stopTurn(turn: ClaudeTurn): void {
    if (turn.settled) return;
    turn.markStopped();
    const index = this.waiting.indexOf(turn);
    if (index < 0) {
      turn.settle();
      return;
    }
    // A turn the CLI has not reached yet leaves the queue on its own; the running
    // one is interrupted, and a stopped turn always ends the session with it.
    if (index > 0) {
      this.waiting.splice(index, 1);
      turn.settle();
      return;
    }
    const running = this.query;
    if (running !== null) void running.interrupt().catch(() => undefined);
    this.close(null, STOP_GRACE_MS);
  }

  /** Archive, shutdown, a changed setup: end the CLI and settle whatever is left. */
  close(reason: string | null, graceMs = FINISH_GRACE_MS): void {
    if (this.closing || this.ended) return;
    this.closing = true;
    this.clearIdle();
    if (reason !== null) this.ctx.log('warn', `claude session: ${reason}`);
    this.prompts.end();
    if (!this.started) {
      this.finish(null);
      return;
    }
    this.arm(graceMs, () => {
      this.abortController.abort();
      try {
        this.query?.close();
      } catch {
        // the query is already closed
      }
    });
  }

  // -- the query ------------------------------------------------------------

  private async run(first: ClaudeTurn): Promise<void> {
    try {
      const options = this.options(first.ctx);
      const queryFn = await this.deps.loadQuery();
      // Loading the SDK is the first await of the session, so a stop can land here.
      if (!first.isStopped && !this.closing) {
        this.query = queryFn({ prompt: this.prompts.stream(), options });
        // The next turn's setters have something to talk to from here on.
        this.markReady();
        // Not awaited: an older CLI that has no answer for this is one warning,
        // never a reason to hold up the turn's own messages.
        void this.query
          .supportedCommands()
          .then((commands) => this.ctx.commands(commandsOf(commands)))
          .catch((error) => this.ctx.log('warn', `claude: supportedCommands failed: ${messageOf(error)}`));
        for await (const message of this.query) this.receive(message);
      }
      this.finish(null);
    } catch (error) {
      this.finish(messageOf(error));
    }
  }

  private receive(message: SDKMessage): void {
    const sessionId = (message as { session_id?: string }).session_id;
    if (typeof sessionId === 'string' && sessionId.length > 0) this.sessionId = sessionId;
    if (message.type === 'system') this.noteTasks(message);
    const turn = this.head();
    if (turn === null) {
      this.adopt(message);
      return;
    }
    if (this.sessionId !== null) turn.noteSession(this.sessionId);
    if (message.type === 'result' && this.foreignResults > 0) {
      this.foreignResults -= 1;
      if (typeof message.total_cost_usd === 'number') this.costSoFar = message.total_cost_usd;
      return;
    }
    // `total_cost_usd` counts from the start of the CLI process, so on a warm
    // query every result after the first carries the turns before it too. The
    // turn is told what was already charged before it reads the result. A cold
    // process that resumed a session starts from that session's restored total.
    if (message.type === 'result') {
      if (this.carried !== null) this.costSoFar = restoredCost(message, this.carried);
      this.carried = null;
      turn.noteCostBefore(this.costSoFar);
    }
    turn.handle(message);
    // One result per user message: that is the end of this turn, not of the CLI.
    if (message.type === 'result') {
      if (typeof message.total_cost_usd === 'number') this.costSoFar = message.total_cost_usd;
      // A CLI that could not resume holds no session worth keeping warm: the
      // retry the core sends next must get a query of its own, with no resume.
      if (turn.sessionLost) this.close(null);
      this.endTurn(turn);
    }
  }

  private endTurn(turn: ClaudeTurn): void {
    this.waiting.shift();
    turn.settle();
    this.afterTurns();
  }

  /** Nothing attached any more: keep the CLI for its background work, else the warm rule. */
  private afterTurns(): void {
    if (this.closing || this.ended || this.waiting.length > 0) return;
    if (this.background.length > 0 || this.woken) return;
    if (this.warmMs > 0) this.armIdle();
    else this.close(null);
  }

  /**
   * `background_tasks_changed` is the whole set, each time; `task_started`
   * names the tool call behind a task. Ambient tasks (watchers the CLI runs
   * for itself) are not work anyone waits on.
   */
  private noteTasks(message: Extract<SDKMessage, { type: 'system' }>): void {
    if (message.subtype === 'task_started') {
      this.launched.set(message.task_id, { toolId: message.tool_use_id ?? null, startedAt: Date.now() });
      return;
    }
    if (message.subtype !== 'background_tasks_changed') return;
    const next = message.tasks.filter(task => task.ambient !== true).map((task): BackgroundTask => {
      const known = this.launched.get(task.task_id) ?? this.background.find(entry => entry.id === task.task_id);
      return {
        id: task.task_id,
        kind: backgroundKind(task.task_type),
        description: task.description,
        toolId: known?.toolId ?? null,
        startedAt: known?.startedAt ?? Date.now(),
      };
    });
    const ended = this.background.length > 0 && next.length === 0;
    this.background = next;
    for (const id of [...this.launched.keys()]) if (!next.some(task => task.id === id)) this.launched.delete(id);
    this.ctx.background?.(next);
    if (!ended || this.waiting.length > 0 || this.closing) return;
    // The CLI usually answers the task's notification by itself within a
    // second; the linger gives it that moment before the warm rule applies.
    this.clearLinger();
    this.linger = setTimeout(() => {
      this.linger = null;
      this.afterTurns();
    }, LINGER_MS);
    this.linger.unref?.();
  }

  /**
   * Output with no turn attached: the CLI went on by itself once background
   * work it started finished. It is kept, and the core is asked, once, for a
   * turn to hold it. Only real output asks: bookkeeping alone opens nothing.
   */
  private adopt(message: SDKMessage): void {
    if (this.closing || this.ended) return;
    // A background subagent still talking after the turn is not the CLI going
    // on by itself: no turn opens for it, and the turn that comes drops it.
    if (subagentOf(message) !== null) return;
    // The result closes the adopted turn: it is kept beyond the cap.
    if (this.orphans.length >= ORPHANS_MAX && message.type !== 'result') return;
    this.orphans.push(message);
    // Bookkeeping before any output (a task list, a notification) is kept for
    // the turn that may come, but holds nothing: the linger and the warm rule
    // still close the CLI if no output follows.
    if (!this.woken && message.type !== 'assistant' && message.type !== 'stream_event') return;
    this.clearIdle();
    this.clearLinger();
    if (this.woken) return;
    this.woken = true;
    this.ctx.wake?.(WAKE_TEXT);
  }

  private clearLinger(): void {
    if (this.linger === null) return;
    clearTimeout(this.linger);
    this.linger = null;
  }

  /** The loop is over: the CLI is gone, so nothing of this session survives. */
  private finish(reason: string | null): void {
    if (this.ended) return;
    this.ended = true;
    // Nothing waits on a query that will never open.
    this.markReady();
    this.clearIdle();
    this.clearLinger();
    this.orphans = [];
    this.woken = false;
    this.foreignResults = 0;
    // The CLI no longer tracks what it ran in the background. The command itself
    // can outlive it (Windows kills no tree): the registry's orphan sweep, which
    // the core schedules when it releases the thread, stops that.
    if (this.background.length > 0) {
      this.background = [];
      this.ctx.background?.([]);
    }
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    try {
      this.query?.close();
    } catch {
      // the query is already closed
    }
    const left = this.waiting.splice(0, this.waiting.length);
    for (const turn of left) {
      if (reason !== null && !turn.isStopped) turn.fail(reason);
      turn.settle();
    }
    // Between turns nobody is listening, so the reason goes to the core log.
    if (reason !== null && left.length === 0) {
      this.ctx.log('error', `the warm claude session ended: ${reason}`);
    }
    this.hooks.ended(this);
  }

  private head(): ClaudeTurn | null {
    return this.waiting[0] ?? null;
  }

  private armIdle(): void {
    this.idle = setTimeout(() => {
      this.idle = null;
      this.close(null);
    }, this.warmMs);
    this.idle.unref?.();
  }

  private clearIdle(): void {
    if (this.idle === null) return;
    clearTimeout(this.idle);
    this.idle = null;
  }

  private arm(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  private options(ctx: TurnContext): Options {
    const profile = profileFor(ctx.provider);
    const executable = profile === undefined ? null : resolveExecutable(profile);
    if (executable === null) {
      throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
    }
    // The same three values the setters carry later, so what the query opens on
    // and what the session records as applied can never say different things.
    const setup = liveSetup(ctx.thread);
    return {
      resume: ctx.sessionId ?? undefined,
      cwd: ctx.thread.cwd,
      model: setup.model ?? undefined,
      // A level the CLI knows goes in the options; `ultrathink` goes in the prompt.
      ...(setup.effortLevel === null ? {} : { effort: setup.effortLevel }),
      permissionMode: setup.permissionMode,
      allowDangerouslySkipPermissions: setup.permissionMode === 'bypassPermissions',
      pathToClaudeCodeExecutable: executable,
      settingSources: ['user', 'project', 'local'],
      settings: { fastMode: ctx.thread.speed === 'fast' },
      includePartialMessages: true,
      abortController: this.abortController,
      env: childEnv(ctx.accountEnv),
      canUseTool: this.canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [this.preToolUse] }],
        PostToolUse: [{ hooks: [this.postToolUse] }],
      },
      spawnClaudeCodeProcess: (options: SdkSpawnOptions): SpawnedChild => this.spawnCli(options),
    };
  }

  private spawnCli(options: SdkSpawnOptions): SpawnedChild {
    const child = this.ctx.spawnChild(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
    });
    // The SDK reads stderr only for the process it spawns itself, so with a
    // custom spawner nothing drains that pipe unless we do it here.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) this.ctx.log('warn', `claude cli: ${text.slice(0, STDERR_MAX)}`);
    });
    return child;
  }

  // -- permissions and tools ------------------------------------------------

  /** Reached only when the CLI itself needs to ask. Every call is journalled by the hook. */
  private readonly canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    const turn = this.head();
    if (turn === null) {
      this.ctx.log('warn', `claude asked for ${toolName} with no turn running: denied`);
      return { behavior: 'deny', message: DENIED };
    }
    if (toolName === ASK_TOOL) return this.askUser(turn, input);
    const ticket = turn.ctx.requestPermission(toolName, input, options.title ?? options.description ?? null);
    const index = turn.takeIndex();
    turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: null });
    // The ticket alone never settles when the CLI dies with the card open: the
    // turn ends, and the deny the core then writes would land behind
    // `message.completed`. Every other driver races the turn's stop here.
    // The CLI also aborts `signal` when it cancels the call by itself: the card
    // is taken back then, so it does not stay clickable for nobody.
    const decision = await Promise.race([ticket, turn.stopped.then(() => 'cancelled' as const), abortedBy(options.signal)]);
    if (decision === 'cancelled') return { behavior: 'deny', message: DENIED };
    if (decision === 'withdrawn') {
      ticket.withdraw();
      turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: 'deny' });
      return { behavior: 'deny', message: DENIED };
    }
    turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision });
    if (decision === 'allow') return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: DENIED };
  };

  /**
   * `AskUserQuestion`: each question becomes a card, asked in order, and the
   * answers go back in the tool's own input (`answers`, keyed by the question
   * text, labels joined by a comma), which is what the CLI hands the model.
   */
  private async askUser(turn: ClaudeTurn, input: Record<string, unknown>): Promise<PermissionResult> {
    const answers: Record<string, string> = {};
    for (const question of askedQuestions(input['questions'])) {
      const options = question.options.map((option, at) => ({
        id: String(at + 1),
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      }));
      const ask = { text: question.question, options, allowText: true, multiple: question.multiSelect };
      const ticket = turn.ctx.askQuestion(ask);
      const index = turn.takeIndex();
      turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer: null });
      const answer: QuestionAnswer | null = await Promise.race([ticket, turn.stopped.then(() => null)]);
      if (answer === null) return { behavior: 'deny', message: DENIED };
      turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer });
      const labels = answer.optionIds.map(id => options.find(option => option.id === id)?.label ?? id);
      answers[question.question] = [...labels, ...(answer.text ? [answer.text] : [])].join(', ');
    }
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  /** No matcher: this hook sees every tool call, which is what makes it the single gate. */
  private readonly preToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
    // A subagent's tool calls are its own conversation: no card on the main message.
    // The assistant frame already drew the parsed input: the hook only draws a
    // call no frame announced, so one call is not written twice.
    if (input.hook_event_name === 'PreToolUse' && input.agent_id === undefined) {
      const turn = this.head();
      if (turn !== null && !turn.hasParsedTool(input.tool_use_id)) {
        turn.upsertTool(input.tool_use_id, input.tool_name, input.tool_input);
      }
    }
    return {};
  };

  /**
   * Only the coordination context. The tool's result is the `tool_result` the
   * CLI sends next, with its own text and error flag; `tool_response` here is
   * the raw object, a whole `originalFile` for an Edit, that no card shows.
   */
  private readonly postToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name === 'PostToolUse') {
      const additionalContext = this.head()?.ctx.coordination?.();
      if (additionalContext) return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } };
    }
    return {};
  };
}

/**
 * What a session was started with and cannot be told to change. A turn that
 * differs on any of it cannot land on the running CLI: it closes that session
 * and starts its own. The model and the effort are deliberately not in here,
 * and neither are four of the five permission modes: each has a Query setter
 * that changes it on the live CLI, so a warm session follows the thread instead
 * of being dropped. What is left is what the child process was spawned with,
 * `allowDangerouslySkipPermissions` included: `setPermissionMode` moves the
 * mode, but that flag is a query-start option with no setter beside it, so a
 * query opened without it cannot be talked into `bypassPermissions` and a query
 * opened with it keeps the skip even after the mode moves away. Hence one
 * boolean rather than the mode itself: the four other modes still cross freely.
 */
function sessionKey(ctx: TurnContext): string {
  return JSON.stringify({
    cwd: ctx.thread.cwd,
    accountId: ctx.account.id,
    env: ctx.accountEnv,
    speed: ctx.thread.speed ?? null,
    bypass: ctx.thread.permissionMode === 'bypassPermissions',
  });
}

/**
 * The core runs inside a Claude Code session on this machine and the CLI
 * refuses to nest: the child must not inherit the session's own markers.
 */
function childEnv(accountEnv: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...accountEnv };
  delete env['CLAUDECODE'];
  delete env['CLAUDE_PID'];
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

/**
 * One short query on the small model: no tool, one turn, no settings file
 * read, nothing kept on disk, and the CLI traced under the thread like a
 * turn's. The `result` message's text is the title, as the model wrote it:
 * the core applies its one cleaning rule; a result that is an error is
 * thrown with its sentence.
 */
async function titleQuery(deps: ClaudeDeps, ctx: TitleContext): Promise<string | null> {
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) {
    throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TITLE_TIMEOUT_MS);
  timer.unref?.();
  const spawnCli = (options: SdkSpawnOptions): SpawnedChild => {
    const child = ctx.spawnChild(options.command, options.args, { cwd: options.cwd, env: options.env });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) ctx.log('warn', `claude cli (title): ${text.slice(0, STDERR_MAX)}`);
    });
    return child;
  };
  const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: titleRequest(ctx.prompt, ctx.answer) },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  };
  try {
    const queryFn = await deps.loadQuery();
    const query = queryFn({
      prompt: prompt(),
      options: {
        cwd: ctx.thread.cwd,
        model: TITLE_MODEL,
        maxTurns: 1,
        tools: [],
        allowedTools: [],
        settingSources: [],
        persistSession: false,
        includePartialMessages: false,
        pathToClaudeCodeExecutable: executable,
        abortController,
        env: childEnv(ctx.accountEnv),
        canUseTool: async () => ({ behavior: 'deny', message: 'a title needs no tool' }),
        spawnClaudeCodeProcess: spawnCli,
      },
    });
    let text: string | null = null;
    for await (const message of query) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') {
        const errors = (message as { errors?: string[] }).errors ?? [];
        throw new Error(errors[0] ?? `Claude ended the title call with ${message.subtype}.`);
      }
      text = message.result;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Settles `withdrawn` when the CLI cancels the request `signal` belongs to; never otherwise. */
function abortedBy(signal: AbortSignal | undefined): Promise<'withdrawn'> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve('withdrawn');
    else signal.addEventListener('abort', () => resolve('withdrawn'), { once: true });
  });
}

/** The Agent or Task tool call a message belongs to, or null for the main loop's own. */
function subagentOf(message: SDKMessage): string | null {
  if (message.type !== 'assistant' && message.type !== 'user' && message.type !== 'stream_event') return null;
  const parent = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof parent === 'string' && parent.length > 0 ? parent : null;
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .map((block) => (block.type === 'text' ? (block.text ?? '') : stringify(block)))
      .join('\n');
  }
  return stringify(content);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * A resumed CLI restores the session's running totals when it still holds them,
 * and `total_cost_usd` then includes the earlier turns. Its per-model token
 * counts are restored with it, so they exceed this turn's own by what those
 * turns used; a CLI that started from zero shows no such gap.
 */
function restoredCost(result: SDKResultMessage, before: { costUsd: number; tokens: number }): number {
  if (before.costUsd <= 0 || before.tokens <= 0) return 0;
  const held = Object.values(result.modelUsage ?? {}).reduce((sum, model) => sum + model.inputTokens + model.outputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens, 0);
  const own = mapUsage(result, 0);
  const turn = own.inputTokens + own.outputTokens + own.cacheReadTokens + own.cacheWriteTokens;
  return held - turn >= before.tokens / 2 ? before.costUsd : 0;
}

/** `costBefore` is what the same CLI process already charged to earlier turns of a warm query. */
function mapUsage(result: SDKResultMessage, costBefore: number): Usage {
  const total = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
  const usage = result.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    // A total under what was already charged is a process that started over.
    costUsdEquivalent: total === null ? null : total >= costBefore ? total - costBefore : total,
  };
}

/**
 * How long the cache written by one API request lives, from the split the API
 * reports under `usage.cache_creation`. A request writing at both lifetimes is
 * as warm as its shorter one, since the conversation's tail is the part the
 * next request needs most. Null when the request wrote nothing: a pure read
 * restarts the clock of whatever lifetime the earlier write had.
 */
export function cacheLifeOf(usage: unknown): PromptCacheLife | null {
  if (usage === null || typeof usage !== 'object') return null;
  const creation = (usage as { cache_creation?: unknown }).cache_creation;
  if (creation === null || typeof creation !== 'object') return null;
  const split = creation as { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown };
  const short = typeof split.ephemeral_5m_input_tokens === 'number' ? split.ephemeral_5m_input_tokens : 0;
  const long = typeof split.ephemeral_1h_input_tokens === 'number' ? split.ephemeral_1h_input_tokens : 0;
  if (short > 0) return { ttlSeconds: 300, source: 'reported' };
  if (long > 0) return { ttlSeconds: 3600, source: 'reported' };
  return null;
}

/** What one API request carried: its input, plus what it read from and wrote to the cache. */
function requestTokens(usage: unknown): number | null {
  if (usage === null || typeof usage !== 'object') return null;
  const fields = usage as Record<string, unknown>;
  const input = fields.input_tokens;
  if (typeof input !== 'number' || !Number.isFinite(input)) return null;
  const read = typeof fields.cache_read_input_tokens === 'number' ? fields.cache_read_input_tokens : 0;
  const written = typeof fields.cache_creation_input_tokens === 'number' ? fields.cache_creation_input_tokens : 0;
  return input + read + written;
}

/**
 * The window of the thread's model as the result names it, else of the one
 * model the turn ran on, else null: two models in one turn is a subagent's
 * doing and the meter is the main loop's.
 */
function contextWindowOf(result: SDKResultMessage, model: string | null): number | null {
  const usage = result.modelUsage as Record<string, { contextWindow?: unknown }> | undefined;
  if (usage === undefined) return null;
  const entries = Object.entries(usage);
  const own = model === null ? undefined : entries.find(([id]) => id === model || id.startsWith(`${model}-`));
  const picked = own ?? (entries.length === 1 ? entries[0] : undefined);
  const window = picked?.[1].contextWindow;
  return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null;
}

function errorSentence(error: SDKAssistantMessageError): string {
  switch (error) {
    case 'authentication_failed':
      return 'Claude refused the login of this account.';
    case 'oauth_org_not_allowed':
      return 'The organisation of this login does not allow Claude Code.';
    case 'account_on_hold':
      return 'This Claude account is on hold.';
    case 'billing_error':
      return 'Claude reported a billing problem on this account.';
    case 'rate_limit':
      return 'This Claude account has hit its rate limit.';
    case 'overloaded':
      return 'Claude is overloaded and refused the request.';
    case 'invalid_request':
      return 'Claude refused the request as invalid.';
    case 'model_not_found':
      return 'The model this thread asks for does not exist.';
    case 'max_output_tokens':
      return 'The answer reached the model output limit.';
    case 'server_error':
      return 'Claude returned a server error.';
    default:
      return `Claude failed with ${error}.`;
  }
}

/**
 * One session per thread. `warmProcessMinutes` at zero keeps the old rule, one
 * `query()` per turn and the CLI gone with it; above zero the next turn of the
 * thread reuses the CLI that is already up, as long as nothing of its setup moved.
 */
export function createClaudeDriver(deps: ClaudeDeps): Driver {
  const sessions = new Map<ThreadId, ClaudeSession>();
  const probes = new Map<string, { providerId: string; accountId: string; result?: ProbeResult; pending: Promise<ProbeResult> }>();

  /** The thread's session, started if it has none and replaced if it cannot serve this turn. */
  function acquire(ctx: TurnContext): ClaudeSession {
    const threadId = ctx.thread.id;
    const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
    const key = sessionKey(ctx);

    let session = sessions.get(threadId) ?? null;
    if (session !== null && !session.usable(key, warmMs)) {
      sessions.delete(threadId);
      session.close(session.key === key ? null : 'the thread changed account, folder or bypass mode');
      session = null;
    }
    if (session === null) {
      session = new ClaudeSession(
        key,
        warmMs,
        deps,
        {
          ended: (dead): void => {
            if (sessions.get(threadId) === dead) sessions.delete(threadId);
          },
          stranded: (turns): void => {
            for (const moved of turns) attach(moved);
          },
        },
        ctx,
      );
      sessions.set(threadId, session);
    }
    return session;
  }

  function attach(turn: ClaudeTurn): void {
    const session = acquire(turn.ctx);
    turn.session = session;
    session.attach(turn, Math.max(0, turn.ctx.warmProcessMinutes) * MINUTE_MS);
  }

  return {
    protocol: 'claude-sdk',
    probe(ctx: ProbeContext): Promise<ProbeResult> {
      const key = ctx.provider.id + '::' + ctx.accountId;
      const previous = probes.get(key);
      if (previous) return previous.pending;
      const entry = { providerId: ctx.provider.id, accountId: ctx.accountId, pending: Promise.resolve(null as unknown as ProbeResult), result: undefined as ProbeResult | undefined };
      entry.pending = readClaudeModels(ctx, deps).then(result => { if (probes.get(key) === entry) entry.result = result; return result; }).catch(error => { if (probes.get(key) === entry) probes.delete(key); throw error; });
      probes.set(key, entry);
      return entry.pending;
    },
    probedModels(providerId, accountId) { return probes.get(providerId + '::' + accountId)?.result?.models ?? null; },
    forgetProbes(filter = {}) {
      for (const [key, entry] of probes) if ((!filter.providerId || filter.providerId === entry.providerId) && (!filter.accountId || filter.accountId === entry.accountId)) probes.delete(key);
    },

    startTurn(ctx: TurnContext): TurnHandle {
      const turn = new ClaudeTurn(ctx);
      // A turn opened for output the CLI wrote on its own belongs to that CLI.
      // With the CLI gone there is nothing to adopt and no prompt to send.
      if (ctx.turn.execution?.operation === 'background' && sessions.get(ctx.thread.id)?.adoptable() !== true) {
        turn.settle();
        return { done: turn.done, stop: (): void => undefined };
      }
      attach(turn);
      return {
        done: turn.done,
        stop: (): void => {
          // The session that holds it, which is not always the one it started on.
          turn.session?.stopTurn(turn);
        },
      };
    },

    releaseThread(threadId: ThreadId): void {
      const session = sessions.get(threadId);
      // A turn still running on it keeps it: the idle window ends it soon enough.
      if (session === undefined || session.busy()) return;
      sessions.delete(threadId);
      session.close(null);
    },

    title(ctx: TitleContext): Promise<string | null> {
      return titleQuery(deps, ctx);
    },

    shutdown(): void {
      const open = [...sessions.values()];
      sessions.clear();
      for (const session of open) session.close(null, 0);
    },
  };
}

async function readClaudeModels(ctx: ProbeContext, deps: ClaudeDeps): Promise<ProbeResult> {
  const profile = profileFor(ctx.provider);
  const executable = profile ? resolveExecutable(profile) : null;
  if (!executable) throw unavailable('no Claude executable for model discovery');
  const prompts = new PromptQueue();
  const abortController = new AbortController();
  let query: Query | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const queryFn = await deps.loadQuery();
    query = queryFn({ prompt: prompts.stream(), options: {
      cwd: ctx.cwd, pathToClaudeCodeExecutable: executable, abortController,
      env: childEnv(ctx.accountEnv), settingSources: ['user'], persistSession: false,
      tools: [], mcpServers: {},
      spawnClaudeCodeProcess: (options: SdkSpawnOptions): SpawnedChild => {
        const child = ctx.spawnChild(options.command, options.args, { cwd: options.cwd, env: options.env });
        child.stderr.resume(); return child;
      },
    } });
    const rows = await Promise.race([query.supportedModels(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Claude model discovery timed out after 20 seconds')), 20_000);
    })]);
    const models: ModelInfo[] = rows.filter(row => !/^(default|auto)$/i.test(row.value)).map(row => {
      const id = row.resolvedModel ?? row.value;
      const known = ctx.provider.models.find(model => model.id === id.replace(/\[.*\]$/, ''));
      const versioned = row.description.match(/^(?:Claude\s+)?((?:Fable|Opus|Sonnet|Haiku)\s+\d+(?:\.\d+)*)(?:\b|$)/i)?.[1];
      const name = known?.name ?? (versioned ? `Claude ${versioned}` : row.displayName);
      const levels = row.supportsEffort ? (row.supportedEffortLevels ?? []).map(id => ({ id: String(id), label: id === 'xhigh' ? 'Extra high' : id.charAt(0).toUpperCase() + id.slice(1) })) : [];
      if (row.supportsAdaptiveThinking) levels.push({ id: 'ultrathink', label: 'Ultrathink' });
      return { id, name: id.includes('[1m]') ? `${name} (1M)` : name,
        ...(levels.length ? { effort: { levels, default: levels.some(l => l.id === 'high') ? 'high' : levels[0]!.id } } : {}),
        ...(row.supportsFastMode ? { speeds: [{ id: 'fast', label: 'Fast' }] } : {}),
      };
    });
    const current = new Set(models.map(model => model.id.replace(/\[.*\]$/, '')));
    // Explicit legacy ids remain runnable even when the CLI only lists its aliases.
    // Unknown native capabilities stay absent rather than inheriting another model's.
    for (const model of ctx.provider.models) {
      if (model.legacy && !current.has(model.id)) models.push({ id: model.id, name: model.name, legacy: true });
    }
    return { models: models.filter((model, index) => models.findIndex(m => m.id === model.id) === index), probedAt: Date.now() };
  } finally { if (timer) clearTimeout(timer); prompts.end(); query?.close(); abortController.abort(); ctx.killTree(); }
}

/** The tool whose questions Boite answers itself, as cards. */
const ASK_TOOL = 'AskUserQuestion';

interface AskedQuestion {
  question: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

/** `AskUserQuestion`'s `questions`, read defensively: a malformed entry is skipped, never thrown. */
function askedQuestions(raw: unknown): AskedQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AskedQuestion[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record['question'] !== 'string' || record['question'].length === 0) continue;
    const options = Array.isArray(record['options'])
      ? (record['options'] as unknown[]).flatMap((option) => {
        if (option === null || typeof option !== 'object') return [];
        const fields = option as Record<string, unknown>;
        if (typeof fields['label'] !== 'string' || fields['label'].length === 0) return [];
        return [{ label: fields['label'], ...(typeof fields['description'] === 'string' && fields['description'].length > 0 ? { description: fields['description'] } : {}) }];
      })
      : [];
    out.push({ question: record['question'], multiSelect: record['multiSelect'] === true, options });
  }
  return out;
}

/** The CLI's `task_type` as the kinds the UI draws. */
function backgroundKind(type: string): BackgroundTask['kind'] {
  switch (type) {
    case 'local_bash':
      return 'shell';
    case 'local_agent':
    case 'remote_agent':
      return 'agent';
    case 'monitor':
    case 'mcp_task':
      return 'monitor';
    case 'local_workflow':
      return 'workflow';
    default:
      return 'other';
  }
}
