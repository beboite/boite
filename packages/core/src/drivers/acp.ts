import { Readable, Writable } from 'node:stream';
import type {
  AvailableCommand,
  ClientConnection,
  ClientContext,
  ContentBlock,
  PermissionOption,
  PermissionOptionKind,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigOptionCategory,
  SessionMode,
  SessionModeState,
  SessionNotification,
  ToolCallContent,
  ToolCallStatus,
  Usage as AcpUsage,
} from '@agentclientprotocol/sdk';
import type {
  AccountId,
  AgentCommand,
  ImageAttachment,
  MessageId,
  MessagePart,
  ModelInfo,
  OsProfile,
  PermissionMode,
  ProviderDescriptor,
  ProviderId,
  ThreadId,
  ToolDocument,
  ToolStatus,
  Usage,
} from '@boite/contracts';
import pkg from '../../package.json';
import { messageOf, unavailable } from '../errors.ts';
import type { SpawnedChild, SpawnOptions } from '../procs.ts';
import { agentEnv, profileFor, resolveExecutable } from '../providers/loader.ts';
import { normalizeAntigravityTool, isAntigravityQuestion } from './antigravity.ts';
import { grokEffortOf, grokLaunchArgs, grokReasoningEffortOf } from './grok.ts';
import { imageDocument } from './documents.ts';
import type {
  Driver,
  ProbeContext,
  ProbeFilter,
  ProbeResult,
  TurnContext,
  TurnHandle,
  TurnResult,
} from './types.ts';

/** What the agent sees as `clientInfo.name`, and the name of the JSON-RPC app. */
const CLIENT_NAME = 'boite';
const MINUTE_MS = 60_000;
const STDERR_MAX = 400;
/** How long a failed prompt waits for the child's exit before blaming the error itself. */
const EXIT_GRACE_MS = 500;
/**
 * The model id a descriptor carries when it has no model list of its own
 * (OpenCode's shipped one does): the agent keeps whatever it is configured
 * with, so no `session/set_config_option` goes out and nothing is warned about.
 */
const AGENT_OWN_MODEL = 'default';
/** How long a probe waits for the agent to answer `initialize` and `session/new`. */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * The one dialect that lists its models itself, carries a per-model effort
 * scale, takes both through `session/set_model`, and takes its permission mode
 * on the command line because it advertises no session modes.
 */
function isGrok(provider: ProviderDescriptor): boolean {
  return provider.quirks?.includes('grok') === true;
}

/**
 * The argv a turn spawns with: the descriptor's `launch.args` as they are, plus
 * the thread's permission mode spliced in for an agent whose mode is a command
 * line option rather than a `session/set_mode`. A probe has no thread and no
 * mode, so it launches the declared line untouched.
 */
function launchArgs(profile: OsProfile | undefined, provider: ProviderDescriptor, mode: PermissionMode): string[] {
  const declared = profile?.launch?.args ?? [];
  return isGrok(provider) ? grokLaunchArgs(declared, mode) : [...declared];
}

/** One `ContentBlock::Image` per attachment, `mimeType` and `data` as ACP names them. */
function imageBlocksOf(attachments: ImageAttachment[]): ContentBlock[] {
  return attachments.map((attachment) => ({
    type: 'image' as const,
    mimeType: attachment.mimeType,
    data: attachment.data,
  }));
}

/**
 * The thread's permission mode as candidate `session/set_mode` ids, best first.
 * ACP standardises the call and the shape of `availableModes`, never the ids
 * inside it: every agent names its own modes. So each Boite mode carries the
 * spellings agents are known to use and the first one an agent lists wins.
 * `matchMode` compares without case, `_` or `-`, so the two spellings of a name
 * are one key; both are written out anyway, because the list is also what tells
 * a reader which agent uses which.
 *
 * - `default`, `auto_edit` and `yolo` are Antigravity's three session modes,
 *   which is what the mapping was written against; it has no plan mode.
 * - `acceptEdits`, `bypassPermissions`, `plan`, `default` are Claude Code's
 *   permission modes, which its ACP bridge hands over as mode ids.
 * - `accept_edits`, `bypass_permissions`, `auto_edit`, `dont_ask` are the
 *   snake_case spelling of those same names.
 * - `build` is what OpenCode calls its plain mode, `normal` what several
 *   smaller agents call theirs.
 * - `auto` is the short name for a mode that approves everything.
 */
const MODE_CANDIDATES: Record<PermissionMode, readonly string[]> = {
  default: ['default', 'build', 'normal'],
  acceptEdits: ['acceptEdits', 'accept_edits', 'autoEdit', 'auto_edit'],
  bypassPermissions: ['bypassPermissions', 'bypass_permissions', 'yolo', 'auto'],
  plan: ['plan'],
  dontAsk: ['dontAsk', 'dont_ask', 'bypassPermissions', 'bypass_permissions', 'yolo', 'auto'],
};

/** A stdout line longer than this is a protocol line nobody should be buffering. */
const STDOUT_LINE_MAX = 16 * 1024 * 1024;

/**
 * The agent's stdout with everything that is not a JSON-RPC line taken out of
 * it. Antigravity prints its Google sign-in link on stdout, in the middle of
 * the ndjson stream, and a real agent may print a warning there too; either one
 * would break the SDK's parser. A line that does not start with `{` never
 * reaches it: it goes to `onOther` instead, which is what carries the sign-in
 * link to the Accounts page and every other line to the core log.
 */
export function jsonLinesOnly(
  source: ReadableStream<Uint8Array>,
  onOther: (line: string) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let discarding = false;
  const take = (line: string, controller: ReadableStreamDefaultController<Uint8Array>): void => {
    const text = line.replace(/\r$/, '');
    if (text.trimStart().startsWith('{')) {
      controller.enqueue(encoder.encode(`${text}\n`));
      return;
    }
    if (text.trim().length > 0) onOther(text.trim());
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.length > 0) {
            const tail = buffer;
            buffer = '';
            take(tail, controller);
          }
          controller.close();
          return;
        }
        let chunk = decoder.decode(value, { stream: true });
        if (discarding) {
          const end = chunk.indexOf('\n');
          if (end < 0) continue;
          chunk = chunk.slice(end + 1);
          discarding = false;
        }
        buffer += chunk;
        let index = buffer.indexOf('\n');
        let complete = false;
        while (index >= 0) {
          if (index > STDOUT_LINE_MAX) onOther('the agent sent a stdout line too large to be a protocol line');
          else take(buffer.slice(0, index), controller);
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
          complete = true;
        }
        if (buffer.length > STDOUT_LINE_MAX) {
          buffer = '';
          discarding = true;
          onOther('the agent sent a stdout line too large to be a protocol line');
        }
        if (complete) return;
      }
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
}

