/**
 * The client half of the Codex app-server protocol: `codex app-server` over the
 * agent's own stdio, JSON-RPC framed as ndjson. Shaped like `acp.ts`, but with
 * no SDK behind it: the app-server protocol ships as generated TypeScript, not
 * as a client library, so the peer below is the whole transport.
 *
 * The names used here are the ones `codex app-server generate-ts` writes:
 * `initialize` / `InitializeParams`, `thread/start` / `ThreadStartParams`,
 * `thread/resume` / `ThreadResumeParams`, `turn/start` / `TurnStartParams`,
 * `turn/interrupt`, the `item/*` notifications and the `item/*` server
 * requests. The wire has one surprise worth writing down: the server answers
 * without a `jsonrpc` member, so nothing here may require one.
 */
import type {
  AccountId,
  EffortLevel,
  ImageAttachment,
  MessageId,
  MessagePart,
  ModelInfo,
  PermissionMode,
  ProviderDescriptor,
  ProviderId,
  QuestionAnswer,
  QuestionOption,
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
  QuestionAsk,
  TurnContext,
  TurnHandle,
  TurnResult,
} from './types.ts';

/** What the agent sees as `clientInfo.name`. */
const CLIENT_NAME = 'boite';
const MINUTE_MS = 60_000;
const STDERR_MAX = 400;
/**
 * The model id that means "the agent keeps its own", the same spelling the ACP
 * driver uses. It is the descriptor's only model, and it is never sent on the
 * wire: Codex would refuse it as a model name.
 */
const AGENT_OWN_MODEL = 'default';
/** How long a probe waits for `initialize` and `model/list` before giving up. */
const PROBE_TIMEOUT_MS = 20_000;
/** `model/list` pages; a cursor loop that never ends is a bug, not a model list. */
const PROBE_MAX_PAGES = 10;
/** How long a failed request waits for the child's exit before blaming itself. */
const EXIT_GRACE_MS = 500;
/** Codex names no tool for a shell command, so the card carries the usual one. */
const COMMAND_TOOL_NAME = 'Bash';
/** Nor for a patch: `fileChange` is the apply-patch item under another name. */
const FILE_CHANGE_TOOL_NAME = 'ApplyPatch';

// ---------------------------------------------------------------------------
// The slice of the generated protocol this driver speaks
// ---------------------------------------------------------------------------

/** `AskForApproval`, minus the `granular` object this driver never sends. */
type AskForApproval = 'untrusted' | 'on-request' | 'never';
/** `SandboxMode`. */
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
/** `TurnStatus`. */
type CodexTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

/** `TurnError`. */
interface CodexTurnError {
  message?: string;
}

/** `Turn`, the fields an answer or a `turn/completed` is read for. */
interface CodexTurnRecord {
  id: string;
  status: CodexTurnStatus;
  error?: CodexTurnError | null;
}

/** `TokenUsageBreakdown`. */
interface CodexTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/** `ReasoningEffortOption`: the effort id plus the sentence the server describes it with. */
interface CodexReasoningEffortOption {
  reasoningEffort?: string;
  description?: string;
}

/** `Model`, the fields the probe reads. The rest of the record is not Boite's business. */
interface CodexModel {
  id?: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: CodexReasoningEffortOption[];
  defaultReasoningEffort?: string;
}

/** `ModelListResponse`. */
interface CodexModelListResponse {
  data?: CodexModel[];
  nextCursor?: string | null;
}

/**
 * `ThreadItem`, flattened. The wire is a tagged union of twenty-odd variants
 * and this driver draws four of them, so the fields are read off one shape
 * rather than discriminated: an item type nobody maps is dropped.
 */
interface CodexItem {
  type: string;
  id: string;
  status?: string;
  command?: string;
  cwd?: string | null;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: unknown;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | null;
  contentItems?: unknown;
}

/**
 * One entry of `item/tool/requestUserInput`'s `questions`. `options` is null on
 * a free-text question and, when it is a list, its entries are either plain
 * strings or objects: both spellings are read, because the wire has carried
 * both and neither is worth a refusal.
 */
interface CodexQuestion {
  id?: string;
  header?: string;
  question?: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: unknown;
}

