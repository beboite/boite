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
import type { MessageId, MessagePart, ToolStatus, Usage } from '@boite/contracts';
import { messageOf, unavailable } from '../errors.ts';
import type { SpawnedChild } from '../procs.ts';
import { profileFor, resolveExecutable } from '../providers/loader.ts';
import type { Driver, TurnContext, TurnHandle, TurnResult } from './types.ts';

/** How long `stop()` lets the CLI end its turn before the abort signal takes it. */
const STOP_GRACE_MS = 3_000;
/** How long the CLI has to exit on its own once the turn's result has arrived. */
const FINISH_GRACE_MS = 5_000;
const STDERR_MAX = 400;
const DENIED = 'Denied in Boite';

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
  delta?: { type?: string; text?: string };
}

interface ToolEntry {
  index: number;
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}

type UserMessage = Extract<SDKMessage, { type: 'user' }>;

class ClaudeTurn {
  private readonly abortController = new AbortController();
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private endPrompt: () => void = () => undefined;
  private readonly promptEnd = new Promise<void>((resolve) => {
    this.endPrompt = resolve;
  });

  private query: Query | null = null;
  private messageId: MessageId | null = null;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private apiMessageId = '';
  private readonly tools = new Map<string, ToolEntry>();
  private readonly textBlocks = new Map<number, number>();
  private readonly streamedText = new Map<string, string>();

