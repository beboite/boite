import type {
  CanUseTool,
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
  SpawnOptions as SdkSpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { MessageId, MessagePart, ThreadId, ToolDocument, ToolStatus, Usage } from '@boite/contracts';
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

  push(text: string): void {
    this.items.push({
      type: 'user',
      message: { role: 'user', content: text },
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
      default:
        break;
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

/**
 * One `query()` and one prompt stream for a thread. With `warmProcessMinutes`
 * at zero it lives for one turn, which is what the driver did before warm
 * sessions existed; above zero it takes the next turns of the thread too, and
 * only an idle window, a stop, a changed setup or the core going down ends it.
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

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly deps: ClaudeDeps,
    private readonly onEnded: (session: ClaudeSession) => void,
    ctx: TurnContext,
  ) {
    this.ctx = ctx;
    this.sessionId = ctx.sessionId;
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
    this.prompts.push(turn.promptText());
    if (this.started) return;
    this.started = true;
    void this.run(turn);
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
    this.onEnded(this);
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
    const effort = ctx.thread.effort;
    return {
      resume: ctx.sessionId ?? undefined,
      cwd: ctx.thread.cwd,
      model: ctx.thread.model ?? undefined,
      // A level the CLI knows goes in the options; `ultrathink` goes in the prompt.
      ...(effort !== null && SDK_EFFORTS.includes(effort) ? { effort: effort as Options['effort'] } : {}),
      permissionMode: ctx.thread.permissionMode,
      allowDangerouslySkipPermissions: ctx.thread.permissionMode === 'bypassPermissions',
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
 * What a session was started with. A turn that differs on any of it cannot land
 * on the running CLI: it closes that session and starts its own.
 */
function sessionKey(ctx: TurnContext): string {
  return JSON.stringify({
    model: ctx.thread.model,
    effort: ctx.thread.effort,
    permissionMode: ctx.thread.permissionMode,
    cwd: ctx.thread.cwd,
    accountId: ctx.account.id,
    env: ctx.accountEnv,
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

  return {
    protocol: 'claude-sdk',

    startTurn(ctx: TurnContext): TurnHandle {
      const threadId = ctx.thread.id;
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const key = sessionKey(ctx);
      const turn = new ClaudeTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs)) {
        sessions.delete(threadId);
        session.close(session.key === key ? null : 'the thread changed model, account, mode or folder');
        session = null;
      }
      if (session === null) {
        session = new ClaudeSession(key, warmMs, deps, (ended) => {
          if (sessions.get(threadId) === ended) sessions.delete(threadId);
        }, ctx);
        sessions.set(threadId, session);
      }
      const running = session;
      running.attach(turn, warmMs);
      return {
        done: turn.done,
        stop: (): void => {
          running.stopTurn(turn);
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
