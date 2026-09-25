/**
 * The client half of pi's RPC mode: `pi --mode rpc` over the agent's own stdio,
 * JSON objects one per line. Shaped like `codex.ts`, and like it with no SDK
 * behind it: pi ships `rpc-client.ts` inside its own package, not as a library,
 * so the peer below is the whole transport.
 *
 * The names used here are pi's own (`docs/rpc.md` of
 * `@earendil-works/pi-coding-agent`): the `prompt` and `abort` commands, the
 * `response` envelope that answers a command by its `id`, the `message_update`
 * deltas, the `tool_execution_*` events, `message_end` for the authoritative
 * assistant message and `agent_settled` for the end of a run.
 *
 * Two things about the wire are worth writing down. It is strict JSONL with LF
 * as the only delimiter, so nothing here may split on anything else. And pi has
 * no approval gate in RPC mode: the only request it sends back is an extension's
 * `extension_ui_request`, drawn as an inline question.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AccountId,
  AgentCommand,
  EffortLevel,
  ImageAttachment,
  MessageId,
  MessagePart,
  ModelInfo,
  ProviderDescriptor,
  ProviderId,
  ThreadId,
  ToolStatus,
  Usage,
} from '@boite/contracts';
import { messageOf, unavailable } from '../errors.ts';
import { resolveDataDir } from '../paths.ts';
import type { SpawnedChild } from '../procs.ts';
import { launchPrefix, profileFor, resolveExecutable } from '../providers/loader.ts';
import { LineSplitter } from './lines.ts';
import { ModelProbes } from './model-probes.ts';
import type {
  Driver,
  ProbeContext,
  ProbeFilter,
  ProbeResult,
  TurnContext,
  TurnHandle,
  TurnResult,
  PromptCacheLife,
} from './types.ts';
import { ANTHROPIC_DEFAULT, openAiCacheLife } from '../prompt-cache.ts';

/** The OpenAI Responses shapes pi sends to OpenAI's own endpoint, with an API key or a ChatGPT login. */
const PI_OPENAI_APIS = new Set(['openai-responses', 'openai-codex-responses']);

/**
 * The prompt cache lifetime one pi request left. On Anthropic pi passes the
 * API's own split through as `cacheWrite1h`, so the lifetime is reported; a
 * pi too old to carry the field gets Anthropic's default. On OpenAI's own
 * endpoint the model's published default applies, whatever `PI_CACHE_RETENTION`
 * asks for: on a pre-5.6 model its `long` is the 24 hour retention an
 * organization already defaults to, and from 5.6 on it is the 30 minutes that
 * are the default anyway. Anything else has no published lifetime. A request
 * that wrote nothing on Anthropic names nothing, like the Claude driver.
 */
export function piCacheLife(message: PiAssistantMessage): PromptCacheLife | null {
  const usage = message.usage;
  if (message.api === 'anthropic-messages' && message.provider === 'anthropic') {
    if (usage === undefined || (usage.cacheWrite ?? 0) <= 0) return null;
    if (usage.cacheWrite1h === undefined) return ANTHROPIC_DEFAULT;
    return usage.cacheWrite1h > 0 ? { ttlSeconds: 3600, source: 'reported' } : { ttlSeconds: 300, source: 'reported' };
  }
  if (message.api !== undefined && PI_OPENAI_APIS.has(message.api) && (message.provider === 'openai' || message.provider === 'openai-codex')) {
    return openAiCacheLife(message.model ?? null);
  }
  return null;
}

const MINUTE_MS = 60_000;
const STDERR_MAX = 400;
/** How long a failed command waits for the child's exit before blaming itself. */
const EXIT_GRACE_MS = 500;
/** How long a probe waits for the three commands it sends before giving up. */
const PROBE_TIMEOUT_MS = 30_000;
/** Where a thread's pi transcript lives, under the account's own directory. */
const SESSION_ROOT = 'pi-sessions';
/** The model id that means "the agent keeps the one it is configured with". */
const AGENT_OWN_MODEL = 'default';
/** The four `extension_ui_request` methods that block until the client answers. */
const UI_DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
/** The `extension_ui_request` methods pi sends and expects no answer to (`docs/rpc-extension-ui.md`). */
const UI_NOTICES = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']);
/**
 * How long a stopped turn waits for `agent_settled` after `abort` before the
 * process is closed. pi's abort waits for its tool trees to die, and a Windows
 * taskkill can take seconds; Muse gives its host 30 s.
 */
const STOP_DEADLINE_MS = 15_000;
let stopDeadlineMs = STOP_DEADLINE_MS;
/** How long the context read after a turn waits for `get_session_stats`. */
const STATS_TIMEOUT_MS = 5_000;

/** Tests shorten the stop deadline; `null` puts the default back. */
export function setPiStopDeadlineForTests(ms: number | null): void {
  stopDeadlineMs = ms ?? STOP_DEADLINE_MS;
}

/**
 * What every pi process Boite starts gets on top of the environment, turns and
 * probes alike. pi does network work of its own on a cold start; these two stop
 * the part Boite has no use for and leave the rest alone.
 *
 * `PI_SKIP_VERSION_CHECK` drops the `pi.dev` latest-version request
 * (`dist/utils/version-check.js`), `PI_TELEMETRY=0` drops the install and update
 * telemetry and the provider attribution headers (`dist/core/telemetry.js`).
 *
 * `PI_OFFLINE` is deliberately not among them, even though it covers both. It
 * also turns off `ModelRuntime.modelNetworkEnabled`, which a later `refresh()`
 * falls back to (`dist/core/model-runtime.js`), so the remote model catalog is
 * never read and the models probe answers with a shorter list: measured twice on
 * the same configuration, 51 models with it against 53 without.
 */