/** The whole SDK, loaded on the first ACP turn: nothing heavy loads at core start. */
export type AcpSdk = typeof import('@agentclientprotocol/sdk');

export interface AcpDeps {
  loadSdk: () => Promise<AcpSdk>;
}

type Timer = ReturnType<typeof setTimeout>;

interface ToolEntry {
  index: number;
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
  documents: ToolDocument[];
}

/**
 * A tool call's `content` as documents. A `diff` member is a file the call
 * wrote, a text block is markdown, an image block an image. `terminal`, audio
 * and resource blocks have no document in the contract, so they are dropped.
 * This is not the tool's output: `rawOutput` stays what it always was.
 */
function documentsOf(content: ToolCallContent[]): ToolDocument[] {
  const documents: ToolDocument[] = [];
  for (const entry of content) {
    if (entry.type === 'diff') {
      // No `oldText` is a file the call created.
      documents.push({ kind: 'diff', path: entry.path, oldText: entry.oldText ?? '', newText: entry.newText });
      continue;
    }
    if (entry.type !== 'content') continue;
    const block = entry.content;
    if (block.type === 'text') documents.push({ kind: 'markdown', title: null, text: block.text });
    else if (block.type === 'image') documents.push(imageDocument(block.mimeType, block.data, null));
  }
  return documents;
}

/** `AvailableCommand` as the contract's `AgentCommand`: no `input` means no hint. */
function commandsOf(list: AvailableCommand[]): AgentCommand[] {
  return list.map((command) => ({
    name: command.name,
    description: command.description || null,
    hint: command.input?.hint ?? null,
  }));
}

/**
 * One `session/prompt` and what it wrote. The parts are drawn the way every
 * other driver draws them: one text part the chunks append to, one part per
 * tool call, one part per permission question.
 */
class AcpTurn {
  private messageId: MessageId | null = null;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private thinkingIndex: number | null = null;
  private readonly tools = new Map<string, ToolEntry>();

  private status: TurnResult['status'] = 'done';
  private error: string | null = null;
  private usage: Usage | null = null;
  private resolve: (result: TurnResult) => void = () => undefined;
  private wake: () => void = () => undefined;

  readonly done: Promise<TurnResult>;
  /** Resolves on `stop()`, so a permission still waiting can answer "cancelled". */
  readonly stopped: Promise<void>;

  sessionId: string | null;
  /** The last USD cost an `usage_update` carried, folded into the turn's usage. */
  costUsdEquivalent: number | null = null;
  isStopped = false;
  settled = false;

  /** This agent's dialect fixes, read once from the descriptor. */
  readonly antigravity: boolean;