  private sessionId: string | null;
  private usage: Usage | null = null;
  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: TurnContext,
    private readonly deps: ClaudeDeps,
  ) {
    this.sessionId = ctx.sessionId;
  }

  async run(): Promise<TurnResult> {
    let running: Query | null = null;
    try {
      const options = this.options();
      const query = await this.deps.loadQuery();
      // Loading the SDK is the first await of the turn, so a stop can land here.
      if (!this.stopped) {
        running = query({ prompt: this.promptStream(), options });
        this.query = running;
        for await (const message of running) this.handle(message);
      }
    } catch (error) {
      if (!this.stopped) this.fail(messageOf(error));
    } finally {
      this.endPrompt();
      for (const timer of this.timers) clearTimeout(timer);
      try {
        running?.close();
      } catch {
        // the query is already closed
      }
    }

    if (this.stopped) this.status = 'stopped';
    if (this.messageId !== null) {
      this.ctx.emit.complete(this.messageId, this.status === 'error' ? 'error' : 'complete');
    }
    return {
      status: this.status,
      sessionId: this.sessionId,
      usage: this.usage,
      error: this.error ?? undefined,
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const running = this.query;
    if (running !== null) void running.interrupt().catch(() => undefined);
    this.endPrompt();
    this.timers.push(setTimeout(() => this.abortController.abort(), STOP_GRACE_MS));
  }

  // -- the query ------------------------------------------------------------

  private options(): Options {
    const profile = profileFor(this.ctx.provider);
    const executable = profile === undefined ? null : resolveExecutable(profile);
    if (executable === null) {
      throw unavailable(`no ${this.ctx.provider.id} executable on this machine`, {
        providerId: this.ctx.provider.id,
      });
    }
    const effort = this.ctx.thread.effort;
    return {
      resume: this.ctx.sessionId ?? undefined,
      cwd: this.ctx.thread.cwd,
      model: this.ctx.thread.model ?? undefined,
      // A level the CLI knows goes in the options; `ultrathink` goes in the prompt.
      ...(effort !== null && SDK_EFFORTS.includes(effort) ? { effort: effort as Options['effort'] } : {}),
      permissionMode: this.ctx.thread.permissionMode,
      allowDangerouslySkipPermissions: this.ctx.thread.permissionMode === 'bypassPermissions',
      pathToClaudeCodeExecutable: executable,
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      abortController: this.abortController,
      env: childEnv(this.ctx.accountEnv),
      canUseTool: this.canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [this.preToolUse] }],
        PostToolUse: [{ hooks: [this.postToolUse] }],
      },
      spawnClaudeCodeProcess: (options: SdkSpawnOptions): SpawnedChild => this.spawnCli(options),
    };
  }

  /** One user message, then the stream stays open so `interrupt` and `canUseTool` work. */
  private async *promptStream(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: this.promptText() },
      parent_tool_use_id: null,
    };
    await this.promptEnd;
  }

  /** `ultrathink` is not an option of the CLI: the word in the prompt is what asks for it. */
  private promptText(): string {
    const text = this.ctx.prompt;
    if (this.ctx.thread.effort !== PROMPT_EFFORT) return text;
    return text.length === 0 ? PROMPT_EFFORT : `${text} ${PROMPT_EFFORT}`;
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
    const ticket = this.ctx.requestPermission(toolName, input, options.title ?? options.description ?? null);
    const index = this.takeIndex();
    this.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: null });
    const decision = await ticket;
    this.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision });
    if (decision === 'allow') return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: DENIED };
  };

  /** No matcher: this hook sees every tool call, which is what makes it the single gate. */
  private readonly preToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name === 'PreToolUse') {
      this.upsertTool(input.tool_use_id, input.tool_name, input.tool_input);
    }
    return {};
  };

  private readonly postToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name === 'PostToolUse') {
      this.finishTool(input.tool_use_id, stringify(input.tool_response), 'done');
    }
    return {};
  };

  // -- messages -------------------------------------------------------------

  private handle(message: SDKMessage): void {
    const sessionId = (message as { session_id?: string }).session_id;
    if (typeof sessionId === 'string' && sessionId.length > 0) this.sessionId = sessionId;
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
        break;
      case 'content_block_start': {
        const block = event.content_block;
        if (block === undefined) break;
        if (block.type === 'text' && event.index !== undefined) this.textBlocks.set(event.index, this.openText());
        else if (block.type === 'tool_use' && typeof block.id === 'string') {
          this.upsertTool(block.id, block.name ?? 'tool', block.input ?? {});
        }
        break;
      }
      case 'content_block_delta': {
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
    // In streaming input mode the CLI waits for more input; ending the prompt
    // is what lets it exit, and the abort is the guarantee that it does.
    this.endPrompt();
    this.timers.push(setTimeout(() => this.abortController.abort(), FINISH_GRACE_MS));
  }

  // -- parts ----------------------------------------------------------------

  private message(): MessageId {
    if (this.messageId === null) this.messageId = this.ctx.emit.startMessage('assistant');
    return this.messageId;
  }

  private part(index: number, part: MessagePart): void {
    this.ctx.emit.part(this.message(), index, part);
  }

  private openText(): number {
    if (this.textIndex !== null) return this.textIndex;
    const index = this.takeIndex();
    this.textIndex = index;
    this.part(index, { type: 'text', text: '' });
    return index;
  }

  private takeIndex(): number {
    this.textIndex = null;
    const index = this.nextIndex;
    this.nextIndex += 1;
    return index;
  }

  private upsertTool(toolId: string, name: string, input: unknown): void {
    const entry = this.tools.get(toolId) ?? this.newTool(name);
    entry.name = name;
    entry.input = input;
    this.tools.set(toolId, entry);
    this.emitTool(toolId, entry);
  }

  private finishTool(toolId: string, output: string, status: ToolStatus): void {
    const entry = this.tools.get(toolId) ?? this.newTool(toolId);
    entry.output = output;
    entry.status = status;
    this.tools.set(toolId, entry);
    this.emitTool(toolId, entry);
  }

  private newTool(name: string): ToolEntry {
    return { index: this.takeIndex(), name, input: {}, output: null, status: 'running' };
  }

  private emitTool(toolId: string, entry: ToolEntry): void {
    this.part(entry.index, {
      type: 'tool',
      toolId,
      name: entry.name,
      input: entry.input,
      output: entry.output,
      status: entry.status,
    });
  }

  private fail(reason: string): void {
    if (this.status === 'error') return;
    this.status = 'error';
    this.error = reason;
    this.part(this.takeIndex(), { type: 'error', message: reason });
  }
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

/** One `query()` per turn: the CLI process lives only while the turn runs. */
export function createClaudeDriver(deps: ClaudeDeps): Driver {
  return {
    protocol: 'claude-sdk',
    startTurn(ctx: TurnContext): TurnHandle {
      const turn = new ClaudeTurn(ctx, deps);
      return {
        done: turn.run(),
        stop: (): void => {
          turn.stop();
        },
      };
    },
  };
}