const AGENT_ENV: Record<string, string> = {
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
};

/** `process.env` plus what Boite forces, plus the account's own isolation, which wins. */
function agentEnv(accountEnv: Record<string, string>): Record<string, string | undefined> {
  return { ...process.env, ...AGENT_ENV, ...accountEnv };
}

/** One `ImageContent` per attachment, `data` and `mimeType` as `docs/rpc.md` names them. */
function imagesOf(attachments: ImageAttachment[]): { type: 'image'; data: string; mimeType: string }[] {
  return attachments.map((attachment) => ({
    type: 'image' as const,
    data: attachment.data,
    mimeType: attachment.mimeType,
  }));
}

type Timer = ReturnType<typeof setTimeout>;

/** pi's `Usage`, the block an `AssistantMessage` carries. */
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** The part of `cacheWrite` written with the one-hour lifetime. Only Anthropic reports the split. */
  cacheWrite1h?: number;
  cost?: { total?: number };
}

/** pi's `AssistantMessage`, the fields a `message_end` is read for. */
interface PiAssistantMessage {
  role?: string;
  /** The wire protocol the request went out on, `anthropic-messages` or `openai-responses` for instance. */
  api?: string;
  provider?: string;
  model?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

/** One entry of `get_commands`: extension commands, prompt templates and skills alike. */
interface PiCommand {
  name?: string;
  description?: string;
  source?: string;
  location?: string;
  path?: string;
}

/** `get_commands`' list as the contract's `AgentCommand`. pi carries no argument hint. */
function commandsOf(list: PiCommand[]): AgentCommand[] {
  const commands: AgentCommand[] = [];
  for (const entry of list) {
    if (entry.name === undefined || entry.name.length === 0) continue;
    commands.push({ name: entry.name, description: entry.description ?? null, hint: null });
  }
  return commands;
}

// ---------------------------------------------------------------------------
// The transport: one JSON object per line, both ways
// ---------------------------------------------------------------------------

interface PeerHandlers {
  event(message: Record<string, unknown>): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

/**
 * pi's RPC framing: commands out, responses and events in, one JSON object per
 * line. A command carries an `id` and its `response` carries the same one, so a
 * command that has to be waited on is a promise keyed by that id. Everything
 * else on the way in is an event.
 *
 * Records split on `\n` only, and a trailing `\r` is stripped: `U+2028` and
 * `U+2029` are valid inside a JSON string and pi says so in its own docs.
 */
class PiPeer {
  private nextId = 1;
  private readonly pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  private readonly lines = new LineSplitter((line) => {
    this.onLine(line);
  });
  private closed = false;

  constructor(
    private readonly child: SpawnedChild,
    private readonly handlers: PeerHandlers,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.lines.feed(chunk);
    });
    child.stdin.on('error', () => undefined);
  }

  /** Sends a command and waits for the `response` that carries the same id. */
  command(type: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = `boite-${this.nextId}`;
    this.nextId += 1;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`the pi agent is gone, ${type} was not sent`));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.write({ id, type, ...params });
    });
  }

  /** An answer to something pi asked, which carries pi's own id and no response. */
  answer(payload: Record<string, unknown>): void {
    this.write(payload);
  }

  /** The child is gone: every command still waiting is answered, loudly. */
  fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) entry.reject(new Error(reason));
  }

  private write(payload: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // the pipe is already gone; the exit path says what happened
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.handlers.log('warn', `pi agent: a line that is not json: ${line.slice(0, STDERR_MAX)}`);
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: Record<string, unknown>): void {
    if (message['type'] !== 'response') {
      this.handlers.event(message);
      return;
    }
    const id = message['id'];
    if (typeof id !== 'string') return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    if (message['success'] === false) {
      const error = message['error'];
      entry.reject(new Error(typeof error === 'string' ? error : `pi refused ${String(message['command'])}`));
      return;
    }
    entry.resolve(message);
  }
}

// ---------------------------------------------------------------------------
// The turn and what it draws
// ---------------------------------------------------------------------------

interface ToolEntry {
  index: number;
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}

/** What one `tool_execution_*` event is drawn as. */
interface ToolView {
  name: string;
  input?: unknown;
  output: string | null;
  status: ToolStatus;
}

/**
 * One `prompt` command and what it wrote. The parts are drawn the way every
 * other driver draws them: one text part the deltas append to, one thinking
 * part, one part per tool call.
 */
class PiTurn {
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

// ---------------------------------------------------------------------------
// The session: one agent process per thread
// ---------------------------------------------------------------------------

/**
 * One `pi --mode rpc` process for a thread: launched on the thread's own
 * `--session-id` and `--session-dir`, so a later process reopens the transcript
 * the first one wrote. With `warmProcessMinutes` at zero the process goes with
 * the turn; above zero it takes the next turns of the thread until the idle
 * window, a stop, an archive, core shutdown or a changed setup ends it.
 */
class PiSession {
  private child: SpawnedChild | null = null;
  private peer: PiPeer | null = null;
  private starting: Promise<void> | null = null;