  constructor(readonly ctx: TurnContext) {
    this.antigravity = ctx.provider.quirks?.includes('antigravity') === true;
    this.sessionId = ctx.sessionId;
    this.done = new Promise<TurnResult>((resolve) => {
      this.resolve = resolve;
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

  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.wake();
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

  /** The prompt response: the stop reason becomes the status, the usage the numbers. */
  finish(response: PromptResponse): void {
    this.usage = mapUsage(response.usage ?? null, this.costUsdEquivalent);
    switch (response.stopReason) {
      case 'end_turn':
        break;
      case 'cancelled':
        this.status = 'stopped';
        break;
      default:
        this.fail(`the agent stopped: ${response.stopReason}`);
        break;
    }
  }

  fail(reason: string): void {
    if (this.status === 'error') return;
    this.status = 'error';
    this.error = reason;
    this.part(this.takeIndex(), { type: 'error', message: reason });
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
      // A text chunk after a thought chunk answers in its own part.
      this.thinkingIndex = null;
      this.part(index, { type: 'text', text: '' });
    }
    this.ctx.emit.delta(this.message(), this.textIndex, text);
  }

  /** `agent_thought_chunk`, the reasoning the UI folds. Its own part, like the text. */
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

  /**
   * `tool_call` opens the part, `tool_call_update` replaces the same one by id.
   * `content` replaces the documents when the agent sends one, the protocol's
   * own word for that field; null or absent leaves the ones already there.
   */
  upsertTool(
    toolCallId: string,
    name: string | null,
    input: unknown,
    output: unknown,
    status: ToolCallStatus | null | undefined,
    content: ToolCallContent[] | null | undefined,
  ): void {
    const entry = this.tools.get(toolCallId) ?? {
      index: this.takeIndex(),
      name: toolCallId,
      input: null,
      output: null,
      status: 'running' as ToolStatus,
      documents: [] as ToolDocument[],
    };
    if (name !== null && name.length > 0) entry.name = name;
    // Antigravity carries a shell call's command, its cwd and its combined
    // output under half a dozen spellings, and pads `_meta` with base64
    // images: the quirk folds those into what the card already draws.
    const native = this.antigravity ? normalizeAntigravityTool(input, output) : null;
    if (native !== null) {
      if (native.input !== undefined) entry.input = native.input;
      if (native.output !== undefined) entry.output = native.output;
    } else {
      if (input !== undefined) entry.input = input;
      if (output !== undefined && output !== null) entry.output = stringify(output);
    }
    if (status !== null && status !== undefined) entry.status = toolStatus(status);
    if (content !== null && content !== undefined) entry.documents = documentsOf(content);
    this.tools.set(toolCallId, entry);
    this.part(entry.index, {
      type: 'tool',
      toolId: toolCallId,
      name: entry.name,
      input: entry.input,
      output: entry.output,
      status: entry.status,
      ...(entry.documents.length > 0 ? { documents: entry.documents } : {}),
    });
  }
}

/**
 * One ACP agent process for a thread: one `initialize`, one `session/new` or
 * `session/load`, then one `session/prompt` per turn. With
 * `warmProcessMinutes` at zero the process goes with the turn; above zero it
 * takes the next turns of the thread until the idle window, a stop, an
 * archive, core shutdown or a changed setup ends it.
 */
class AcpSession {
  private child: SpawnedChild | null = null;
  private connection: ClientConnection | null = null;
  private agent: ClientContext | null = null;
  private starting: Promise<void> | null = null;
  /**
   * The thread's latest `TurnContext`, kept across turns. `available_commands_update`
   * typically arrives right after `session/new` or `session/load`, before any
   * turn is in flight, so the update handler reports through this rather than
   * through `current`, or the list would be dropped between turns.
   */
  private ctx: TurnContext | null = null;

  private sessionId: string | null = null;
  private canLoad = false;
  private imagesSupported = false;
  private configWarned = false;
  /** What the last session answer, or the last `set_config_option`, listed. */
  private configOptions: SessionConfigOption[] = [];
  /** What the last session answer said about models, for the agents that list them. */
  private agentModels: AgentModels | null = null;
  /**
   * The model and the effort as they last went out, whichever call carried
   * them. `undefined` is "nothing sent yet", which is not the same as a thread
   * that asks for none. They are not in the session key: a turn that moved one
   * of them sends it on the live session instead of dropping the process.
   */
  private appliedModel: string | null | undefined = undefined;
  private appliedEffort: string | null | undefined = undefined;
  /** What the last `session/new` or `session/load` said the agent can be in. */
  private modes: SessionMode[] = [];
  /** The mode the agent is in, as it last told us: an answer or a drift it announced. */
  private currentModeId: string | null = null;
  private modeWarned = false;
  private lastStderr = '';
  private exited: Promise<number | null> | null = null;
  private idle: Timer | null = null;
  /** The turn whose `session/prompt` is in flight; updates outside one are dropped. */
  private current: AcpTurn | null = null;
  private queue: Promise<void> = Promise.resolve();
  private running = 0;
  private closing = false;
  private ended = false;

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly deps: AcpDeps,
    private readonly onEnded: (session: AcpSession) => void,
  ) {}

  seedConfig(options: SessionConfigOption[]): void {
    if (this.configOptions.length === 0) this.configOptions = structuredClone(options);
  }

  /** Reusable only while the process is up and the turn asks for the very same setup. */
  usable(key: string, warmMs: number): boolean {
    return !this.ended && !this.closing && this.key === key && warmMs > 0 && this.warmMs > 0;
  }

  busy(): boolean {
    return this.running > 0;
  }

  attach(turn: AcpTurn, warmMs: number): void {
    this.warmMs = warmMs;
    this.running += 1;
    this.clearIdle();
    this.queue = this.queue.then(async () => {
      try {
        await this.runTurn(turn);
      } catch (error) {
        turn.fail(messageOf(error));
        this.endTurn(turn, true);
      }
    });
  }

  /** `session/cancel` is the only stop ACP has; the prompt response ends the turn. */
  stopTurn(turn: AcpTurn): void {
    if (turn.settled) return;
    // A stop that lands before the prompt went out is replayed by `runTurn`
    // the moment it does, so the order of the two never decides the outcome.
    turn.markStopped();
    if (this.current !== turn) return;
    this.cancel();
  }

  private cancel(): void {
    const agent = this.agent;
    const sessionId = this.sessionId;
    if (agent === null || sessionId === null) return;
    void agent.notify('session/cancel', { sessionId }).catch(() => undefined);
  }

  /** Archive, shutdown, an idle window, a changed setup: the process goes. */
  close(reason: string | null, ctx?: TurnContext): void {
    if (this.ended) return;
    this.closing = true;
    if (reason !== null && ctx !== undefined) ctx.log('warn', `acp session: ${reason}`);
    this.drop();
  }

  // -- the process ----------------------------------------------------------

  private async runTurn(turn: AcpTurn): Promise<void> {
    this.ctx = turn.ctx;
    try {
      await this.start(turn.ctx);
    } catch (error) {
      turn.fail(messageOf(error));
      this.endTurn(turn, true);
      return;
    }

    const agent = this.agent;
    const sessionId = this.sessionId;
    if (agent === null || sessionId === null) {
      turn.fail('the acp session went away before the prompt');
      this.endTurn(turn, true);
      return;
    }

    if (turn.ctx.attachments.length > 0 && !this.imagesSupported) {
      turn.fail(`${turn.ctx.provider.name} takes no images`);
      this.endTurn(turn, true);
      return;
    }

    turn.noteSession(sessionId);
    // Every turn, not only the first: a warm session outlives a change to any
    // of the three, the agent may have switched on its own since the last
    // prompt, and a `session/load` reports none of them reliably. Each call
    // sends nothing when what it carries has not moved.
    await this.applyModel(turn.ctx);
    await this.applyConfig(turn.ctx);
    await this.applyMode(turn.ctx);
    this.current = turn;
    let response: PromptResponse;
    try {
      const pending = agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: turn.ctx.prompt }, ...imageBlocksOf(turn.ctx.attachments)],
      });
      if (turn.isStopped) this.cancel();
      response = await pending;
    } catch (error) {
      this.current = null;
      // A child that died takes the connection with it, and its exit says more
      // than "the connection closed": give it a moment to be reported.
      const code = await this.exitWithin(EXIT_GRACE_MS);
      turn.fail(code === undefined ? messageOf(error) : this.exitSentence(code));
      this.endTurn(turn, true);
      return;
    }
    this.current = null;
    turn.finish(response);
    this.endTurn(turn, turn.isStopped);
  }

  private endTurn(turn: AcpTurn, drop: boolean): void {
    turn.settle();
    this.running = Math.max(0, this.running - 1);
    if (drop || this.closing || this.warmMs <= 0) {
      this.drop();
      return;
    }
    if (this.running === 0) this.armIdle();
  }

  private start(ctx: TurnContext): Promise<void> {
    if (this.starting === null) this.starting = this.open(ctx);
    return this.starting;
  }

  private async open(ctx: TurnContext): Promise<void> {
    const sdk = await this.deps.loadSdk();
    const profile = profileFor(ctx.provider);
    const executable = profile === undefined ? null : resolveExecutable(profile);
    if (executable === null) {
      throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
    }

    const child = ctx.spawnChild(executable, launchArgs(profile, ctx.provider, ctx.thread.permissionMode), {
      cwd: ctx.thread.cwd,
      env: agentEnv(ctx.provider, ctx.accountEnv),
    });
    this.child = child;
    this.watch(child, ctx);

    const stream = sdk.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      jsonLinesOnly(Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>, (line) => {
        ctx.log('warn', `acp agent: ${line.slice(0, STDERR_MAX)}`);
      }),
    );
    const connection = sdk
      .client({ name: CLIENT_NAME })
      .onNotification('session/update', ({ params }) => {
        this.onUpdate(params);
      })
      .onRequest('session/request_permission', ({ params }) => this.onPermission(params))
      .connect(stream);
    this.connection = connection;
    this.agent = connection.agent;

    // No fs, no terminal: an agent that calls one anyway gets a
    // method-not-found from the SDK, which is the loud refusal we want.
    const init = await connection.agent.request('initialize', {
      protocolVersion: sdk.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: CLIENT_NAME, version: pkg.version },
    });
    this.canLoad = init.agentCapabilities?.loadSession === true;
    this.imagesSupported = init.agentCapabilities?.promptCapabilities?.image === true;

    if (ctx.sessionId !== null && this.canLoad) {
      // A fresh core has no probe cache, and session/load may omit controls.
      // Discover them before loading so the resumed session stays the active one.
      if (!isGrok(ctx.provider) && this.configOptions.length === 0
        && (ctx.thread.model !== AGENT_OWN_MODEL || ctx.thread.effort !== null)) {
        const discovered = await connection.agent.request('session/new', { cwd: ctx.thread.cwd, mcpServers: [] });
        this.seedConfig(discovered.configOptions ?? []);
      }
      // Every `session/update` of a load is history replay: `current` is null,
      // so the update handler drops them.
      const loaded = await connection.agent.request('session/load', {
        sessionId: ctx.sessionId,
        cwd: ctx.thread.cwd,
        mcpServers: [],
      });
      this.sessionId = ctx.sessionId;
      this.noteSession(loaded.modes, loaded.configOptions ?? null, loaded);
      return;
    }

    const created = await connection.agent.request('session/new', {
      cwd: ctx.thread.cwd,
      mcpServers: [],
    });
    this.sessionId = created.sessionId;
    this.noteSession(created.modes, created.configOptions ?? null, created);
  }

  /**
   * What a `session/new` or `session/load` said about itself: the modes, the
   * config options and the models. Nothing is sent from here; the turn that
   * follows applies the thread's own values, which is the one place a loaded
   * session and a warm one are treated alike.
   */
  private noteSession(
    modes: SessionModeState | null | undefined,
    options: SessionConfigOption[] | null,
    answer: unknown,
  ): void {
    this.noteModes(modes);
    if (options !== null && options.length > 0) this.configOptions = options;
    const listed = agentModelsOf(answer);
    if (listed !== null) this.agentModels = listed;
  }

  /**
   * The thread's model and reasoning effort as one `session/set_model`, for the
   * agents that take them there rather than through `session/set_config_option`
   * (Grok, today). It runs at the start of every turn and sends nothing when
   * the pair has not moved since the last one, so a warm session follows a
   * change instead of being dropped for it. A thread on the agent's own model
   * with no effort set says nothing, and neither does one the session answer
   * already reports as current. A refusal is one warning: the turn runs on
   * whatever the agent is already on.
   */
  private async applyModel(ctx: TurnContext): Promise<void> {
    if (!isGrok(ctx.provider)) return;
    const agent = this.agent;
    const sessionId = this.sessionId;
    if (agent === null || sessionId === null) return;

    const wanted = ctx.thread.model === AGENT_OWN_MODEL ? null : ctx.thread.model;
    const effort = ctx.thread.effort !== null && ctx.thread.effort.length > 0 ? ctx.thread.effort : null;
    if (wanted === null && effort === null) return;

    const listed = this.agentModels;
    const modelId = wanted ?? listed?.currentModelId ?? null;
    if (modelId === null) return;
    if (this.appliedModel === modelId && this.appliedEffort === effort) return;

    // Nothing sent yet, and the session already opened on that pair.
    if (this.appliedModel === undefined && listed !== null && listed.currentModelId === modelId) {
      const entry = listed.available.find((model) => model.modelId === modelId) ?? null;
      const current = entry === null ? null : grokReasoningEffortOf(entry.meta);
      if (effort === null || effort === current) {
        this.appliedModel = modelId;
        this.appliedEffort = effort;
        return;
      }
    }

    try {
      await agent.request('session/set_model', {
        sessionId,
        modelId,
        ...(effort === null ? {} : { _meta: { reasoningEffort: effort } }),
      });
      this.appliedModel = modelId;
      this.appliedEffort = effort;
    } catch (error) {
      ctx.log('warn', `acp: the agent refused the model ${modelId}: ${messageOf(error)}`);
    }
  }

  /** What a `session/new` or `session/load` answered about modes, if anything. */
  private noteModes(state: SessionModeState | null | undefined): void {
    if (state === null || state === undefined) return;
    this.modes = state.availableModes;
    this.currentModeId = state.currentModeId;
  }

  /**
   * The thread's permission mode as one `session/set_mode`. Sent when the
   * session opens (a loaded session does not reliably come back in the mode it
   * was left in) and at the start of every turn, so a warm session follows a
   * change and an agent that switched on its own is put back. Nothing goes out
   * when the agent already reports that mode. A mode is a preference: an agent
   * that lists none, offers no match or refuses the call is one warning in the
   * core log, never a reason to fail the turn.
   */
  private async applyMode(ctx: TurnContext): Promise<void> {
    // Grok's mode went on the command line at spawn and it advertises no
    // `availableModes`: there is nothing to match and nothing to warn about.
    if (isGrok(ctx.provider)) return;
    const agent = this.agent;
    const sessionId = this.sessionId;
    if (agent === null || sessionId === null) return;
    const wanted = ctx.thread.permissionMode;

    const modeId = matchMode(wanted, this.modes);
    if (modeId === null) {
      if (this.modeWarned) return;
      this.modeWarned = true;
      const offered = this.modes.length === 0 ? 'none' : this.modes.map((mode) => mode.id).join(', ');
      ctx.log('warn', `acp: no session mode matches the permission mode ${wanted}; the agent offers ${offered}`);
      return;
    }
    if (this.currentModeId === modeId) return;

    try {
      await agent.request('session/set_mode', { sessionId, modeId });
      this.currentModeId = modeId;
    } catch (error) {
      ctx.log('warn', `acp: the agent refused the session mode ${modeId}: ${messageOf(error)}`);
    }
  }

  /**
   * The thread's model and reasoning effort as `session/set_config_option`,
   * which is how ACP changes them in place. It runs at the start of every turn,
   * on a session that was loaded as well as on one that was created, and sends
   * only what moved since the last turn: a change of either follows the warm
   * process instead of dropping it.
   */
  private async applyConfig(ctx: TurnContext): Promise<void> {
    // Grok took its model and its effort through `session/set_model` and
    // answers `session/set_config_option` with method-not-found: nothing goes
    // out.
    if (isGrok(ctx.provider)) return;
    if (this.configOptions.length === 0) return;
    const model = ctx.thread.model;
    const effort = ctx.thread.effort;
    if (model !== this.appliedModel && (await this.setOption(ctx, 'model', model))) this.appliedModel = model;
    if (effort !== this.appliedEffort && (await this.setOption(ctx, 'thought_level', effort))) {
      this.appliedEffort = effort;
    }
  }

  /** True once that value is what the agent is on, whether it was sent or never needed. */
  private async setOption(
    ctx: TurnContext,
    category: SessionConfigOptionCategory,
    wanted: string | null,
  ): Promise<boolean> {
    const agent = this.agent;
    const sessionId = this.sessionId;
    if (agent === null || sessionId === null) return false;
    // Nothing to ask for: the agent keeps whatever it is configured with.
    if (wanted === null || wanted.length === 0) return true;
    if (category === 'model' && wanted === AGENT_OWN_MODEL) return true;
    const option = this.configOptions.find(
      (entry) => entry.category === category && selectValues(entry).includes(wanted),
    );
    if (option === undefined) {
      if (!this.configWarned) {
        this.configWarned = true;
        ctx.log('warn', `acp: the agent offers no ${category} option with the value ${wanted}`);
      }
      return false;
    }
    try {
      const answer = await agent.request('session/set_config_option', {
        sessionId,
        configId: option.id,
        value: wanted,
      });
      // The answer carries the options as they now stand, current values included.
      const listed = (answer as { configOptions?: SessionConfigOption[] | null }).configOptions ?? null;
      if (listed !== null && listed.length > 0) this.configOptions = listed;
      return true;
    } catch (error) {
      ctx.log('warn', `acp: the agent refused the ${category} ${wanted}: ${messageOf(error)}`);
      return false;
    }
  }

  private watch(child: SpawnedChild, ctx: TurnContext): void {
    child.stdin.on('error', () => undefined);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim();
        if (text.length === 0) continue;
        this.lastStderr = text.slice(0, STDERR_MAX);
        ctx.log('warn', `acp agent: ${this.lastStderr}`);
      }
    });
    this.exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
        // A process that dies on its own leaves nothing reusable behind: the
        // next turn of the thread starts a fresh one.
        if (!this.closing) this.drop();
      });
      child.once('error', () => {
        resolve(null);
        if (!this.closing) this.drop();
      });
    });
  }

  private exitWithin(ms: number): Promise<number | null | undefined> {
    const exited = this.exited;
    if (exited === null) return Promise.resolve(undefined);
    return new Promise<number | null | undefined>((resolve) => {
      const timer = setTimeout(() => {
        resolve(undefined);
      }, ms);
      timer.unref?.();
      void exited.then((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  private exitSentence(code: number | null): string {
    const head = `the acp agent exited with code ${code === null ? 'unknown' : code}`;
    return this.lastStderr.length === 0 ? head : `${head}: ${this.lastStderr}`;
  }

  /** The one teardown: the connection goes, then the child, through the registry. */
  private drop(): void {
    if (this.ended) return;
    this.ended = true;
    this.closing = true;
    this.clearIdle();
    const connection = this.connection;
    this.connection = null;
    this.agent = null;
    try {
      connection?.close();
    } catch {
      // the connection is already closed
    }
    const child = this.child;
    this.child = null;
    if (child !== null) {
      try {
        child.stdin.end();
      } catch {
        // the pipe is already gone
      }
      try {
        child.kill();
      } catch {
        // already exited
      }
    }
    this.onEnded(this);
  }

  private armIdle(): void {
    this.idle = setTimeout(() => {
      this.idle = null;
      this.drop();
    }, this.warmMs);
    this.idle?.unref?.();
  }

  private clearIdle(): void {
    if (this.idle === null) return;
    clearTimeout(this.idle);
    this.idle = null;
  }

  // -- what the agent sends -------------------------------------------------

  private onUpdate(params: SessionNotification): void {
    const update = params.update;
    // Not gated on `current`: this one arrives between turns as often as
    // during one, right after `session/new` or `session/load`.
    if (update.sessionUpdate === 'available_commands_update') {
      this.ctx?.commands(commandsOf(update.availableCommands));
      return;
    }
    const turn = this.current;
    if (turn === null) return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') turn.writeText(update.content.text);
        break;
      case 'agent_thought_chunk':
        if (update.content.type === 'text') turn.writeThinking(update.content.text);
        break;
      case 'tool_call':
        turn.upsertTool(
          update.toolCallId,
          update.name ?? update.title,
          update.rawInput,
          update.rawOutput,
          update.status,
          update.content,
        );
        break;
      case 'tool_call_update':
        turn.upsertTool(
          update.toolCallId,
          update.name ?? update.title ?? null,
          update.rawInput,
          update.rawOutput,
          update.status,
          update.content,
        );
        break;
      case 'usage_update':
        if (update.cost != null && update.cost.currency === 'USD') turn.costUsdEquivalent = update.cost.amount;
        break;
      case 'current_mode_update':
        // The agent switched on its own. Remembering it is what makes the next
        // turn send the thread's mode again instead of trusting a stale one.
        // The thread record is not touched: the mode the user picked stands.
        this.currentModeId = update.currentModeId;
        turn.ctx.log('info', `acp: the agent switched to the session mode ${update.currentModeId}`);
        break;
      default:
        // user_message_chunk, plan, plan_update, plan_removed,
        // config_option_update, session_info_update and the compaction
        // updates have no MessagePart in the contract, so they are dropped.
        break;
    }
  }

  private async onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const turn = this.current;
    // `RequestPermissionResponse.outcome` is itself the tagged outcome object.
    if (turn === null) return { outcome: { outcome: 'cancelled' } };
    const call = params.toolCall;
    // Antigravity carries questions on this method, using its own option ids.
    const question = turn.antigravity && isAntigravityQuestion(params);
    if (question) {
      const ask = {
        text: call.title ?? 'Antigravity asks',
        options: params.options.map((option) => ({ id: option.optionId, label: option.name })),
        allowText: false, multiple: false,
      };
      const ticket = turn.ctx.askQuestion(ask);
      const index = turn.takeIndex();
      turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer: null });
      const answer = await Promise.race([ticket, turn.stopped.then(() => null)]);
      if (answer === null) return { outcome: { outcome: 'cancelled' } };
      turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer });
      const optionId = answer.optionIds[0];
      if (!params.options.some((option) => option.optionId === optionId)) return { outcome: { outcome: 'cancelled' } };
      return { outcome: { outcome: 'selected', optionId: optionId! } };
    }
    const toolName = call.name ?? call.title ?? call.toolCallId;
    const ticket = turn.ctx.requestPermission(toolName, call.rawInput ?? null, call.title ?? null);
    const index = turn.takeIndex();
    turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: null });
    const answer = await Promise.race([ticket, turn.stopped.then(() => 'cancelled' as const)]);
    if (answer === 'cancelled') return { outcome: { outcome: 'cancelled' } };
    turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: answer });
    const optionId = pickOption(params.options, answer);
    if (optionId === null) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId } };
  }
}

