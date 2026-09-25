import type { QuestionAnswer } from '@boite/contracts';
import pkg from '../../../package.json';
import { messageOf, unavailable } from '../../errors.ts';
import { openAiCacheLife } from '../../prompt-cache.ts';
import type { SpawnedChild } from '../../procs.ts';
import { profileFor, resolveExecutable } from '../../providers/loader.ts';
import type { QuestionAsk, TurnContext } from '../types.ts';
import {
  answerTextOf,
  imageInputsOf,
  mapUsage,
  modelOf,
  optionsOf,
  questionTextOf,
  servedOf,
  textOf,
  toolViewOf,
} from './mapping.ts';
import type { CodexItem, CodexQuestion, CodexThreadOpened, CodexTokenUsage, CodexTurnError, CodexTurnRecord, Timer } from './protocol.ts';
import {
  CLIENT_NAME,
  COMMAND_TOOL_NAME,
  EXIT_GRACE_MS,
  FILE_CHANGE_TOOL_NAME,
  MODE_POLICY,
  STDERR_MAX,
} from './protocol.ts';
import { CodexRpc } from './rpc.ts';
import { CodexTurn } from './turn.ts';

/**
 * What `thread/resume` answers when the thread's rollout file is gone. Both
 * sentences are in the 0.156.1 binary; any other refusal keeps the thread.
 */
const MISSING_THREAD = /no rollout found for (?:thread|conversation) id|thread not found: /i;

/** `thread/resume` refused a thread the agent no longer has. */
class ThreadLostError extends Error {}

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
export class CodexSession {
  private child: SpawnedChild | null = null;
  private rpc: CodexRpc | null = null;
  private starting: Promise<void> | null = null;