  /** The pi session id: what `ctx.sessionId` stores and the next process reopens. */
  private sessionId: string | null = null;
  private lastStderr = '';
  private exitCode: number | null = null;
  private exited: Promise<number | null> | null = null;
  private idle: Timer | null = null;
  /** The turn whose `prompt` is in flight; events outside one are dropped. */
  private current: PiTurn | null = null;
  private steered = false;
  private queue: Promise<void> = Promise.resolve();
  private running = 0;
  private closing = false;
  private ended = false;
  /** Ends every process of the thread: the agent and whatever its tools left running. */
  private killTree: (() => void) | null = null;
  /** The model and the thinking level the process is on, so a warm turn only sends a change. */
  private model: string | null = null;
  private effort: string | null = null;

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly onEnded: (session: PiSession) => void,
  ) {}

  /** Reusable only while the process is up and the turn asks for the very same setup. */
  usable(key: string, warmMs: number): boolean {
    return !this.ended && !this.closing && this.key === key && warmMs > 0 && this.warmMs > 0;
  }

  busy(): boolean {
    return this.running > 0;
  }

  attach(turn: PiTurn, warmMs: number): void {
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

  /**
   * `abort` is pi's only stop; the run still settles, as aborted. A turn not
   * yet running sends nothing: `runTurn` sees the stop before its prompt.
   */
  stopTurn(turn: PiTurn): void {
    if (turn.settled) return;
    turn.markStopped();
    if (this.current !== turn) return;
    if (turn.ctx.turn.execution?.operation === 'compact') {
      turn.settleRun();
      this.drop();
      return;
    }
    const peer = this.peer;
    if (peer === null) return;
    this.abort(turn, peer);
  }

  /**
   * `abort`, after `clear_queue` when coordination steered the run, since pi
   * may continue queued steering after an abort. A refused command is not a
   * failed turn: the deadline still ends it as stopped.
   *
   * An idle pi answers `abort` and emits nothing, which is what a prompt still
   * in preflight (an extension dialog) or an extension command leaves behind.
   * `get_state` after the answer says whether a run is still going: pi writes
   * in order, so a run that ended has sent `agent_settled` before it.
   */
  private abort(turn: PiTurn, peer: PiPeer): void {
    const cleared = this.steered ? peer.command('clear_queue').catch(() => undefined) : Promise.resolve(undefined);
    void cleared
      .then(() => peer.command('abort'))
      .then(() => peer.command('get_state'))
      .then((state) => {
        if (!turn.decided && dataOf(state)['isStreaming'] !== true) turn.settleRun();
      })
      .catch(() => undefined);
    this.armStopDeadline(turn);
  }

  /**
   * A pi that does not settle after `abort` (an extension tool that ignores the
   * signal, a blocked event loop) is closed: the turn ends stopped, then the
   * process and every tool it started go. Stopped first, or the child's close
   * would fail the turn.
   */
  private armStopDeadline(turn: PiTurn): void {
    if (turn.stopDeadline) return;
    turn.stopDeadline = true;
    const ms = stopDeadlineMs;
    const timer = setTimeout(() => {
      if (turn.decided) return;
      turn.ctx.log('warn', `pi: the agent did not settle within ${ms / 1000} s of abort, closing it`);
      turn.settleRun();
      this.drop();
    }, ms);
    timer.unref?.();
    void turn.finished.then(() => {
      clearTimeout(timer);
    });
  }

  /** Submit attributed coordination at pi's next tool boundary. */
  async steer(turn: PiTurn, message: string): Promise<boolean> {
    if (this.current !== turn || turn.settled || turn.isStopped || !this.peer) return false;
    this.steered = true;
    await this.peer.command('steer', { message });
    return true;
  }

  /** Archive, shutdown, an idle window, a changed setup: the process goes. */
  close(reason: string | null, ctx?: TurnContext): void {
    if (this.ended) return;
    this.closing = true;
    if (reason !== null && ctx !== undefined) ctx.log('warn', `pi session: ${reason}`);
    this.drop();
  }

  // -- the turn -------------------------------------------------------------

  private async runTurn(turn: PiTurn): Promise<void> {
    // A turn stopped while it waited for the process sends nothing to the model.
    if (turn.isStopped) {
      turn.settleRun();
      this.endTurn(turn, false);
      return;
    }
    try {
      await this.start(turn.ctx);
    } catch (error) {
      turn.fail(messageOf(error));
      this.endTurn(turn, true);
      return;
    }

    const peer = this.peer;
    const sessionId = this.sessionId;
    if (peer === null || sessionId === null) {
      turn.fail('the pi session went away before the turn');
      this.endTurn(turn, true);
      return;
    }
    if (turn.isStopped) {
      turn.settleRun();
      this.endTurn(turn, false);
      return;
    }

    turn.noteSession(sessionId);
    this.current = turn;
    this.steered = false;
    try {
      await this.align(turn.ctx, peer);
      if (turn.isStopped) {
        turn.settleRun();
      } else if (turn.ctx.turn.execution?.operation === 'compact') {
        const result = dataOf(await peer.command('compact')) as { tokensBefore?: unknown; estimatedTokensAfter?: unknown; usage?: PiUsage };
        if (result.usage !== undefined && result.usage !== null) turn.addUsage(result.usage);
        turn.part(turn.takeIndex(), {
          type: 'compaction',
          trigger: 'manual',
          preTokens: numberOf(result.tokensBefore) ?? turn.ctx.thread.context?.tokens ?? null,
          postTokens: numberOf(result.estimatedTokensAfter),
        });
        turn.settleRun();
      } else {
        await peer.command('prompt', {
          message: turn.ctx.prompt,
          ...(turn.ctx.attachments.length === 0 ? {} : { images: imagesOf(turn.ctx.attachments) }),
        });
        if (turn.isStopped) this.abort(turn, peer);
        else await this.settleIfIdle(turn, peer);
      }
    } catch (error) {
      // A child that died takes the pipe with it, and its exit says more than
      // "the command failed": give it a moment to be reported.
      const code = await this.exitWithin(EXIT_GRACE_MS);
      turn.fail(code === undefined ? messageOf(error) : this.exitSentence(code));
      this.current = null;
      this.endTurn(turn, true);
      return;
    }

    await turn.finished;
    await this.readContext(turn, peer);
    this.current = null;
    this.endTurn(turn, turn.isStopped);
  }

  /**
   * A warm process on another model or level than the thread now wants. pi
   * takes both over RPC (`set_model`, `set_thinking_level`), so the process
   * stays. `set_model` clamps the level to the new model, so the level is sent
   * again after it. A refusal fails the turn with pi's own sentence and drops
   * the process, and the next turn launches with `--model`.
   */
  private async align(ctx: TurnContext, peer: PiPeer): Promise<void> {
    const model = ctx.thread.model;
    if (model === null || model === AGENT_OWN_MODEL) return;
    let changed = false;
    if (model !== this.model) {
      const slash = model.indexOf('/');
      if (slash <= 0 || slash === model.length - 1) {
        throw new Error(`pi cannot switch to the model ${model}: its id is not <provider>/<id>`);
      }
      await peer.command('set_model', { provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
      this.model = model;
      changed = true;
    }
    const effort = ctx.thread.effort;
    if (effort !== null && (changed || effort !== this.effort)) {
      await peer.command('set_thinking_level', { level: effort });
      this.effort = effort;
    }
  }

  /**
   * A prompt pi handled without a run: an extension command, or an input
   * handler that consumed the text. pi answers the prompt and never emits
   * `agent_settled`. pi marks a run active in the same tick it answers the
   * prompt and writes in order, so `get_state` sent now says `isStreaming` for
   * a run that started, and a run that already ended has settled before the
   * answer. A refused `get_state` leaves the turn to `agent_settled`.
   */
  private async settleIfIdle(turn: PiTurn, peer: PiPeer): Promise<void> {
    let state: Record<string, unknown>;
    try {
      state = dataOf(await peer.command('get_state'));
    } catch (error) {
      turn.ctx.log('warn', `pi: get_state after the prompt failed: ${messageOf(error)}`);
      return;
    }
    if (!turn.decided && state['isStreaming'] !== true) turn.settleRun();
  }

  /**
   * The context meter, read once the run is over: `get_session_stats` carries
   * the tokens pi counts against the window. `tokens` is null right after a
   * compaction, until the next answer, so nothing is written then.
   */
  private async readContext(turn: PiTurn, peer: PiPeer): Promise<void> {
    if (this.peer !== peer) return;
    let timer: Timer | undefined;
    try {
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no answer in ${STATS_TIMEOUT_MS / 1000} s`));
        }, STATS_TIMEOUT_MS);
        timer.unref?.();
      });
      const stats = dataOf(await Promise.race([peer.command('get_session_stats'), expired]));
      const usage = (stats['contextUsage'] ?? {}) as { tokens?: unknown; contextWindow?: unknown };
      const tokens = numberOf(usage.tokens);
      if (tokens !== null) turn.ctx.context({ tokens, window: numberOf(usage.contextWindow) });
    } catch (error) {
      turn.ctx.log('warn', `pi: get_session_stats failed: ${messageOf(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private endTurn(turn: PiTurn, drop: boolean): void {
    turn.settle();
    this.running = Math.max(0, this.running - 1);
    if (drop || this.closing || this.warmMs <= 0) {
      this.drop();
      return;
    }
    if (this.running === 0) this.armIdle();
  }

  // -- the process ----------------------------------------------------------

  private start(ctx: TurnContext): Promise<void> {
    if (this.starting === null) this.starting = this.open(ctx);
    return this.starting;
  }

  private open(ctx: TurnContext): Promise<void> {
    const profile = profileFor(ctx.provider);
    const executable = profile === undefined ? null : resolveExecutable(profile);
    if (executable === null) {
      throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
    }

    // The id is the thread's for its whole life: the first turn mints one, every
    // later process is launched with the same one and reopens that transcript.
    const sessionId = ctx.sessionId ?? crypto.randomUUID();
    const sessionDir = sessionDirOf(ctx);
    try {
      mkdirSync(sessionDir, { recursive: true });
    } catch (error) {
      throw unavailable(`the pi session directory ${sessionDir} could not be made: ${messageOf(error)}`, {
        providerId: ctx.provider.id,
      });
    }

    const args = [
      ...launchPrefix(profile),
      ...(profile?.launch?.args ?? []),
      '--session-id',
      sessionId,
      '--session-dir',
      sessionDir,
      ...modelArgs(ctx),
    ];
    const child = ctx.spawnChild(executable, args, {
      cwd: ctx.thread.cwd,
      env: agentEnv(ctx.accountEnv),
    });
    this.child = child;
    this.killTree = ctx.killTree ?? null;
    this.model = ctx.thread.model;
    this.effort = ctx.thread.effort;
    const peer = new PiPeer(child, {
      event: (message) => {
        this.onEvent(ctx, message);
      },
      log: (level, message) => {
        ctx.log(level, message);
      },
    });
    this.peer = peer;
    this.sessionId = sessionId;
    this.watch(child, ctx, peer);
    // pi's RPC mode has no approval call: there is nothing to gate a tool on, so
    // the thread's permission mode is a preference the agent never sees.
    ctx.log('info', 'pi session: the permission mode is not enforced, pi has no approval gate in rpc mode');
    // Once per process, not per turn: `open` runs once for the life of the
    // session, memoized behind `start`. Not awaited, so a slow or unknown
    // command never holds up the turn that started this process.
    void this.fetchCommands(ctx, peer);
    return Promise.resolve();
  }

  /** `get_commands`: a refusal or a dead peer is one warning, never a failed turn. */
  private async fetchCommands(ctx: TurnContext, peer: PiPeer): Promise<void> {
    try {
      const data = dataOf(await peer.command('get_commands'));
      const list = Array.isArray(data['commands']) ? (data['commands'] as PiCommand[]) : [];
      ctx.commands(commandsOf(list));
    } catch (error) {
      ctx.log('warn', `pi: get_commands failed: ${messageOf(error)}`);
    }
  }

  private watch(child: SpawnedChild, ctx: TurnContext, peer: PiPeer): void {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim();
        if (text.length === 0) continue;
        this.lastStderr = text.slice(0, STDERR_MAX);
        ctx.log('warn', `pi agent: ${this.lastStderr}`);
      }
    });
    this.exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        this.exitCode = code;
        resolve(code);
      });
      // `close` and not `exit`: stderr is flushed by then, so the sentence the
      // turn fails with carries the line the agent printed on its way out.
      child.once('close', () => {
        const sentence = this.exitSentence(this.exitCode);
        peer.fail(sentence);
        this.current?.fail(sentence);
        if (!this.closing) this.drop();
      });
      child.once('error', (error) => {
        resolve(null);
        const sentence = `the pi agent did not start: ${messageOf(error)}`;
        peer.fail(sentence);
        this.current?.fail(sentence);
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
    const head = `the pi agent exited with code ${code === null ? 'unknown' : code}`;
    return this.lastStderr.length === 0 ? head : `${head}: ${this.lastStderr}`;
  }

  /**
   * The one teardown: the pipes go, then the child and whatever its tools
   * started, through the registry. A turn still in flight ends here, while the
   * journal is still open, rather than from the child's `close`, which can
   * land after core shutdown closed it.
   */
  private drop(): void {
    if (this.ended) return;
    this.ended = true;
    this.closing = true;
    this.clearIdle();
    const turn = this.current;
    this.current = null;
    turn?.fail('the pi session was closed');
    this.peer?.fail('the pi session was closed');
    this.peer = null;
    const child = this.child;
    this.child = null;
    if (child !== null) {
      try {
        child.stdin.end();
      } catch {
        // the pipe is already gone
      }
      try {
        // The bash tool's children (a dev server started with `&`) are not
        // pi's to reap once bash exits; the thread's tree is. On Linux and
        // macOS the tree is the direct children only, which is `kill()`.
        if (this.killTree !== null) this.killTree();
        else child.kill();
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

  private onEvent(ctx: TurnContext, message: Record<string, unknown>): void {
    const type = message['type'];
    if (type === 'extension_ui_request') {
      void this.answerDialog(ctx, message).catch((error) => ctx.log('warn', `pi question: ${messageOf(error)}`));
      return;
    }
    if (type === 'extension_error') {
      ctx.log('warn', `pi extension ${textOf(message['extensionPath'])}: ${textOf(message['error'])}`);
      return;
    }
    const turn = this.current;
    if (turn === null) return;
    switch (type) {
      case 'message_update': {
        const delta = (message['assistantMessageEvent'] ?? {}) as Record<string, unknown>;
        if (delta['type'] === 'text_delta') turn.writeText(textOf(delta['delta']));
        else if (delta['type'] === 'thinking_delta') turn.writeThinking(textOf(delta['delta']));
        break;
      }
      case 'tool_execution_start': {
        const toolCallId = textOf(message['toolCallId']);
        if (toolCallId.length === 0) break;
        turn.upsertTool(toolCallId, {
          name: textOf(message['toolName']),
          input: message['args'] ?? null,
          output: null,
          status: 'running',
        });
        break;
      }
      case 'tool_execution_end': {
        const toolCallId = textOf(message['toolCallId']);
        if (toolCallId.length === 0) break;
        turn.upsertTool(toolCallId, {
          name: textOf(message['toolName']),
          output: contentText(message['result']),
          status: message['isError'] === true ? 'error' : 'done',
        });
        break;
      }
      case 'message_end': {
        const assistant = message['message'] as PiAssistantMessage | undefined;
        if (assistant === undefined || assistant.role !== 'assistant') break;
        if (assistant.usage !== undefined) turn.addUsage(assistant.usage);
        turn.cacheLife = piCacheLife(assistant) ?? turn.cacheLife;
        turn.noteOutcome(assistant.stopReason === 'error' ? (assistant.errorMessage ?? 'the pi agent failed the turn') : null);
        break;
      }
      case 'auto_retry_start':
        turn.ctx.log(
          'info',
          `pi: retrying the request (attempt ${String(message['attempt'])} of ${String(message['maxAttempts'])}, in ${String(message['delayMs'])} ms): ${textOf(message['errorMessage'])}`,
        );
        break;
      case 'auto_retry_end':
        if (message['success'] === false) {
          turn.noteOutcome(textOf(message['finalError']) || turn.pendingError || 'pi gave up retrying the request');
        }
        break;
      case 'compaction_end':
        this.onCompaction(turn, message);
        break;
      case 'agent_settled':
        turn.settleRun();
        break;
      default:
        // agent_start, agent_end, turn_start, turn_end, message_start, the
        // tool_execution_update, bash and queue families: the contract has no
        // part for them, so they are dropped.
        break;
    }
  }

  /**
   * An automatic compaction, on a threshold or to recover from an overflow,
   * drawn as the divider a manual one gets. A manual one is the `compact`
   * command's, which draws its own from the response.
   */
  private onCompaction(turn: PiTurn, message: Record<string, unknown>): void {
    const reason = textOf(message['reason']);
    if (reason === 'manual' || message['aborted'] === true) return;
    const result = message['result'] as { tokensBefore?: unknown; estimatedTokensAfter?: unknown; usage?: PiUsage } | undefined | null;
    if (result === undefined || result === null) {
      turn.ctx.log('warn', `pi: the automatic compaction failed: ${textOf(message['errorMessage']) || 'no reason given'}`);
      return;
    }
    if (result.usage !== undefined && result.usage !== null) turn.addUsage(result.usage);
    turn.part(turn.takeIndex(), {
      type: 'compaction',
      trigger: 'auto',
      preTokens: numberOf(result.tokensBefore),
      postTokens: numberOf(result.estimatedTokensAfter),
    });
  }

  /**
   * pi's only request back to the client. `select`, `confirm`, `input` and
   * `editor` block the agent until an answer with the same id arrives.
   */
  private async answerDialog(ctx: TurnContext, message: Record<string, unknown>): Promise<void> {
    const method = textOf(message['method']);
    if (UI_NOTICES.has(method)) {
      this.onNotice(ctx, method, message);
      return;
    }
    const id = message['id'];
    const peer = this.peer;
    // Nothing can be answered without the id the agent waits on, and nothing is
    // waiting once the process is gone.
    if (typeof id !== 'string') {
      ctx.log('warn', `pi: an ${method || 'unnamed'} dialog arrived with no id, nothing can answer it`);
      return;
    }
    if (peer === null) return;
    // The turn running now, not the one that opened the process: a warm session
    // outlives its first turn, and both the card and the journal row belong to
    // whoever is running when the dialog arrives.
    const turn = this.current;
    if (turn === null || !UI_DIALOGS.has(method)) {
      // A refusal is the answer pi defines for a dialog the client will not
      // draw. Dropping it silently leaves the extension blocked inside a
      // process that stays warm, on an id nobody will ever answer.
      const why = turn === null ? 'no turn is running' : 'boite draws no card for that method';
      ctx.log('warn', `pi: the ${method} dialog ${id} is refused, ${why}`);
      peer.answer({ type: 'extension_ui_response', id, cancelled: true });
      return;
    }
    const live = turn.ctx;
    const choices = Array.isArray(message['options']) ? message['options'].filter((option): option is string => typeof option === 'string') : [];
    const options = method === 'confirm'
      ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]
      : choices.map((label, index) => ({ id: String(index), label }));
    const ask = {
      text: [textOf(message['title']) || 'pi asks', textOf(message['message']), textOf(message['prefill'])].filter(Boolean).join('\n\n'),
      options, allowText: method === 'input' || method === 'editor', multiple: false,
    };
    const ticket = live.askQuestion(ask);
    const index = turn.takeIndex();
    turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer: null });
    // A dialog with a `timeout` resolves itself on pi's side with its default
    // once the time is up, and the agent goes on: the card goes with it.
    const timeout = typeof message['timeout'] === 'number' && message['timeout'] > 0 ? message['timeout'] : null;
    let timer: Timer | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      if (timeout === null) return;
      timer = setTimeout(() => {
        resolve('expired');
      }, timeout);
      timer.unref?.();
    });
    const answer = await Promise.race([ticket, turn.stopped.then(() => null), expired]);
    clearTimeout(timer);
    if (answer === 'expired') {
      live.withdrawQuestion?.(ticket.questionId);
      turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer: null });
      return;
    }
    if (answer === null) { peer.answer({ type: 'extension_ui_response', id, cancelled: true }); return; }
    turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer });
    const value = method === 'select' ? options.find((option) => option.id === answer.optionIds[0])?.label : answer.text ?? '';
    peer.answer(method === 'confirm'
      ? { type: 'extension_ui_response', id, confirmed: answer.optionIds[0] === 'yes' }
      : { type: 'extension_ui_response', id, value });
  }

  /**
   * The UI methods pi expects no answer to. A `notify` is what an extension
   * command often says instead of running the model, so it is drawn in the
   * turn; an error notice is an error card, but it does not fail the turn.
   * Status lines, widgets, window titles and editor text have no place in a
   * chat and are dropped.
   */
  private onNotice(ctx: TurnContext, method: string, message: Record<string, unknown>): void {
    if (method !== 'notify') return;
    const text = textOf(message['message']);
    if (text.length === 0) return;
    const turn = this.current;
    if (turn === null) {
      ctx.log('info', `pi extension: ${text}`);
      return;
    }
    turn.part(
      turn.takeIndex(),
      textOf(message['notifyType']) === 'error' ? { type: 'error', message: text } : { type: 'text', text: `pi: ${text}` },
    );
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A `ToolResult`, whose `content` is the block list every pi tool answers with.
 * The text blocks are the output the card shows; anything else is described
 * rather than dropped, so a card is never silently empty.
 */
function contentText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return stringify(value);
  const parts: string[] = [];
  for (const block of content) {
    const entry = block as Record<string, unknown>;
    if (entry['type'] === 'text') parts.push(textOf(entry['text']));
    else parts.push(`[${textOf(entry['type']) || 'content'}]`);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return String(value);
  }
}

