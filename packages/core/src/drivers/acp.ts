import { Readable, Writable } from 'node:stream';
import type {
  ClientConnection,
  ClientContext,
  PermissionOption,
  PermissionOptionKind,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigOptionCategory,
  SessionNotification,
  ToolCallStatus,
  Usage as AcpUsage,
} from '@agentclientprotocol/sdk';
import type {
  AccountId,
  MessageId,
  MessagePart,
  ModelInfo,
  ProviderDescriptor,
  ProviderId,
  ThreadId,
  ToolStatus,
  Usage,
} from '@boite/contracts';
import pkg from '../../package.json';
import { messageOf, unavailable } from '../errors.ts';
import type { SpawnedChild } from '../procs.ts';
import { profileFor, resolveExecutable } from '../providers/loader.ts';
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

  constructor(readonly ctx: TurnContext) {
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

  /** `tool_call` opens the part, `tool_call_update` replaces the same one by id. */
  upsertTool(
    toolCallId: string,
    name: string | null,
    input: unknown,
    output: unknown,
    status: ToolCallStatus | null | undefined,
  ): void {
    const entry = this.tools.get(toolCallId) ?? {
      index: this.takeIndex(),
      name: toolCallId,
      input: null,
      output: null,
      status: 'running' as ToolStatus,
    };
    if (name !== null && name.length > 0) entry.name = name;
    if (input !== undefined) entry.input = input;
    if (output !== undefined && output !== null) entry.output = stringify(output);
    if (status !== null && status !== undefined) entry.status = toolStatus(status);
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

  private sessionId: string | null = null;
  private canLoad = false;
  private configWarned = false;
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

    turn.noteSession(sessionId);
    this.current = turn;
    let response: PromptResponse;
    try {
      const pending = agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: turn.ctx.prompt }],
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

    const child = ctx.spawnChild(executable, profile?.launch?.args ?? [], {
      cwd: ctx.thread.cwd,
      env: { ...process.env, ...ctx.accountEnv },
    });
    this.child = child;
    this.watch(child, ctx);

    const stream = sdk.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
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

    if (ctx.sessionId !== null && this.canLoad) {
      // Every `session/update` of a load is history replay: `current` is null,
      // so the update handler drops them.
      await connection.agent.request('session/load', {
        sessionId: ctx.sessionId,
        cwd: ctx.thread.cwd,
        mcpServers: [],
      });
      this.sessionId = ctx.sessionId;
      return;
    }

    const created = await connection.agent.request('session/new', {
      cwd: ctx.thread.cwd,
      mcpServers: [],
    });
    this.sessionId = created.sessionId;
    await this.applyConfig(ctx, created.configOptions ?? null);
  }

  private async applyConfig(ctx: TurnContext, options: SessionConfigOption[] | null): Promise<void> {
    if (options === null || options.length === 0) return;
    await this.setOption(ctx, options, 'model', ctx.thread.model);
    await this.setOption(ctx, options, 'thought_level', ctx.thread.effort);
  }

  private async setOption(
    ctx: TurnContext,
    options: SessionConfigOption[],
    category: SessionConfigOptionCategory,
    wanted: string | null,
  ): Promise<void> {
    const agent = this.agent;
    const sessionId = this.sessionId;
    if (wanted === null || wanted.length === 0 || agent === null || sessionId === null) return;
    if (category === 'model' && wanted === AGENT_OWN_MODEL) return;
    const option = options.find(
      (entry) => entry.category === category && selectValues(entry).includes(wanted),
    );
    if (option === undefined) {
      if (!this.configWarned) {
        this.configWarned = true;
        ctx.log('warn', `acp: the agent offers no ${category} option with the value ${wanted}`);
      }
      return;
    }
    await agent.request('session/set_config_option', { sessionId, configId: option.id, value: wanted });
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
    const turn = this.current;
    if (turn === null) return;
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') turn.writeText(update.content.text);
        break;
      case 'agent_thought_chunk':
        if (update.content.type === 'text') turn.writeThinking(update.content.text);
        break;
      case 'tool_call':
        turn.upsertTool(update.toolCallId, update.name ?? update.title, update.rawInput, update.rawOutput, update.status);
        break;
      case 'tool_call_update':
        turn.upsertTool(
          update.toolCallId,
          update.name ?? update.title ?? null,
          update.rawInput,
          update.rawOutput,
          update.status,
        );
        break;
      case 'usage_update':
        if (update.cost != null && update.cost.currency === 'USD') turn.costUsdEquivalent = update.cost.amount;
        break;
      default:
        // user_message_chunk, plan, plan_update, plan_removed,
        // available_commands_update, current_mode_update, config_option_update,
        // session_info_update and the compaction updates have no MessagePart in
        // the contract, so they are dropped.
        break;
    }
  }

  private async onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const turn = this.current;
    // `RequestPermissionResponse.outcome` is itself the tagged outcome object.
    if (turn === null) return { outcome: { outcome: 'cancelled' } };
    const call = params.toolCall;
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

/** What a session was started with. A turn that differs on any of it needs its own. */
function sessionKey(ctx: TurnContext): string {
  return JSON.stringify({
    model: ctx.thread.model,
    effort: ctx.thread.effort,
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

// ---------------------------------------------------------------------------
// The probe: the models the agent itself lists
// ---------------------------------------------------------------------------

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
 * The `configOptions` of a `session/new` as a model list. The descriptor's
 * `default` model stays first so the user can always hand the choice back to
 * the agent; the agent's own values follow in its order, the current one
 * flagged. No `model` option means the agent has nothing to say: the
 * descriptor's models stand.
 */
function modelsFrom(provider: ProviderDescriptor, options: SessionConfigOption[] | null): ModelInfo[] {
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
async function readModels(ctx: ProbeContext, deps: AcpDeps): Promise<ModelInfo[]> {
  const sdk = await deps.loadSdk();
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) {
    throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
  }

  let lastStderr = '';
  const child = ctx.spawnChild(executable, profile?.launch?.args ?? [], {
    cwd: ctx.cwd,
    env: { ...process.env, ...ctx.accountEnv },
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
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    // No update handler and no permission handler: nothing of this session is
    // drawn, and a prompt never goes out on it.
    const open = sdk.client({ name: CLIENT_NAME }).connect(stream);
    connection = open;

    const read = (async (): Promise<SessionConfigOption[] | null> => {
      await open.agent.request('initialize', {
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: CLIENT_NAME, version: pkg.version },
      });
      const created = await open.agent.request('session/new', { cwd: ctx.cwd, mcpServers: [] });
      return created.configOptions ?? null;
    })();

    return modelsFrom(ctx.provider, await Promise.race([read, died, expired]));
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
        providerId: ctx.provider.id,
        accountId: ctx.accountId,
        running: null,
        result: null,
      };
      probes.set(key, entry);
      if (entry.result !== null) return entry.result;
      if (entry.running !== null) return entry.running;

      const running = readModels(ctx, deps).then((models) => ({ models, probedAt: Date.now() }));
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
        session.close(session.key === key ? null : 'the thread changed model, effort, account or folder', ctx);
        session = null;
      }
      if (session === null) {
        session = new AcpSession(key, warmMs, deps, (ended) => {
          if (sessions.get(threadId) === ended) sessions.delete(threadId);
        });
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