  /** The Codex thread id: what `ctx.sessionId` stores and `thread/resume` takes. */
  private threadId: string | null = null;
  /** What `thread/start` or `thread/resume` said it runs on, for the prompt cache lifetime. */
  private served: { model: string | null; provider: string | null } = { model: null, provider: null };
  private lastStderr = '';
  private exitCode: number | null = null;
  private exited: Promise<number | null> | null = null;
  private idle: Timer | null = null;
  /** The turn whose `turn/start` is in flight. Context updates also arrive while idle. */
  private current: CodexTurn | null = null;
  private contextSink: CodexTurn['ctx']['context'] | null = null;
  private queue: Promise<void> = Promise.resolve();
  private running = 0;
  /** `agentMessage` items that are asynchronous questions: drawn as cards, their text deltas dropped. */
  private readonly asyncItems = new Set<string>();
  private closing = false;
  private ended = false;

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly onEnded: (session: CodexSession) => void,
  ) { }

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

  async steer(turn: CodexTurn, text: string): Promise<boolean> {
    if (this.current !== turn || turn.settled || turn.isStopped || !this.rpc || !this.threadId || !turn.turnId) return false;
    await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: turn.turnId, input: [{ type: 'text', text, text_elements: [] }] });
    return true;
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
      if (error instanceof ThreadLostError) turn.loseSession(error.message);
      else turn.fail(messageOf(error));
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
    this.contextSink = turn.ctx.context;
    const ctx = turn.ctx;
    try {
      // The thread as it stands for this turn, not as it stood when the
      // app-server thread opened: that is what carries a changed model or
      // effort to a process that stayed up.
      const model = modelOf(ctx);
      if (ctx.turn.execution?.operation === 'compact') {
        await rpc.request('thread/compact/start', { threadId });
      } else {
        const started = await rpc.request<{ turn: CodexTurnRecord }>('turn/start', {
          threadId,
          input: [{ type: 'text', text: ctx.prompt, text_elements: [] }, ...imageInputsOf(ctx.attachments)],
          ...(model === null ? {} : { model }),
          ...(ctx.thread.effort === null ? {} : { effort: ctx.thread.effort }),
          serviceTier: ctx.thread.speed ?? "default",
        });
        turn.turnId = started.turn.id;
        if (turn.isStopped) this.interrupt(turn);
        // A server that answers with a turn already finished settles it here;
        // the one that answers `inProgress` settles on `turn/completed`.
        turn.finish(started.turn);
      }
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
    // Only OpenAI's own endpoint has a published lifetime; Codex never sends a
    // retention option, so the default for the model applies.
    if (this.served.provider === 'openai') turn.cacheLife = openAiCacheLife(modelOf(ctx) ?? this.served.model);
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
      const resumed = await rpc.request<CodexThreadOpened>('thread/resume', {
        threadId: ctx.sessionId,
        cwd: ctx.thread.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        ...(model === null ? {} : { model }),
        config: { 'tools.update_plan.enabled': true },
        excludeTurns: true,
      }).catch((error: unknown) => {
        const reason = messageOf(error);
        throw MISSING_THREAD.test(reason) ? new ThreadLostError(reason) : error;
      });
      this.threadId = resumed.thread.id;
      this.served = servedOf(resumed);
      return;
    }

    const created = await rpc.request<CodexThreadOpened>('thread/start', {
      config: { 'tools.update_plan.enabled': true },
      cwd: ctx.thread.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(model === null ? {} : { model }),
    });
    this.threadId = created.thread.id;
    this.served = servedOf(created);
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
    const params = (raw ?? {}) as Record<string, unknown>;
    if (method === 'thread/tokenUsage/updated') {
      this.reportUsage(params);
      return;
    }
    const turn = this.current;
    if (turn === null) return;
    switch (method) {
      case 'turn/started': {
        const record = params['turn'] as CodexTurnRecord | undefined;
        if (record) { turn.turnId = record.id; if (turn.isStopped) this.interrupt(turn); }
        break;
      }
      case 'item/agentMessage/delta':
        if (typeof params['itemId'] === 'string' && this.asyncItems.has(params['itemId'])) break;
        turn.writeText(textOf(params['delta']));
        break;
      case 'item/commandExecution/outputDelta':
        if (typeof params['itemId'] === 'string') turn.appendOutput(params['itemId'], textOf(params['delta']));
        break;
      case 'turn/plan/updated': {
        const plan = params['plan'];
        if (Array.isArray(plan)) turn.ctx.tasks?.(plan.flatMap((entry, index) => {
          if (!entry || typeof entry.step !== 'string') return [];
          return [{ id: String(index), text: entry.step, status: entry.status === 'completed' ? 'completed' as const : entry.status === 'inProgress' || entry.status === 'in_progress' ? 'in_progress' as const : 'pending' as const }];
        }));
        break;
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        turn.writeThinking(textOf(params['delta']));
        break;
      case 'item/started':
      case 'item/completed': {
        const item = params['item'] as CodexItem | undefined;
        if (item === undefined || typeof item.id !== 'string') break;
        if (item.type === 'contextCompaction' && method === 'item/completed') {
          turn.part(turn.takeIndex(), { type: 'compaction', trigger: turn.ctx.turn.execution?.operation === 'compact' ? 'manual' : 'auto', preTokens: turn.ctx.thread.context?.tokens ?? null, postTokens: null });
          break;
        }
        if (item.type === 'agentMessage' && item.delivery === 'async') {
          if (!this.asyncItems.has(item.id)) {
            this.asyncItems.add(item.id);
            for (const question of item.questions ?? []) this.askAsync(turn, question);
          }
          break;
        }
        const view = toolViewOf(item, method === 'item/completed');
        if (view !== null) turn.upsertTool(item.id, view);
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

  /** Usage also arrives while the session has no active turn. */
  private reportUsage(params: Record<string, unknown>): void {
    if (params['threadId'] !== this.threadId) return;
    const usage = params['tokenUsage'] as { last?: CodexTokenUsage; modelContextWindow?: number } | undefined;
    const last = usage?.last;
    if (!last) return;
    if (this.current && params['turnId'] === this.current.turnId) this.current.usage = mapUsage(last);
    const tokens = last.totalTokens ?? (typeof last.inputTokens === 'number' && typeof last.outputTokens === 'number' ? last.inputTokens + last.outputTokens : null);
    if (tokens !== null) {
      const cache = last.cachedInputTokens ?? 0;
      const breakdown = typeof last.inputTokens === 'number' && typeof last.outputTokens === 'number'
        ? { input: last.inputTokens - cache, cache, output: last.outputTokens } : undefined;
      this.contextSink?.({ tokens, window: usage?.modelContextWindow ?? null, ...(breakdown ? { breakdown } : {}) });
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

  /**
   * An asynchronous question (GPT-6 Astra's `delivery: "async"`): the agent
   * goes on, so nothing waits here. The core folds the answer into the card
   * and brings it back with `turn/steer` or as the next prompt, framed as the
   * Codex TUI frames it: `> title`, a blank line, the answer.
   */
  private askAsync(turn: CodexTurn, question: { title?: string; options?: string[] | null }): void {
    const text = typeof question.title === 'string' ? question.title.trim() : '';
    if (text.length === 0) return;
    const ask: QuestionAsk = { text, options: optionsOf(question.options), allowText: true, multiple: false, async: true };
    const ticket = turn.ctx.askQuestion(ask);
    turn.part(turn.takeIndex(), { type: 'question', questionId: ticket.questionId, ...ask, answer: null });
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