/**
 * Where this thread's transcript lives: its own directory under the account's
 * isolation directory, or under the core's data directory for an account on the
 * provider's own location, which must never write into the user's real `~/.pi`.
 */
function sessionDirOf(ctx: TurnContext): string {
  const base = ctx.account.isolationDir ?? resolveDataDir();
  return join(base, SESSION_ROOT, ctx.thread.id);
}

/**
 * pi takes the model on the command line and nowhere else at launch:
 * `--model provider/id`, with `:<thinking>` appended for the reasoning level.
 * `default` is Boite's own id for "the agent keeps its own", so it sends
 * nothing at all.
 */
function modelArgs(ctx: TurnContext): string[] {
  const model = ctx.thread.model;
  if (model === null || model === AGENT_OWN_MODEL) return [];
  return ['--model', ctx.thread.effort === null ? model : `${model}:${ctx.thread.effort}`];
}

/**
 * What a session was started with. A turn that differs on any of it needs its
 * own, because pi reads all of it once, on the command line. A change from one
 * named model or level to another is not in here: pi's RPC mode takes both on
 * a running session (`set_model`, `set_thinking_level`), which `align` sends.
 * Going back to pi's own model, or to no level at all, has no RPC call, so
 * whether the thread names each one is in the key. The permission mode is not
 * in here: pi has no approval gate in RPC mode, so nothing about it ever
 * reaches the agent and changing it would drop a process for nothing.
 */
