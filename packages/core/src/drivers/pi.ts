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
 * `extension_ui_request`, which Boite has no part for and answers by cancelling.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageId, MessagePart, ThreadId, ToolStatus, Usage } from '@boite/contracts';
import { messageOf, unavailable } from '../errors.ts';
import { resolveDataDir } from '../paths.ts';
import type { SpawnedChild } from '../procs.ts';
import { profileFor, resolveExecutable } from '../providers/loader.ts';
import type { Driver, TurnContext, TurnHandle, TurnResult } from './types.ts';

const MINUTE_MS = 60_000;
const STDERR_MAX = 400;
/** How long a failed command waits for the child's exit before blaming itself. */
const EXIT_GRACE_MS = 500;
/** Where a thread's pi transcript lives, under the account's own directory. */
const SESSION_ROOT = 'pi-sessions';
/** The model id that means "the agent keeps the one it is configured with". */
const AGENT_OWN_MODEL = 'default';
/** The four `extension_ui_request` methods that block until the client answers. */
const UI_DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);

type Timer = ReturnType<typeof setTimeout>;

/** pi's `Usage`, the block an `AssistantMessage` carries. */
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** pi's `AssistantMessage`, the fields a `message_end` is read for. */
interface PiAssistantMessage {
  role?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
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
  private buffer = '';
  private closed = false;

  constructor(
    private readonly child: SpawnedChild,
    private readonly handlers: PeerHandlers,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.feed(chunk);
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

  private feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf('\n');
      if (at < 0) break;
      let line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim().length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.handlers.log('warn', `pi agent: a line that is not json: ${line.slice(0, STDERR_MAX)}`);
        continue;
      }
      this.dispatch(message);
    }
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
   * An assistant message that ended badly. pi keeps running after one (a retry,
   * a queued message), so it is remembered and `agent_settled` still decides.
   */
  noteError(reason: string): void {
    if (this.error !== null) return;
    this.error = reason;
    this.part(this.takeIndex(), { type: 'error', message: reason });
  }

  /** `agent_settled`: the run is over, whatever happened inside it. */
  settleRun(): void {
    if (this.decided) return;
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
  private queue: Promise<void> = Promise.resolve();
  private running = 0;
  private closing = false;
  private ended = false;
  /** One line per session, not one per question, when an extension asks something. */
  private warnedDialog = false;

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

  /** `abort` is pi's only stop; the run still settles, as aborted. */
  stopTurn(turn: PiTurn): void {
    if (turn.settled) return;
    turn.markStopped();
    if (this.current !== turn) return;
    const peer = this.peer;
    if (peer === null) return;
    void peer.command('abort').catch(() => undefined);
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

    turn.noteSession(sessionId);
    this.current = turn;
    try {
      await peer.command('prompt', { message: turn.ctx.prompt });
      if (turn.isStopped) void peer.command('abort').catch(() => undefined);
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
    this.current = null;
    this.endTurn(turn, turn.isStopped);
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
      ...(profile?.launch?.args ?? []),
      '--session-id',
      sessionId,
      '--session-dir',
      sessionDir,
      ...modelArgs(ctx),
    ];
    const child = ctx.spawnChild(executable, args, {
      cwd: ctx.thread.cwd,
      env: { ...process.env, ...ctx.accountEnv },
    });
    this.child = child;
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
    return Promise.resolve();
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

  /** The one teardown: the pipes go, then the child, through the registry. */
  private drop(): void {
    if (this.ended) return;
    this.ended = true;
    this.closing = true;
    this.clearIdle();
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

  private onEvent(ctx: TurnContext, message: Record<string, unknown>): void {
    const type = message['type'];
    if (type === 'extension_ui_request') {
      this.answerDialog(ctx, message);
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
        if (assistant.stopReason === 'error') {
          turn.noteError(assistant.errorMessage ?? 'the pi agent failed the turn');
        }
        break;
      }
      case 'agent_settled':
        turn.settleRun();
        break;
      default:
        // agent_start, agent_end, turn_start, turn_end, message_start, the
        // tool_execution_update, bash, queue, compaction and retry families:
        // the contract has no part for them, so they are dropped.
        break;
    }
  }

  /**
   * pi's only request back to the client. `select`, `confirm`, `input` and
   * `editor` block the agent until an answer with the same id arrives, and Boite
   * has no part for a free-form question, so they are cancelled: the extension
   * reads that as the user dismissing the dialog. The rest are fire and forget.
   */
  private answerDialog(ctx: TurnContext, message: Record<string, unknown>): void {
    const method = textOf(message['method']);
    if (!UI_DIALOGS.has(method)) return;
    const id = message['id'];
    if (typeof id !== 'string') return;
    if (!this.warnedDialog) {
      this.warnedDialog = true;
      ctx.log('warn', `pi: an extension asked the user a ${method}, which Boite refuses`);
    }
    this.peer?.answer({ type: 'extension_ui_response', id, cancelled: true });
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
 * own, because pi reads all of it once, on the command line. The permission mode
 * is not in here: pi has no approval gate in RPC mode, so nothing about it ever
 * reaches the agent and changing it would drop a process for nothing.
 */
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

/** One `pi --mode rpc` process per thread, kept between turns like the Codex one. */
export function createPiDriver(): Driver {
  const sessions = new Map<ThreadId, PiSession>();

  return {
    protocol: 'pi',

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
    },
  };
}