/**
 * The thread's permission mode as the pair Codex takes: `approvalPolicy`
 * (`AskForApproval`) and `sandbox` (`SandboxMode`). Both go out on
 * `thread/start` and `thread/resume`.
 *
 * `acceptEdits` is the same pair as `default`: Codex has no "edits without
 * asking, commands with asking" step, and a workspace-write sandbox already
 * lets it edit inside the folder without a question. `plan` is the read-only
 * pair, so nothing can be written and nothing is ever asked.
 *
 * Unlike ACP's `session/set_mode`, Codex has no call that changes the pair on a
 * live thread, so the mode is part of the session key: changing it opens a new
 * process, which resumes the same Codex thread id with the new pair.
 */
const MODE_POLICY: Record<PermissionMode, { approvalPolicy: AskForApproval; sandbox: SandboxMode }> = {
  default: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'never', sandbox: 'read-only' },
  bypassPermissions: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
  dontAsk: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

type Timer = ReturnType<typeof setTimeout>;

// ---------------------------------------------------------------------------
// The transport: ndjson JSON-RPC over the child's stdio
// ---------------------------------------------------------------------------

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface RpcHandlers {
  notification(method: string, params: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

/**
 * One line of JSON per message, both ways. Requests carry an id and are
 * answered by it, notifications carry none, and a request the server sends is
 * answered by id too. Nothing here requires a `jsonrpc` member on the way in,
 * because the real app-server does not write one.
 */
class CodexRpc {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private closed = false;

  constructor(
    private readonly child: SpawnedChild,
    private readonly handlers: RpcHandlers,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.feed(chunk);
    });
    child.stdin.on('error', () => undefined);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`the codex agent is gone, ${method} was not sent`));
        return;
      }
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** The child is gone: every request still waiting is answered, loudly. */
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
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line.length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.handlers.log('warn', `codex agent: a line that is not json: ${line.slice(0, STDERR_MAX)}`);
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const method = message['method'];
    const id = message['id'];
    if (typeof method === 'string' && id !== undefined && id !== null) {
      void this.answer(id as number | string, method, message['params']);
      return;
    }
    if (typeof method === 'string') {
      this.handlers.notification(method, message['params']);
      return;
    }
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    const error = message['error'];
    if (error !== undefined && error !== null) {
      const text = (error as { message?: unknown }).message;
      entry.reject(new Error(typeof text === 'string' ? text : JSON.stringify(error)));
      return;
    }
    entry.resolve(message['result']);
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.request(method, params);
      this.write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32603, message: messageOf(error) } });
    }
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

/** What one Codex `ThreadItem` is drawn as, or null when the contract has no part for it. */
interface ToolView {
  name: string;
  input: unknown;
  output: string | null;
  status: ToolStatus;
}

/**
 * One `turn/start` and what it wrote. The parts are drawn the way every other
 * driver draws them: one text part the deltas append to, one part per item that
 * is a tool, one part per approval question.
 */
class CodexTurn {
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
  /** Resolves on `stop()`, so an approval still waiting can decline and move on. */
  readonly stopped: Promise<void>;

  sessionId: string | null;
  /** The Codex turn id, known once `turn/start` answers. */
  turnId: string | null = null;
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

  /** `turn/completed`, or a `turn/start` that already answered with a finished turn. */
  finish(record: CodexTurnRecord): void {
    if (this.decided) return;
    switch (record.status) {
      case 'completed':
        break;
      case 'interrupted':
        this.status = 'stopped';
        break;
      case 'failed':
        this.fail(record.error?.message ?? 'the codex agent failed the turn');
        return;
      default:
        return;
    }
    this.decided = true;
    this.decide();
  }