function sessionKey(ctx: TurnContext): string {
  const model = ctx.thread.model;
  return JSON.stringify({
    ownModel: model === null || model === AGENT_OWN_MODEL,
    ownEffort: ctx.thread.effort === null,
    cwd: ctx.thread.cwd,
    accountId: ctx.account.id,
    providerId: ctx.provider.id,
    env: ctx.accountEnv,
  });
}

// ---------------------------------------------------------------------------
// The probe: the models pi itself lists
// ---------------------------------------------------------------------------

/** `Model` of `@earendil-works/pi-ai`, the fields the probe reads. */
interface PiModel {
  id?: string;
  name?: string;
  provider?: string;
  reasoning?: boolean;
  /** Per model: `null` drops a level, and `xhigh` or `max` exist only when present. */
  thinkingLevelMap?: Record<string, string | null>;
}

/**
 * `ThinkingLevel` in pi's own order, from `dist/cli/args.js`. `off` through
 * `high` are the standard scale; `xhigh` and `max` are opt-in per model.
 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The words the picker shows for pi's level ids. */
const EFFORT_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

function effortLabel(id: string): string {
  return EFFORT_LABELS[id] ?? `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`;
}

/**
 * The levels one model supports, exactly as pi decides them itself: the rule is
 * `getSupportedThinkingLevels` of `@earendil-works/pi-ai`
 * (`node_modules/@earendil-works/pi-ai/dist/models.js`). A model without
 * reasoning has `off` and nothing else, a level mapped to `null` is dropped, and
 * `xhigh` and `max` are only there when the model maps them.
 *
 * It is reproduced here rather than asked for because
 * `get_available_thinking_levels` answers for the model the session is on and
 * for no other, so reading the scale of five hundred models would mean five
 * hundred `set_model` round trips. The session's own answer is still read, as
 * the cross-check below.
 */