/**
 * What a session was started with and cannot be told to change. A turn that
 * differs on any of it needs its own. The model and the effort are deliberately
 * not in here: ACP changes them in place with `session/set_config_option`, and
 * Grok with `session/set_model`, so a warm session follows the thread. Neither
 * is the permission mode for an agent that takes it as a `session/set_mode`; it
 * is in here for Grok alone, whose mode is a command line option, so a change
 * there drops the process the way it does for Codex.
 */
function sessionKey(ctx: TurnContext): string {
  return JSON.stringify({
    permissionMode: isGrok(ctx.provider) ? ctx.thread.permissionMode : null,
    cwd: ctx.thread.cwd,
    accountId: ctx.account.id,
    providerId: ctx.provider.id,
    env: ctx.accountEnv,
  });
}

/** The values of a select option, groups flattened, in the order the agent listed them. */
function selectChoices(option: SessionConfigOption): { value: string; name: string }[] {
  if (option.type !== 'select') return [];
  const choices: { value: string; name: string }[] = [];
  for (const entry of option.options) {
    if ('group' in entry) choices.push(...entry.options.map((choice) => ({ value: choice.value, name: choice.name })));
    else choices.push({ value: entry.value, name: entry.name });
  }
  return choices;
}

function selectValues(option: SessionConfigOption): string[] {
  return selectChoices(option).map((choice) => choice.value);
}

