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
  ImageAttachment,
  MessageId,
  MessagePart,
  PermissionMode,
  ThreadId,
  ToolDocument,
  ToolStatus,
  Usage,
} from '@boite/contracts';
import { messageOf, unavailable } from '../errors.ts';
import type { SpawnedChild } from '../procs.ts';
import { profileFor, resolveExecutable } from '../providers/loader.ts';
import type { Driver, TurnContext, TurnHandle, TurnResult } from './types.ts';

/** How long `stop()` lets the CLI end its turn before the abort signal takes it. */
const STOP_GRACE_MS = 3_000;
/** How long the CLI has to exit on its own once the prompt stream is over. */
const FINISH_GRACE_MS = 5_000;
const STDERR_MAX = 400;
const DENIED = 'Denied in Boite';
const MINUTE_MS = 60_000;

/** The effort levels the SDK takes as an option; see `Options['effort']`. */
const SDK_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The one level the CLI has no option for: it is a word in the prompt. */
const PROMPT_EFFORT = 'ultrathink';

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
  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  private resolve: (result: TurnResult) => void = () => undefined;

  readonly done: Promise<TurnResult>;
  stopped = false;
  settled = false;
  /** The session holding it right now: a stranded turn moves to another one. */
  session: ClaudeSession | null = null;

  constructor(readonly ctx: TurnContext) {
    this.sessionId = ctx.sessionId;
    this.done = new Promise<TurnResult>((resolve) => {
      this.resolve = resolve;
    });
  }

  /** `ultrathink` is not an option of the CLI: the word in the prompt is what asks for it. */
  promptText(): string {
    const text = this.ctx.prompt;
    if (this.ctx.thread.effort !== PROMPT_EFFORT) return text;
    return text.length === 0 ? PROMPT_EFFORT : `${text} ${PROMPT_EFFORT}`;
  }

  noteSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.stopped) this.status = 'stopped';
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

  // -- messages -------------------------------------------------------------

  handle(message: SDKMessage): void {
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

  /** `commands_changed`: the CLI relearned its slash commands mid-session. */
  private handleSystem(message: Extract<SDKMessage, { type: 'system' }>): void {
    if (message.subtype === 'commands_changed') this.ctx.commands(commandsOf(message.commands));
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
          const thinking = event.delta.thinking ?? '';
          if (thinking.length === 0) break;
          const seen = event.index === undefined ? undefined : this.thinkingBlocks.get(event.index);
          const at = seen ?? this.openThinking();
          if (event.index !== undefined) this.thinkingBlocks.set(event.index, at);
          this.ctx.emit.delta(this.message(), at, thinking);
          this.streamedThinking.set(this.apiMessageId, (this.streamedThinking.get(this.apiMessageId) ?? '') + thinking);
          break;
        }
        if (event.delta?.type === 'input_json_delta') {
          const partial = event.delta.partial_json ?? '';
          if (partial.length === 0 || event.index === undefined) break;
          const toolId = this.toolBlocks.get(event.index);
          const entry = toolId === undefined ? undefined : this.tools.get(toolId);
          if (entry === undefined) break;
          entry.inputText = (entry.inputText ?? '') + partial;
          this.ctx.emit.delta(this.message(), entry.index, partial);
          break;
        }
        if (event.delta?.type !== 'text_delta') break;
        const text = event.delta.text ?? '';
        if (text.length === 0) break;
        const known = event.index === undefined ? undefined : this.textBlocks.get(event.index);
        const index = known ?? this.openText();
        if (event.index !== undefined) this.textBlocks.set(event.index, index);
        this.ctx.emit.delta(this.message(), index, text);
        this.streamedText.set(this.apiMessageId, (this.streamedText.get(this.apiMessageId) ?? '') + text);
        break;
      }
      default:
        break;
    }
  }

  private handleAssistant(message: SDKAssistantMessage): void {
    if (message.error !== undefined) {
      this.fail(errorSentence(message.error));
      return;
    }
    const body = message.message as { id?: string; content?: unknown } | undefined;
    const apiId = body?.id ?? '';
    for (const block of contentBlocks(body?.content)) {
      if (block.type === 'text') {
        const text = block.text ?? '';
        // With includePartialMessages the deltas already carried this block.
        if (text.length === 0 || (this.streamedText.get(apiId) ?? '').includes(text)) continue;
        this.ctx.emit.delta(this.message(), this.openText(), text);
        continue;
      }
      if (block.type === 'thinking') {
        const thinking = block.thinking ?? '';
        // Same dedupe as text: the deltas already carried this block.
        if (thinking.length === 0 || (this.streamedThinking.get(apiId) ?? '').includes(thinking)) continue;
        this.ctx.emit.delta(this.message(), this.openThinking(), thinking);
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
    this.usage = mapUsage(message);
    if (message.subtype !== 'success') {
      this.fail(message.errors.length > 0 ? message.errors.join('; ') : message.subtype);
    } else if (message.is_error) {
      this.fail(message.result.length > 0 ? message.result : 'the turn ended on an API error');
    }
  }

  // -- parts ----------------------------------------------------------------

  private message(): MessageId {
    if (this.messageId === null) this.messageId = this.ctx.emit.startMessage('assistant');
    return this.messageId;
  }

  part(index: number, part: MessagePart): void {
    this.ctx.emit.part(this.message(), index, part);
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

  private query: Query | null = null;
  private ctx: TurnContext;
  private sessionId: string | null;
  private idle: Timer | null = null;
  private started = false;
  private closing = false;
  private ended = false;
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
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
  }

  /** Reusable only while the CLI is up and the turn asks for the very same setup. */
  usable(key: string, warmMs: number): boolean {
    return !this.ended && !this.closing && this.key === key && warmMs > 0 && this.warmMs > 0;
  }

  /** A turn is running or queued on it, so nothing may take the CLI away yet. */
  busy(): boolean {
    return this.waiting.length > 0;
  }

  attach(turn: ClaudeTurn, warmMs: number): void {
    this.warmMs = warmMs;
    this.ctx = turn.ctx;
    this.clearIdle();
    this.waiting.push(turn);
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
    if (turn.stopped || this.closing || this.ended) return;
    // The query is built after the SDK import: a turn that arrives during it
    // would otherwise send its prompt with nothing applied.
    await this.ready;
    if (turn.stopped || this.closing || this.ended) return;
    if (!(await this.applyLive(turn))) return;
    if (turn.stopped || this.closing || this.ended) return;
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
    turn.stopped = true;
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
      if (!first.stopped && !this.closing) {
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
    const turn = this.head();
    if (turn === null) return;
    if (this.sessionId !== null) turn.noteSession(this.sessionId);
    turn.handle(message);
    // One result per user message: that is the end of this turn, not of the CLI.
    if (message.type === 'result') this.endTurn(turn);
  }

  private endTurn(turn: ClaudeTurn): void {
    this.waiting.shift();
    turn.settle();
    if (this.closing || this.waiting.length > 0) return;
    if (this.warmMs > 0) this.armIdle();
    else this.close(null);
  }

  /** The loop is over: the CLI is gone, so nothing of this session survives. */
  private finish(reason: string | null): void {
    if (this.ended) return;
    this.ended = true;
    // Nothing waits on a query that will never open.
    this.markReady();
    this.clearIdle();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    try {
      this.query?.close();
    } catch {
      // the query is already closed
    }
    const left = this.waiting.splice(0, this.waiting.length);
    for (const turn of left) {
      if (reason !== null && !turn.stopped) turn.fail(reason);
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
    const ticket = turn.ctx.requestPermission(toolName, input, options.title ?? options.description ?? null);
    const index = turn.takeIndex();
    turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: null });
    const decision = await ticket;
    turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision });
    if (decision === 'allow') return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: DENIED };
  };

  /** No matcher: this hook sees every tool call, which is what makes it the single gate. */
  private readonly preToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name === 'PreToolUse') {
      this.head()?.upsertTool(input.tool_use_id, input.tool_name, input.tool_input);
    }
    return {};
  };

  private readonly postToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name === 'PostToolUse') {
      this.head()?.finishTool(input.tool_use_id, stringify(input.tool_response), 'done');
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

function mapUsage(result: SDKResultMessage): Usage {
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
    costUsdEquivalent: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
  };
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

    startTurn(ctx: TurnContext): TurnHandle {
      const turn = new ClaudeTurn(ctx);
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

    shutdown(): void {
      const open = [...sessions.values()];
      sessions.clear();
      for (const session of open) session.close(null, 0);
    },
  };
}