function supportedLevels(model: PiModel): string[] {
  if (model.reasoning !== true) return ['off'];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/**
 * A model's `ModelInfo.effort`. A scale of one level is no choice at all, which
 * is what a model without reasoning answers, so it carries no effort block.
 */
function effortOf(model: PiModel, wanted: string): ModelInfo['effort'] | null {
  const ids = supportedLevels(model);
  if (ids.length < 2) return null;
  const levels: EffortLevel[] = ids.map((id) => ({ id, label: effortLabel(id) }));
  return { levels, default: ids.includes(wanted) ? wanted : (ids[0] ?? '') };
}

/** pi's provider ids are lowercase; the picker shows them with a capital. */
function providerLabel(provider: string): string {
  return `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}`;
}

/** What one probe read from the agent, before any of it becomes a `ModelInfo`. */
interface PiListing {
  models: PiModel[];
  /** The model the session is on, as `<provider>/<id>`, or an empty string. */
  current: string;
  /** The thinking level the session is on, the default effort of every model. */
  thinkingLevel: string;
  /** `get_available_thinking_levels`: the scale of the current model, and of it alone. */
  sessionLevels: string[];
}

/**
 * A pi listing as a model list. The id is what `--model` takes, `<provider>/<id>`,
 * and the name carries the provider so two models called the same are told apart.
 * The descriptor's `default` stays first so the choice can always go back to
 * pi's own configuration, and it carries no effort of its own. An agent that
 * lists nothing, which is what an unauthenticated pi does, leaves the
 * descriptor's models standing.
 */
function modelsFrom(provider: ProviderDescriptor, listing: PiListing): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const own = provider.models.find((model) => model.id === AGENT_OWN_MODEL);
  if (own !== undefined) {
    models.push({ id: AGENT_OWN_MODEL, name: own.name, default: false });
    seen.add(AGENT_OWN_MODEL);
  }
  for (const entry of listing.models) {
    const id = entry.id ?? '';
    const providerId = entry.provider ?? '';
    if (id.length === 0 || providerId.length === 0) continue;
    const full = `${providerId}/${id}`;
    if (seen.has(full)) continue;
    seen.add(full);
    const effort = effortOf(entry, listing.thinkingLevel);
    models.push({
      id: full,
      name: `${providerLabel(providerId)} / ${entry.name ?? id}`,
      default: full === listing.current,
      ...(effort === null ? {} : { effort }),
    });
  }
  return models.length === (own === undefined ? 0 : 1) ? provider.models : models;
}

