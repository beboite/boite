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
  MessageId,
  MessagePart,
  PermissionMode,
  ThreadId,
  ToolStatus,
  Usage,
} from '@boite/contracts';
import pkg from '../../package.json';
import { messageOf, unavailable } from '../errors.ts';
import type { SpawnedChild } from '../procs.ts';
import { profileFor, resolveExecutable } from '../providers/loader.ts';
import type { Driver, TurnContext, TurnHandle, TurnResult } from './types.ts';

/** What the agent sees as `clientInfo.name`. */
const CLIENT_NAME = 'boite';
const MINUTE_MS = 60_000;
const STDERR_MAX = 400;
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
      const started = await rpc.request<{ turn: CodexTurnRecord }>('turn/start', {
        threadId,
        input: [{ type: 'text', text: ctx.prompt, text_elements: [] }],
        ...(ctx.thread.model === null ? {} : { model: ctx.thread.model }),
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
    if (ctx.sessionId !== null) {
      const resumed = await rpc.request<{ thread: { id: string } }>('thread/resume', {
        threadId: ctx.sessionId,
        cwd: ctx.thread.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        ...(ctx.thread.model === null ? {} : { model: ctx.thread.model }),
        excludeTurns: true,
      });
      this.threadId = resumed.thread.id;
      return;
    }

    const created = await rpc.request<{ thread: { id: string } }>('thread/start', {
      cwd: ctx.thread.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(ctx.thread.model === null ? {} : { model: ctx.thread.model }),
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
        // Boite has no part for a free-form question, and a request left
        // unanswered hangs the turn. So it is refused with empty answers, which
        // is what the agent reads as "the user answered nothing".
        ctx.log('warn', 'codex: the agent asked the user a free-form question, which Boite refuses');
        return { answers: {} };
      default:
        throw new Error(`boite does not implement ${method}`);
    }
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
 * What a session was started with. A turn that differs on any of it needs its
 * own. The permission mode is in here, unlike the ACP driver's key: Codex takes
 * the pair on `thread/start` and `thread/resume` and has no call to change it
 * on a live thread.
 */
function sessionKey(ctx: TurnContext): string {
  return JSON.stringify({
    model: ctx.thread.model,
    effort: ctx.thread.effort,
    cwd: ctx.thread.cwd,
    permissionMode: ctx.thread.permissionMode,
    accountId: ctx.account.id,
    providerId: ctx.provider.id,
    env: ctx.accountEnv,
  });
}

/** One `codex app-server` process per thread, kept between turns like the ACP one. */
export function createCodexDriver(): Driver {
  const sessions = new Map<ThreadId, CodexSession>();

  return {
    protocol: 'codex-appserver',

    startTurn(ctx: TurnContext): TurnHandle {
      const threadId = ctx.thread.id;
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const key = sessionKey(ctx);
      const turn = new CodexTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs)) {
        sessions.delete(threadId);
        session.close(
          session.key === key ? null : 'the thread changed model, effort, mode, account or folder',
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
      for (const session of open) session.close(null);
    },
  };
}