/** Mode ids are spelled every way there is: match without case, `_` or `-`. */
function normalizeModeId(id: string): string {
  return id.toLowerCase().replace(/[_-]/g, '');
}

/** The agent's own id for a Boite permission mode, or null when it offers none. */
function matchMode(wanted: PermissionMode, modes: SessionMode[]): string | null {
  const offered = new Map<string, string>();
  for (const mode of modes) {
    const key = normalizeModeId(mode.id);
    // The agent's order decides: the first spelling it lists is the one sent.
    if (!offered.has(key)) offered.set(key, mode.id);
  }
  for (const candidate of MODE_CANDIDATES[wanted]) {
    const found = offered.get(normalizeModeId(candidate));
    if (found !== undefined) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The probe: the models the agent itself lists
// ---------------------------------------------------------------------------

/**
 * The model list a `session/new` may answer with, beside or instead of its
 * `configOptions`. It is the protocol's own shape, but the SDK's generated
 * `NewSessionResponse` does not carry it yet, so it is read off the raw answer
 * and every field is checked rather than trusted.
 */
interface AgentModel {
  modelId: string;
  name: string | null;
  meta: unknown;
}

interface AgentModels {
  currentModelId: string | null;
  available: AgentModel[];
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `session/new`'s `models`, or null when the agent sent none Boite can read. */
function agentModelsOf(created: unknown): AgentModels | null {
  const models = plainObject(plainObject(created)?.['models']);
  if (models === null) return null;
  const listed = models['availableModels'];
  if (!Array.isArray(listed)) return null;

  const available: AgentModel[] = [];
  for (const entry of listed) {
    const model = plainObject(entry);
    if (model === null) continue;
    const modelId = nonEmptyString(model['modelId']);
    if (modelId === null) continue;
    available.push({ modelId, name: nonEmptyString(model['name']), meta: model['_meta'] });
  }
  if (available.length === 0) return null;
  return { currentModelId: nonEmptyString(models['currentModelId']), available };
}

function categoryOption(
  options: SessionConfigOption[] | null,
  category: SessionConfigOptionCategory,
): SessionConfigOption | null {
  if (options === null) return null;
  return options.find((entry) => entry.category === category && entry.type === 'select') ?? null;
}

/** `thought_level` is one scale for the whole session, so every model carries it. */
function effortFrom(option: SessionConfigOption | null): ModelInfo['effort'] | null {
  if (option === null) return null;
  const choices = selectChoices(option);
  if (choices.length === 0) return null;
  const levels = choices.map((choice) => ({ id: choice.value, label: choice.name }));
  const current = option.type === 'select' ? String(option.currentValue) : '';
  const fallback = levels.some((level) => level.id === current) ? current : (levels[0]?.id ?? '');
  return { levels, default: fallback };
}

/**
 * What a `session/new` said about models, as a model list. An agent that
 * answers with the protocol's `models.availableModels` is read there, an agent
 * that answers with a `model` config option is read there, and one that answers
 * with neither leaves the descriptor's models standing.
 */
function modelsFrom(
  provider: ProviderDescriptor,
  options: SessionConfigOption[] | null,
  listed: AgentModels | null,
): ModelInfo[] {
  if (listed !== null) return modelsFromList(provider, listed);
  return modelsFromConfig(provider, options);
}

/**
 * `models.availableModels` as a model list. The descriptor's `default` stays
 * first, without an effort scale: it means the agent keeps its own model, and
 * the effort of a model nobody named is nobody's to pick. Under the `grok`
 * quirk each model carries the scale out of its own `_meta`, which is the one
 * place a per-model scale is written in this protocol.
 */
function modelsFromList(provider: ProviderDescriptor, listed: AgentModels): ModelInfo[] {
  const grok = isGrok(provider);
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const own = provider.models.find((model) => model.id === AGENT_OWN_MODEL);
  if (own !== undefined) {
    models.push({ id: AGENT_OWN_MODEL, name: own.name, default: false });
    seen.add(AGENT_OWN_MODEL);
  }
  for (const entry of listed.available) {
    if (seen.has(entry.modelId)) continue;
    seen.add(entry.modelId);
    const effort = grok ? grokEffortOf(entry.meta) : null;
    models.push({
      id: entry.modelId,
      name: entry.name ?? entry.modelId,
      default: entry.modelId === listed.currentModelId,
      ...(effort === null ? {} : { effort }),
    });
  }
  return models;
}

/**
 * The `configOptions` of a `session/new` as a model list. The descriptor's
 * `default` model stays first so the user can always hand the choice back to
 * the agent; the agent's own values follow in its order, the current one
 * flagged. No `model` option means the agent has nothing to say: the
 * descriptor's models stand.
 */
function modelsFromConfig(provider: ProviderDescriptor, options: SessionConfigOption[] | null): ModelInfo[] {
  const option = categoryOption(options, 'model');
  if (option === null) return provider.models;
  const effort = effortFrom(categoryOption(options, 'thought_level'));
  const withEffort = (model: ModelInfo): ModelInfo => (effort === null ? model : { ...model, effort });

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const own = provider.models.find((model) => model.id === AGENT_OWN_MODEL);
  if (own !== undefined) {
    models.push(withEffort({ id: AGENT_OWN_MODEL, name: own.name, default: false }));
    seen.add(AGENT_OWN_MODEL);
  }
  const current = option.type === 'select' ? String(option.currentValue) : '';
  for (const choice of selectChoices(option)) {
    if (seen.has(choice.value)) continue;
    seen.add(choice.value);
    models.push(withEffort({ id: choice.value, name: choice.name, default: choice.value === current }));
  }
  return models;
}

/**
 * One short-lived agent process: `initialize`, `session/new`, read the config
 * options, then the child goes through the registry that traced it. Nothing of
 * this session is kept; a turn opens its own.
 */
async function readModels(ctx: ProbeContext, deps: AcpDeps, noteOptions: (options: SessionConfigOption[]) => void): Promise<ModelInfo[]> {
  const sdk = await deps.loadSdk();
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) {
    throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
  }

  let lastStderr = '';
  // No thread here, so no permission mode either: the probe launches the line
  // the descriptor declares and reads the agent on its own defaults.
  const child = ctx.spawnChild(executable, profile?.launch?.args ?? [], {
    cwd: ctx.cwd,
    env: agentEnv(ctx.provider, ctx.accountEnv),
  });
  child.stdin.on('error', () => undefined);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
      if (text.length > 0) lastStderr = text.slice(0, STDERR_MAX);
    }
  });

  const say = (head: string): string => (lastStderr.length === 0 ? head : `${head}: ${lastStderr}`);
  let connection: ClientConnection | null = null;
  let timer: Timer | null = null;
  try {
    const died = new Promise<never>((_resolve, reject) => {
      child.once('exit', (code) => {
        reject(unavailable(say(`the ${ctx.provider.id} agent exited with code ${code ?? 'unknown'}`), {
          providerId: ctx.provider.id,
          accountId: ctx.accountId,
        }));
      });
      child.once('error', (error) => {
        reject(unavailable(say(`the ${ctx.provider.id} agent did not start: ${messageOf(error)}`), {
          providerId: ctx.provider.id,
          accountId: ctx.accountId,
        }));
      });
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(unavailable(say(`the ${ctx.provider.id} agent did not list its models in ${PROBE_TIMEOUT_MS / 1000} s`), {
          providerId: ctx.provider.id,
          accountId: ctx.accountId,
        }));
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
    });

    const stream = sdk.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      jsonLinesOnly(Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>, (line) => {
        lastStderr = line.slice(0, STDERR_MAX);
      }),
    );
    // No update handler and no permission handler: nothing of this session is
    // drawn, and a prompt never goes out on it.
    const open = sdk.client({ name: CLIENT_NAME }).connect(stream);
    connection = open;

    const read = (async (): Promise<{ options: SessionConfigOption[] | null; listed: AgentModels | null }> => {
      await open.agent.request('initialize', {
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: CLIENT_NAME, version: pkg.version },
      });
      const created = await open.agent.request('session/new', { cwd: ctx.cwd, mcpServers: [] });
      return { options: created.configOptions ?? null, listed: agentModelsOf(created) };
    })();

    const answer = await Promise.race([read, died, expired]);
    noteOptions(answer.options ?? []);
    return modelsFrom(ctx.provider, answer.options, answer.listed);
  } finally {
    if (timer !== null) clearTimeout(timer);
    try {
      connection?.close();
    } catch {
      // the connection is already closed
    }
    try {
      child.stdin.end();
    } catch {
      // the pipe is already gone
    }
    ctx.killTree();
  }
}