/** The `data` block of a `response`, or an empty record when there is none. */
function dataOf(answer: Record<string, unknown>): Record<string, unknown> {
  const data = answer['data'];
  return data === null || typeof data !== 'object' ? {} : (data as Record<string, unknown>);
}

/**
 * One short-lived `pi --mode rpc --no-session`: `get_state` for the model and the
 * level the session is on, `get_available_models` for the list, and
 * `get_available_thinking_levels` for the current model's own scale, which is
 * what `supportedLevels` is checked against. `--no-session` because a probe must
 * leave no transcript anywhere. The child goes through the registry that traced
 * it on every path; nothing of this process is kept.
 */
async function readModels(ctx: ProbeContext): Promise<ModelInfo[]> {
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) {
    throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
  }

  let lastStderr = '';
  const child = ctx.spawnChild(executable, [...launchPrefix(profile), ...(profile?.launch?.args ?? []), '--no-session'], {
    cwd: ctx.cwd,
    env: agentEnv(ctx.accountEnv),
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
      if (text.length > 0) lastStderr = text.slice(0, STDERR_MAX);
    }
  });

  const say = (head: string): string => (lastStderr.length === 0 ? head : `${head}: ${lastStderr}`);
  const detail = { providerId: ctx.provider.id, accountId: ctx.accountId };
  let timer: Timer | null = null;
  const peer = new PiPeer(child, {
    // A probe runs no turn: pi has nothing to stream and nothing to ask.
    event: () => undefined,
    log: (level, message) => {
      ctx.log(level, message);
    },
  });

  try {
    const died = new Promise<never>((_resolve, reject) => {
      child.once('exit', (code) => {
        reject(unavailable(say(`the ${ctx.provider.id} agent exited with code ${code ?? 'unknown'}`), detail));
      });
      child.once('error', (error) => {
        reject(unavailable(say(`the ${ctx.provider.id} agent did not start: ${messageOf(error)}`), detail));
      });
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          unavailable(
            say(`the ${ctx.provider.id} agent did not list its models in ${PROBE_TIMEOUT_MS / 1000} s`),
            detail,
          ),
        );
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
    });

    const read = (async (): Promise<PiListing> => {
      const state = dataOf(await peer.command('get_state'));
      const listed = dataOf(await peer.command('get_available_models'));
      const levels = dataOf(await peer.command('get_available_thinking_levels'));
      const current = (state['model'] ?? {}) as PiModel;
      const currentId =
        typeof current.id === 'string' && typeof current.provider === 'string'
          ? `${current.provider}/${current.id}`
          : '';
      return {
        models: Array.isArray(listed['models']) ? (listed['models'] as PiModel[]) : [],
        current: currentId,
        thinkingLevel: textOf(state['thinkingLevel']),
        sessionLevels: Array.isArray(levels['levels']) ? (levels['levels'] as string[]) : [],
      };
    })();

    const listing = await Promise.race([read, died, expired]);
    checkLevels(ctx, listing);
    return modelsFrom(ctx.provider, listing);
  } finally {
    if (timer !== null) clearTimeout(timer);
    peer.fail('the pi probe is over');
    try {
      child.stdin.end();
    } catch {
      // the pipe is already gone
    }
    ctx.killTree();
  }
}