  fail(reason: string): void {
    if (this.decided) return;
    this.decided = true;
    this.status = 'error';
    this.error = reason;
    this.part(this.takeIndex(), { type: 'error', message: reason });
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

  /** `item/started` opens the part, `item/completed` replaces the same one by item id. */
  upsertTool(itemId: string, view: ToolView): void {
    const entry = this.tools.get(itemId) ?? {
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
    this.tools.set(itemId, entry);
    this.part(entry.index, {
      type: 'tool',
      toolId: itemId,
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
 * One `codex app-server` process for a thread: one `initialize`, one
 * `thread/start` or `thread/resume`, then one `turn/start` per turn. With
 * `warmProcessMinutes` at zero the process goes with the turn; above zero it
 * takes the next turns of the thread until the idle window, a stop, an archive,
 * core shutdown or a changed setup ends it.
 */
class CodexSession {
  private child: SpawnedChild | null = null;
  private rpc: CodexRpc | null = null;
  private starting: Promise<void> | null = null;

  /** The Codex thread id: what `ctx.sessionId` stores and `thread/resume` takes. */
  private threadId: string | null = null;
  private lastStderr = '';
  private exitCode: number | null = null;
  private exited: Promise<number | null> | null = null;
  private idle: Timer | null = null;
  /** The turn whose `turn/start` is in flight; notifications outside one are dropped. */
  private current: CodexTurn | null = null;
  private queue: Promise<void> = Promise.resolve();
  private running = 0;
  private closing = false;
  private ended = false;

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly onEnded: (session: CodexSession) => void,
  ) {}

  /** Reusable only while the process is up and the turn asks for the very same setup. */
  usable(key: string, warmMs: number): boolean {
    return !this.ended && !this.closing && this.key === key && warmMs > 0 && this.warmMs > 0;
  }

  busy(): boolean {
    return this.running > 0;
  }

  attach(turn: CodexTurn, warmMs: number): void {
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

  /** `turn/interrupt` is the only stop Codex has; `turn/completed` ends the turn. */
  stopTurn(turn: CodexTurn): void {
    if (turn.settled) return;
    // A stop that lands before `turn/start` answered is replayed the moment the
    // turn id arrives, so the order of the two never decides the outcome.
    turn.markStopped();
    if (this.current !== turn) return;
    this.interrupt(turn);
  }

  private interrupt(turn: CodexTurn): void {
    const rpc = this.rpc;
    const threadId = this.threadId;
    if (rpc === null || threadId === null || turn.turnId === null) return;
    void rpc.request('turn/interrupt', { threadId, turnId: turn.turnId }).catch(() => undefined);
  }

  /** Archive, shutdown, an idle window, a changed setup: the process goes. */
  close(reason: string | null, ctx?: TurnContext): void {
    if (this.ended) return;
    this.closing = true;
    if (reason !== null && ctx !== undefined) ctx.log('warn', `codex session: ${reason}`);
    this.drop();
  }

  // -- the turn -------------------------------------------------------------

  private async runTurn(turn: CodexTurn): Promise<void> {
    try {
      await this.start(turn.ctx);
    } catch (error) {
      turn.fail(messageOf(error));
      this.endTurn(turn, true);
      return;
    }

    const rpc = this.rpc;
    const threadId = this.threadId;
    if (rpc === null || threadId === null) {
      turn.fail('the codex session went away before the turn');
      this.endTurn(turn, true);
      return;
    }

    turn.noteSession(threadId);
    this.current = turn;
    const ctx = turn.ctx;
    try {
      // The thread as it stands for this turn, not as it stood when the
      // app-server thread opened: that is what carries a changed model or
      // effort to a process that stayed up.
      const model = modelOf(ctx);
      const started = await rpc.request<{ turn: CodexTurnRecord }>('turn/start', {
        threadId,
        input: [{ type: 'text', text: ctx.prompt, text_elements: [] }, ...imageInputsOf(ctx.attachments)],
        ...(model === null ? {} : { model }),
        ...(ctx.thread.effort === null ? {} : { effort: ctx.thread.effort }),
      });
      turn.turnId = started.turn.id;
      if (turn.isStopped) this.interrupt(turn);
      // A server that answers with a turn already finished settles it here;
      // the one that answers `inProgress` settles on `turn/completed`.
      turn.finish(started.turn);
    } catch (error) {
      // A child that died takes the connection with it, and its exit says more
      // than "the request failed": give it a moment to be reported.
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

  private endTurn(turn: CodexTurn, drop: boolean): void {
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

  private async open(ctx: TurnContext): Promise<void> {
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
    const rpc = new CodexRpc(child, {
      notification: (method, params) => {
        this.onNotification(method, params);
      },
      request: (method, params) => this.onRequest(ctx, method, params),
      log: (level, message) => {
        ctx.log(level, message);
      },
    });
    this.rpc = rpc;
    this.watch(child, ctx, rpc);

    await rpc.request('initialize', {
      clientInfo: { name: CLIENT_NAME, title: null, version: pkg.version },
      capabilities: null,
    });
    rpc.notify('initialized', {});

    const policy = MODE_POLICY[ctx.thread.permissionMode];
    const model = modelOf(ctx);
    if (ctx.sessionId !== null) {
      const resumed = await rpc.request<{ thread: { id: string } }>('thread/resume', {
        threadId: ctx.sessionId,
        cwd: ctx.thread.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        ...(model === null ? {} : { model }),
        excludeTurns: true,
      });
      this.threadId = resumed.thread.id;
      return;
    }

    const created = await rpc.request<{ thread: { id: string } }>('thread/start', {
      cwd: ctx.thread.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(model === null ? {} : { model }),
    });
    this.threadId = created.thread.id;
  }

  private watch(child: SpawnedChild, ctx: TurnContext, rpc: CodexRpc): void {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim();
        if (text.length === 0) continue;
        this.lastStderr = text.slice(0, STDERR_MAX);
        ctx.log('warn', `codex agent: ${this.lastStderr}`);
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
        rpc.fail(sentence);
        this.current?.fail(sentence);
        if (!this.closing) this.drop();
      });
      child.once('error', (error) => {
        resolve(null);
        const sentence = `the codex agent did not start: ${messageOf(error)}`;
        rpc.fail(sentence);
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
    const head = `the codex agent exited with code ${code === null ? 'unknown' : code}`;
    return this.lastStderr.length === 0 ? head : `${head}: ${this.lastStderr}`;
  }

  /** The one teardown: the pipes go, then the child, through the registry. */
  private drop(): void {
    if (this.ended) return;
    this.ended = true;
    this.closing = true;
    this.clearIdle();
    this.rpc?.fail('the codex session was closed');
    this.rpc = null;
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

  private onNotification(method: string, raw: unknown): void {
    const turn = this.current;
    if (turn === null) return;
    const params = (raw ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'item/agentMessage/delta':
        turn.writeText(textOf(params['delta']));
        break;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        turn.writeThinking(textOf(params['delta']));
        break;
      case 'item/started':
      case 'item/completed': {
        const item = params['item'] as CodexItem | undefined;
        if (item === undefined || typeof item.id !== 'string') break;
        const view = toolViewOf(item);
        if (view !== null) turn.upsertTool(item.id, view);
        break;
      }
      case 'thread/tokenUsage/updated': {
        const usage = params['tokenUsage'] as { last?: CodexTokenUsage } | undefined;
        const last = usage?.last;
        if (last !== undefined) turn.usage = mapUsage(last);
        break;
      }
      case 'turn/completed': {
        const record = params['turn'] as CodexTurnRecord | undefined;
        if (record !== undefined) turn.finish(record);
        break;
      }
      case 'error': {
        const error = params['error'] as CodexTurnError | undefined;
        const willRetry = params['willRetry'] === true;
        const text = error?.message ?? 'the codex agent reported an error';
        // `turn/completed` says whether the turn survived it, so this is a line
        // in the log and never the turn's own outcome.
        turn.ctx.log('warn', `codex agent: ${text}${willRetry ? ' (retrying)' : ''}`);
        break;
      }
      default:
        // turn/started, thread/started, item/*/outputDelta, item/plan/delta,
        // the mcpServer, account, project and realtime families: the contract
        // has no part for them, so they are dropped.
        break;
    }
  }

  private async onRequest(ctx: TurnContext, method: string, raw: unknown): Promise<unknown> {
    const params = (raw ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const decision = await this.askUser(
          COMMAND_TOOL_NAME,
          { command: textOf(params['command']), cwd: params['cwd'] ?? null },
          textOf(params['reason']),
        );
        return { decision };
      }
      case 'item/fileChange/requestApproval': {
        const decision = await this.askUser(
          FILE_CHANGE_TOOL_NAME,
          { grantRoot: params['grantRoot'] ?? null },
          textOf(params['reason']),
        );
        return { decision };
      }
      case 'item/tool/requestUserInput':
        return { answers: await this.askQuestions(ctx, params['questions']) };
      default:
        throw new Error(`boite does not implement ${method}`);
    }
  }

  /**
   * `item/tool/requestUserInput` carries one or more questions, each with its
   * own id and, sometimes, a list of options. Each becomes one question card,
   * they are asked in order, and the answers go back keyed by the question id
   * the server sent. A stop, or a turn that ends first, cancels the rest and
   * the request is answered with what was collected: leaving it unanswered
   * would hang the agent.
   */
  private async askQuestions(ctx: TurnContext, raw: unknown): Promise<Record<string, string>> {
    const turn = this.current;
    const answers: Record<string, string> = {};
    if (turn === null || !Array.isArray(raw)) return answers;
    for (const entry of raw as CodexQuestion[]) {
      if (turn.settled || turn.isStopped) break;
      const id = typeof entry?.id === 'string' ? entry.id : '';
      if (id.length === 0) {
        ctx.log('warn', 'codex: a question with no id was skipped');
        continue;
      }
      const options = optionsOf(entry.options);
      const answer = await this.askOne(turn, {
        text: questionTextOf(entry),
        options,
        // A question the server marks `isOther`, or one with no options at all,
        // is the free-text case: there is nothing to pick otherwise.
        allowText: entry.isOther === true || options.length === 0,
        multiple: false,
      });
      if (answer === null) break;
      answers[id] = answerTextOf(answer, options);
    }
    return answers;
  }

  /** One question card, drawn and then folded with what the user picked. */
  private async askOne(turn: CodexTurn, ask: QuestionAsk): Promise<QuestionAnswer | null> {
    const ticket = turn.ctx.askQuestion(ask);
    const index = turn.takeIndex();
    turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer: null });
    const answer = await Promise.race([ticket, turn.stopped.then(() => null)]);
    if (answer === null) return null;
    turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer });
    return answer;
  }

  /** The inline permission card, and the Codex decision the answer becomes. */
  private async askUser(
    toolName: string,
    input: unknown,
    reason: string,
  ): Promise<'accept' | 'decline' | 'cancel'> {
    const turn = this.current;
    if (turn === null) return 'cancel';
    const ticket = turn.ctx.requestPermission(toolName, input, reason.length === 0 ? null : reason);
    const index = turn.takeIndex();
    turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: null });
    const answer = await Promise.race([ticket, turn.stopped.then(() => 'cancelled' as const)]);
    if (answer === 'cancelled') return 'cancel';
    turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: answer });
    return answer === 'allow' ? 'accept' : 'decline';
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
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

/** The header and the question itself, whichever of the two the server filled. */
function questionTextOf(entry: CodexQuestion): string {
  const header = textOf(entry.header).trim();
  const body = textOf(entry.question).trim();
  if (header.length > 0 && body.length > 0 && header !== body) return `${header}: ${body}`;
  return body.length > 0 ? body : header;
}

/** A string option, or an object with an id and a label, becomes one card row. */
function optionsOf(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: QuestionOption[] = [];
  for (const [at, entry] of raw.entries()) {
    if (typeof entry === 'string') {
      options.push({ id: entry, label: entry });
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = firstString([record['id'], record['value'], record['label'], record['name']]) ?? String(at);
    const label = firstString([record['label'], record['name'], record['value'], record['id']]) ?? id;
    const description = firstString([record['description']]);
    options.push(description === undefined ? { id, label } : { id, label, description });
  }
  return options;
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * What goes back on the wire for one question: the text the user typed when
 * there is one, otherwise the label of what they picked. Codex reads a string
 * per question id, so an answer is flattened here rather than sent as an object.
 */
function answerTextOf(answer: QuestionAnswer, options: QuestionOption[]): string {
  const picked = answer.optionIds
    .map((id) => options.find((option) => option.id === id)?.label ?? id)
    .join(', ');
  const text = answer.text ?? '';
  if (picked.length > 0 && text.length > 0) return `${picked}: ${text}`;
  return picked.length > 0 ? picked : text;
}

/** `CommandExecutionStatus`, `PatchApplyStatus`, `McpToolCallStatus` all read the same. */
function itemStatus(status: string | undefined): ToolStatus {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    case 'declined':
      return 'denied';
    default:
      return 'running';
  }
}

/** The four `ThreadItem` variants that are a tool card. Everything else is dropped. */
function toolViewOf(item: CodexItem): ToolView | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        name: COMMAND_TOOL_NAME,
        input: { command: item.command ?? '', cwd: item.cwd ?? null },
        output: item.aggregatedOutput ?? null,
        status: itemStatus(item.status),
      };
    case 'fileChange':
      return {
        name: FILE_CHANGE_TOOL_NAME,
        input: { changes: item.changes ?? [] },
        output: null,
        status: itemStatus(item.status),
      };
    case 'mcpToolCall':
      return {
        name: item.tool ?? 'mcp',
        input: item.arguments ?? null,
        output: item.error?.message ?? stringify(item.result),
        status: itemStatus(item.status),
      };
    case 'dynamicToolCall':
      return {
        name: item.tool ?? 'tool',
        input: item.arguments ?? null,
        output: stringify(item.contentItems),
        status: itemStatus(item.status),
      };
    default:
      return null;
  }
}

/**
 * `TokenUsageBreakdown.last`, the numbers of the turn that just ran. Codex
 * carries no price on the wire, so the cost stays null and the UI says so.
 */
function mapUsage(last: CodexTokenUsage): Usage {
  return {
    inputTokens: last.inputTokens ?? 0,
    outputTokens: last.outputTokens ?? 0,
    cacheReadTokens: last.cachedInputTokens ?? 0,
    cacheWriteTokens: last.cacheWriteInputTokens ?? 0,
    costUsdEquivalent: null,
  };
}

/**
 * The model this turn asks for, or null for the agent's own. `default` is the
 * descriptor's way of saying "whatever Codex is configured on", and Codex has
 * no model by that name, so it never reaches the wire.
 */
function modelOf(ctx: TurnContext): string | null {
  const model = ctx.thread.model;
  if (model === null || model === AGENT_OWN_MODEL) return null;
  return model;
}

/** One `UserInput` image variant per attachment, a data URL as the app-server takes it. */
function imageInputsOf(attachments: ImageAttachment[]): { type: 'image'; url: string }[] {
  return attachments.map((attachment) => ({
    type: 'image' as const,
    url: `data:${attachment.mimeType};base64,${attachment.data}`,
  }));
}

/**
 * What a session was started with and cannot be told to change. A turn that
 * differs on any of it needs its own. The model and the effort are not in here:
 * `turn/start` carries both on every turn, read off the thread as it stands
 * then, so a change reaches the running app-server with the next prompt. The
 * permission mode is, unlike the ACP driver's key: Codex takes the
 * `approvalPolicy` and `sandbox` pair on `thread/start` and `thread/resume` and
 * has no call that changes it on a live thread, so a change there is the one
 * thing that still drops the process.
 */
function sessionKey(ctx: TurnContext): string {
  return JSON.stringify({
    cwd: ctx.thread.cwd,
    permissionMode: ctx.thread.permissionMode,
    accountId: ctx.account.id,
    providerId: ctx.provider.id,
    env: ctx.accountEnv,
  });
}

// ---------------------------------------------------------------------------
// The probe: the models the server itself lists
// ---------------------------------------------------------------------------

/** The words the picker shows for the effort ids Codex uses, its own spelling kept otherwise. */
const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

function effortLabel(id: string): string {
  return EFFORT_LABELS[id] ?? `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`;
}

/**
 * `supportedReasoningEfforts` as a `ModelInfo.effort` block. Unlike ACP's
 * `thought_level`, which is one scale for the whole session, Codex gives each
 * model its own scale and its own default, so this is read per model.
 */
function effortOf(model: CodexModel): ModelInfo['effort'] | null {
  const options = model.supportedReasoningEfforts ?? [];
  const levels: EffortLevel[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    const id = option.reasoningEffort;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    levels.push({
      id,
      label: effortLabel(id),
      ...(typeof option.description === 'string' && option.description.length > 0
        ? { description: option.description }
        : {}),
    });
  }
  if (levels.length === 0) return null;
  const wanted = model.defaultReasoningEffort ?? '';
  return { levels, default: seen.has(wanted) ? wanted : (levels[0]?.id ?? '') };
}

/**
 * A `model/list` answer as a model list. The descriptor's `default` stays first
 * so the choice can always go back to Codex's own configuration, and it carries
 * no effort of its own: the scale belongs to the model that is picked. A server
 * that lists nothing leaves the descriptor's models standing.
 */
function modelsFrom(provider: ProviderDescriptor, data: CodexModel[]): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const own = provider.models.find((model) => model.id === AGENT_OWN_MODEL);
  if (own !== undefined) {
    models.push({ id: AGENT_OWN_MODEL, name: own.name, default: false });
    seen.add(AGENT_OWN_MODEL);
  }
  for (const entry of data) {
    const id = entry.id;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const effort = effortOf(entry);
    models.push({
      id,
      name: entry.displayName ?? id,
      default: entry.isDefault === true,
      ...(effort === null ? {} : { effort }),
    });
  }
  // Only the descriptor's own entry came back: the server said nothing useful.
  return models.length === (own === undefined ? 0 : 1) ? provider.models : models;
}