// ---------------------------------------------------------------------------
// The login: `initialize` then `authenticate`, for an agent that has no CLI
// ---------------------------------------------------------------------------

export interface AcpLoginInput {
  /** The `authenticate` method id the descriptor names. */
  methodId: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  spawnChild(cmd: string, args: string[], opts?: SpawnOptions): SpawnedChild;
  /** Every line the agent wrote outside the ndjson stream, the sign-in link included. */
  onLine(line: string): void;
}

export interface AcpLoginRun {
  /** Settles only once the process and its pipes have closed. */
  exited: Promise<void>;
  /** Resolves when `authenticate` answered, rejects with what the agent refused. */
  done: Promise<void>;
  /** The process and the connection go, on success and on failure alike. */
  kill(): void;
}

/** How long the whole sign-in has to finish, the user's time at the Google page included. */
const LOGIN_TIMEOUT_MS = 5 * MINUTE_MS;

/**
 * One agent process whose only job is the protocol's `authenticate`. It is
 * started like a turn's, so it sits in the login thread's Job Object and in the
 * trace; what it prints outside the protocol goes to `onLine`, which is how the
 * Google sign-in link reaches the Accounts page.
 */
export function runAcpLogin(input: AcpLoginInput): AcpLoginRun {
  const child = input.spawnChild(input.executable, input.args, { cwd: input.cwd, env: input.env });
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  child.stdin.on('error', () => undefined);
  child.stderr.setEncoding('utf8');
  let stderrBuffer = '';
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    let index = stderrBuffer.indexOf('\n');
    while (index >= 0) {
      const line = stderrBuffer.slice(0, index).replace(/\r$/, '').trim();
      stderrBuffer = stderrBuffer.slice(index + 1);
      index = stderrBuffer.indexOf('\n');
      if (line.length > 0) input.onLine(line.slice(0, STDERR_MAX));
    }
  });

  let connection: ClientConnection | null = null;
  let timer: Timer | null = null;
  let killed = false;
  const kill = (): void => {
    if (killed) return;
    killed = true;
    if (timer !== null) clearTimeout(timer);
    try {
      connection?.close();
    } catch {
      // already closed
    }
    try {
      child.stdin.end();
    } catch {
      // the pipe is already gone
    }
    try {
      child.kill();
    } catch {
      // already exited
    }
  };

  const done = (async (): Promise<void> => {
    const sdk = await import('@agentclientprotocol/sdk');
    const died = new Promise<never>((_resolve, reject) => {
      child.once('exit', (code) => {
        reject(new Error(`the agent exited with code ${code ?? 'unknown'} before it authenticated`));
      });
      child.once('error', (error) => {
        reject(new Error(`the agent did not start: ${messageOf(error)}`));
      });
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`the sign-in was not finished within ${LOGIN_TIMEOUT_MS / MINUTE_MS} minutes`));
      }, LOGIN_TIMEOUT_MS);
      timer.unref?.();
    });

    const stream = sdk.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      jsonLinesOnly(Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>, input.onLine),
    );
    const open = sdk.client({ name: CLIENT_NAME }).connect(stream);
    connection = open;

    const run = (async (): Promise<void> => {
      const init = await open.agent.request('initialize', {
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: CLIENT_NAME, version: pkg.version },
      });
      const offered = (init.authMethods ?? []).map((method) => method.id);
      if (offered.length > 0 && !offered.includes(input.methodId)) {
        throw new Error(`the agent offers no ${input.methodId} sign-in, only ${offered.join(', ')}`);
      }
      await open.agent.request('authenticate', { methodId: input.methodId });
    })();

    try {
      await Promise.race([run, died, expired]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  })();

  return { done, kill, exited };
}