/**
 * The one place pi answers a scale itself is the model the session is on, so
 * that answer is what says whether `supportedLevels` still matches pi's rule. A
 * mismatch means pi changed it: one warning naming both, never a silent list of
 * levels the agent would refuse.
 */
function checkLevels(ctx: ProbeContext, listing: PiListing): void {
  if (listing.sessionLevels.length === 0 || listing.current === '') return;
  const current = listing.models.find((model) => `${model.provider ?? ''}/${model.id ?? ''}` === listing.current);
  if (current === undefined) return;
  const computed = supportedLevels(current).join(',');
  const answered = listing.sessionLevels.join(',');
  if (computed === answered) return;
  ctx.log(
    'warn',
    `pi probe: the levels of ${listing.current} read as ${computed} but the agent answered ${answered}`,
  );
}

/** One `pi --mode rpc` process per thread, kept between turns like the Codex one. */
export function createPiDriver(): Driver {
  const sessions = new Map<ThreadId, PiSession>();
  const probes = new ModelProbes(readModels);

  return {
    protocol: 'pi',

    probe(ctx: ProbeContext): Promise<ProbeResult> {
      return probes.probe(ctx);
    },

    probedModels(providerId: ProviderId, accountId: AccountId): ModelInfo[] | null {
      return probes.models(providerId, accountId);
    },

    forgetProbes(filter: ProbeFilter = {}): void {
      probes.forget(filter);
    },

    startTurn(ctx: TurnContext): TurnHandle {
      const threadId = ctx.thread.id;
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const key = sessionKey(ctx);
      const turn = new PiTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs)) {
        sessions.delete(threadId);
        session.close(session.key === key ? null : 'the thread changed model, effort, account or folder', ctx);
        session = null;
      }
      if (session === null) {
        session = new PiSession(key, warmMs, (ended) => {
          if (sessions.get(threadId) === ended) sessions.delete(threadId);
        });
        sessions.set(threadId, session);
      }
      const running = session;
      running.attach(turn, warmMs);
      return {
        done: turn.done,
        steer: (message) => running.steer(turn, message),
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
      for (const session of open) session.close(null);
      probes.forget();
    },
  };
}