/**
 * One short-lived `codex app-server`: `initialize`, the `initialized`
 * notification, then `model/list` until the server stops handing back a cursor.
 * The child goes through the registry that traced it on every path. Nothing of
 * this process is kept; a turn opens its own.
 */
async function readModels(ctx: ProbeContext): Promise<ModelInfo[]> {
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
  const rpc = new CodexRpc(child, {
    // A probe draws nothing and answers nothing: the server has no turn to
    // report on and no approval to ask for.
    notification: () => undefined,
    request: (method) => Promise.reject(new Error(`boite does not implement ${method}`)),
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

    const read = (async (): Promise<CodexModel[]> => {
      await rpc.request('initialize', {
        clientInfo: { name: CLIENT_NAME, title: null, version: pkg.version },
        capabilities: null,
      });
      rpc.notify('initialized', {});

      const data: CodexModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < PROBE_MAX_PAGES; page += 1) {
        const answer: CodexModelListResponse = await rpc.request<CodexModelListResponse>(
          'model/list',
          cursor === null ? {} : { cursor },
        );
        data.push(...(answer.data ?? []));
        cursor = answer.nextCursor ?? null;
        if (cursor === null) break;
      }
      return data;
    })();

    return modelsFrom(ctx.provider, await Promise.race([read, died, expired]));
  } finally {
    if (timer !== null) clearTimeout(timer);
    rpc.fail('the codex probe is over');
    try {
      child.stdin.end();
    } catch {
      // the pipe is already gone
    }
    ctx.killTree();
  }
}