function pickOption(options: PermissionOption[], decision: 'allow' | 'deny'): string | null {
  const wanted: PermissionOptionKind[] =
    decision === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of wanted) {
    const found = options.find((option) => option.kind === kind);
    if (found !== undefined) return found.optionId;
  }
  return null;
}

function toolStatus(status: ToolCallStatus): ToolStatus {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    default:
      return 'running';
  }
}

function mapUsage(usage: AcpUsage | null, costUsdEquivalent: number | null): Usage | null {
  if (usage === null) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedReadTokens ?? 0,
    cacheWriteTokens: usage.cachedWriteTokens ?? 0,
    costUsdEquivalent,
  };
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

interface ProbeEntry {
  options: SessionConfigOption[];
  providerId: ProviderId;
  accountId: AccountId;
  /** The one process in flight for this key, so two callers share it. */
  running: Promise<ProbeResult> | null;
  result: ProbeResult | null;
}

/** One ACP agent process per thread, kept between turns the way the Claude one is. */
export function createAcpDriver(deps: AcpDeps): Driver {
  const sessions = new Map<ThreadId, AcpSession>();
  const probes = new Map<string, ProbeEntry>();

  const keyOf = (providerId: ProviderId, accountId: AccountId): string => `${providerId}::${accountId}`;

  return {
    protocol: 'acp',

    async probe(ctx: ProbeContext): Promise<ProbeResult> {
      const key = keyOf(ctx.provider.id, ctx.accountId);
      const entry: ProbeEntry = probes.get(key) ?? {
        options: [],
        providerId: ctx.provider.id,
        accountId: ctx.accountId,
        running: null,
        result: null,
      };
      probes.set(key, entry);
      if (entry.result !== null) return entry.result;
      if (entry.running !== null) return entry.running;

      const running = readModels(ctx, deps, (options) => { entry.options = options; }).then((models) => ({ models, probedAt: Date.now() }));
      entry.running = running;
      try {
        const result = await running;
        // A `providers.reload` during the probe dropped the entry: nothing is
        // cached behind its back, the next caller probes again.
        if (probes.get(key) === entry) entry.result = result;
        return result;
      } catch (error) {
        if (probes.get(key) === entry) probes.delete(key);
        throw error;
      } finally {
        entry.running = null;
      }
    },

    probedModels(providerId: ProviderId, accountId: AccountId): ModelInfo[] | null {
      return probes.get(keyOf(providerId, accountId))?.result?.models ?? null;
    },

    forgetProbes(filter: ProbeFilter = {}): void {
      for (const [key, entry] of [...probes]) {
        if (filter.providerId !== undefined && filter.providerId !== entry.providerId) continue;
        if (filter.accountId !== undefined && filter.accountId !== entry.accountId) continue;
        probes.delete(key);
      }
    },

    startTurn(ctx: TurnContext): TurnHandle {
      const threadId = ctx.thread.id;
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const key = sessionKey(ctx);
      const turn = new AcpTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs)) {
        sessions.delete(threadId);
        session.close(
          session.key === key
            ? null
            : isGrok(ctx.provider)
              ? 'the thread changed mode, account or folder'
              : 'the thread changed account or folder',
          ctx,
        );
        session = null;
      }
      if (session === null) {
        session = new AcpSession(key, warmMs, deps, (ended) => {
          if (sessions.get(threadId) === ended) sessions.delete(threadId);
        });
        sessions.set(threadId, session);
      }
      const running = session;
      running.seedConfig(probes.get(keyOf(ctx.provider.id, ctx.account.id))?.options ?? []);
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
      if (session === undefined || session.busy()) return;
      sessions.delete(threadId);
      session.close(null);
    },

    shutdown(): void {
      const open = [...sessions.values()];
      sessions.clear();
      probes.clear();
      for (const session of open) session.close(null);
    },
  };
}