interface ProbeEntry {
  providerId: ProviderId;
  accountId: AccountId;
  /** The one process in flight for this key, so two callers share it. */
  running: Promise<ProbeResult> | null;
  result: ProbeResult | null;
}

/** Reads subscription limits without creating a thread or submitting a prompt. */
export async function readCodexQuota(ctx: ProbeContext): Promise<unknown> {
  const profile = profileFor(ctx.provider);
  const executable = profile ? resolveExecutable(profile) : null;
  if (!executable) throw new Error('Codex is not installed. Check Providers.');
  const child = ctx.spawnChild(executable, profileFor(ctx.provider)?.launch?.args ?? [], {
    cwd: ctx.cwd, env: { ...process.env, ...ctx.accountEnv },
  });
  child.stderr.resume();
  const rpc = new CodexRpc(child, {
    notification: () => undefined,
    request: () => Promise.reject(new Error('No turn is running during a quota read')),
    log: () => undefined,
  });
  let timer: Timer | undefined;
  try {
    const failure = new Promise<never>((_, reject) => {
      child.once('exit', () => reject(new Error('Codex closed before reporting quotas. Check its login in Providers.')));
      child.once('error', () => reject(new Error('Codex could not start. Check Providers.')));
      timer = setTimeout(() => reject(new Error('Codex did not report quotas within 20 seconds.')), PROBE_TIMEOUT_MS);
    });
    const read = (async () => {
      await rpc.request('initialize', { clientInfo: { name: CLIENT_NAME, title: null, version: pkg.version }, capabilities: null });
      rpc.notify('initialized', {});
      try { return await rpc.request('account/rateLimits/read', {}); }
      catch { throw new Error('Codex could not read subscription quotas. Check its login in Providers.'); }
    })();
    return await Promise.race([read, failure]);
  } finally {
    clearTimeout(timer);
    rpc.fail('the quota read is over');
    child.stdin.end();
    ctx.killTree();
  }
}

/** One `codex app-server` process per thread, kept between turns like the ACP one. */
export function createCodexDriver(): Driver {
  const sessions = new Map<ThreadId, CodexSession>();
  const probes = new Map<string, ProbeEntry>();

  const keyOf = (providerId: ProviderId, accountId: AccountId): string => `${providerId}::${accountId}`;

  return {
    protocol: 'codex-appserver',

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

      const running = readModels(ctx).then((models) => ({ models, probedAt: Date.now() }));
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
      const turn = new CodexTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs)) {
        sessions.delete(threadId);
        session.close(
          session.key === key ? null : 'the thread changed mode, account or folder',
          ctx,
        );
        session = null;
      }
      if (session === null) {
        session = new CodexSession(key, warmMs, (ended) => {
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
