import { logMessageOf } from '../../log-errors.ts';
import { resolve } from 'node:path';
import { messageOf } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { agentEnv, profileFor } from '../../providers/resolve.ts';
import { writeLandsInside } from '../../workdir.ts';
import type { QuestionAsk, SessionContext } from '../types.ts';
import { exitWithin } from '../exit.ts';
import {
  addUsage,
  answerOf,
  approvalCardOf,
  choiceFor,
  commandFailure,
  effortOf,
  inputOf,
  itemStatus,
  mapUsage,
  modelOf,
  museExecutable,
  museHostArgs,
  optionsOf,
  questionTextOf,
  tasksOf,
  textOf,
  toolViewOf,
  turnFailure,
} from './mapping.ts';
import type {
  ApprovalParams,
  MuseAnswer,
  MuseItem,
  MuseQuestion,
  MuseSessionRecord,
  MuseTokenUsage,
  OpenApproval,
  Timer,
} from './protocol.ts';
import {
  EXIT_GRACE_MS,
  INTERRUPT_DEADLINE_MS,
  META_PROVIDER,
  MODE_POSTURE,
  STDERR_MAX,
  STARTUP_DEADLINE_MS,
  SUBAGENT_TOOL_NAME,
} from './protocol.ts';
import { museQuotaReading } from '../../quota-details.ts';
import { handshake, mintUuidV7, MspError, MuseRpc } from './rpc.ts';
import { MuseTurn } from './turn.ts';
import { noteReady } from '../driver-log.ts';
import { SessionRetention } from '../session-retention.ts';
import { endOnClose, releaseChild } from '../session-close.ts';
import { protectedMuse } from './protected.ts';
import { MuseControls } from './controls.ts';

/** One question set still open, settled by an answer, a stop or the host itself. */
interface OpenQuestion {
  settle: () => void;
  settled: Promise<null>;
}

let startupDeadlineMs = STARTUP_DEADLINE_MS;

/** Shortens the startup deadline so a test does not wait 90 s; null restores it. */
export function setMuseStartupDeadlineForTests(ms: number | null): void {
  startupDeadlineMs = ms ?? STARTUP_DEADLINE_MS;
}

// ---------------------------------------------------------------------------
// The session: one `muse serve` host per thread
// ---------------------------------------------------------------------------

/**
 * One `muse serve` process for a thread: one `initialize`, one `session/start`
 * or `session/resume`, then one `turn/start` per turn. Viewed and prepared
 * sessions stay resident through navigation; other sessions follow the
 * post-turn `warmProcessMinutes` policy. A stop, archive, shutdown or changed
 * setup closes the host.
 */
export class MuseSession {
  #protection: ReturnType<typeof protectedMuse> = null;
  #replaces: string | null = null;
  #child: SpawnedChild | null = null;
  #rpc: MuseRpc | null = null;
  #starting: Promise<void> | null = null;

  /** The Muse session id: what `ctx.sessionId` stores and `session/resume` takes. */
  #sessionId: string | null = null;
  readonly #controls = new MuseControls();
  #lastStderr = '';
  #exitCode: number | null = null;
  #exited: Promise<number | null> | null = null;
  #processClosed: Promise<void> = Promise.resolve();
  #idle: Timer | null = null;
  readonly #retention = new SessionRetention();
  /** The turn waiting on the host's startup, which a stop ends by closing the host. */
  #opening: MuseTurn | null = null;
  #current: MuseTurn | null = null;
  #killTree: (() => void) | null = null;
  #quotaSink: SessionContext['quota'] | null = null;
  #contextSink: SessionContext['context'] | null = null;
  #logSink: SessionContext['log'] | null = null;
  /**
   * The running turn's items, by id, for the deltas that name only the item.
   * Item ids are per turn: the map is emptied when a turn ends, and an item of
   * another turn is never recorded, so its deltas find nothing.
   */
  readonly #items = new Map<string, { kind: string; revision: number }>();
  readonly #approvals = new Map<string, OpenApproval>();
  readonly #questions = new Map<string, OpenQuestion>();
  #queue: Promise<void> = Promise.resolve();
  #running = 0;
  #closing = false;
  #ended = false;

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly onEnded: (session: MuseSession) => void,
  ) { }

  usable(key: string, warmMs: number): boolean {
    return !this.#ended && !this.#closing && this.key === key && this.#retention.reusable(warmMs, this.warmMs);
  }

  setViewed(viewed: boolean): void {
    this.#retention.setViewed(viewed);
    this.#clearIdle();
    if (!viewed && !this.busy() && !this.#ended) this.#armIdle();
  }

  async prepare(ctx: SessionContext, forTurn = false): Promise<void> {
    this.#retention.prepare(forTurn);
    this.#clearIdle();
    try { await this.#start(ctx); }
    catch (error) { this.#drop(); throw error; }
    finally {
      ctx.finishStartup?.();
      if (!this.#ended && !this.busy() && !this.#retention.viewed) this.#armIdle();
    }
  }

  busy(): boolean {
    return this.#running > 0;
  }

  attach(turn: MuseTurn, warmMs: number): void {
    this.warmMs = warmMs;
    this.#retention.beginTurn();
    this.#running += 1;
    this.#clearIdle();
    this.#queue = this.#queue.then(async () => {
      try {
        await this.#runTurn(turn);
      } catch (error) {
        turn.fail(messageOf(error));
        this.#endTurn(turn, true);
      }
    });
  }

  /**
   * `turn/interrupt`, then the turn's own `turn/completed`. A host that does not
   * confirm within the deadline is closed, and the turn ends stopped anyway.
   */
  stopTurn(turn: MuseTurn): void {
    if (turn.settled) return;
    turn.markStopped();
    if (this.#opening === turn) {
      // Nothing reached the model yet, and a host stuck in its startup answers
      // nothing else: closing it is the only stop there is.
      this.#closing = true;
      this.#drop();
      return;
    }
    if (this.#current !== turn) return;
    if (turn.compacting) {
      // A compaction has no turn to interrupt; the stop is the user's to take.
      turn.finish('cancelled', null);
      return;
    }
    this.#interrupt(turn);
  }

  /**
   * `turn/steer` names the turn it means: a host whose turn already ended
   * refuses it, and the text waits for the next turn instead of starting one.
   */
  async steer(turn: MuseTurn, text: string, onAccepted?: () => void): Promise<boolean> {
    const rpc = this.#rpc;
    const sessionId = this.#sessionId;
    if (rpc === null || sessionId === null || this.#current !== turn || turn.turnId === null || turn.isStopped || turn.compacting) return false;
    try {
      await rpc.command('turn/steer', { sessionId, expectedTurnId: turn.turnId, input: inputOf(text, []) }, onAccepted);
      return true;
    } catch (error) {
      if (error instanceof MspError) return false;
      throw error;
    }
  }

  #interrupt(turn: MuseTurn): void {
    const rpc = this.#rpc;
    const sessionId = this.#sessionId;
    if (rpc === null || sessionId === null || turn.turnId === null) return;
    void rpc.command('turn/interrupt', { sessionId, turnId: turn.turnId }).catch((error: unknown) => {
      turn.ctx.log('warn', `muse: turn/interrupt failed: ${messageOf(error)}`);
    });
    const deadline = setTimeout(() => {
      if (turn.decided) return;
      turn.ctx.log('warn', `muse: the host did not confirm the stop in ${INTERRUPT_DEADLINE_MS / 1000} s, closing it`);
      turn.finish('cancelled', null);
      this.#closing = true;
    }, INTERRUPT_DEADLINE_MS);
    deadline.unref?.();
    void turn.finished.then(() => {
      clearTimeout(deadline);
    });
  }

  close(reason: string | null, ctx?: SessionContext): void {
    if (this.#ended) return;
    this.#closing = true;
    if (reason !== null && ctx !== undefined) ctx.log('warn', `muse session: ${reason}`);
    this.#drop();
  }

  // -- the turn -------------------------------------------------------------

  async #runTurn(turn: MuseTurn): Promise<void> {
    // A turn stopped while it was queued, or during the host's startup, sends
    // nothing to the model.
    if (turn.isStopped) {
      this.#endStopped(turn);
      return;
    }
    this.#opening = turn;
    try {
      await this.#start(turn.ctx);
    } catch (error) {
      if (turn.isStopped) turn.finish('cancelled', null);
      else turn.fail(messageOf(error));
      this.#endTurn(turn, true);
      return;
    } finally {
      this.#opening = null;
    }
    if (turn.isStopped) {
      this.#endStopped(turn);
      return;
    }

    const rpc = this.#rpc;
    const sessionId = this.#sessionId;
    if (rpc === null || sessionId === null) {
      turn.fail('the muse session went away before the turn');
      this.#endTurn(turn, true);
      return;
    }

    turn.sessionId = sessionId;
    this.#current = turn;
    this.#contextSink = turn.ctx.context;
    this.#quotaSink = turn.ctx.quota ?? null;
    const ctx = turn.ctx;
    try {
      ctx.protectedExecution?.check();
      await this.#controls.align(rpc, sessionId, ctx, this.#protection !== null);
      ctx.protectedExecution?.check();
      if (turn.isStopped) {
        // Stopped while the model or the mode was being set: no turn and no
        // compaction goes out, and the host stays warm.
        this.#current = null;
        this.#endStopped(turn);
        return;
      }
      if (turn.compacting) {
        const result = await rpc.command<{ status?: string; reason?: string }>('session/compact', { sessionId });
        if (result.status === 'noop') {
          turn.fail(`Muse had nothing to compact${result.reason === undefined ? '' : ` (${result.reason})`}`);
        }
      } else {
        let prompt = ctx.prompt, attachments = ctx.attachments;
        if (this.#replaces !== null && this.#replaces === ctx.sessionId) {
          this.#replaces = null;
          const carried = ctx.continuation?.();
          if (!carried) throw new Error('execution.muse.history: a protected cold start requires the captured conversation continuation');
          prompt = carried.prompt; attachments = carried.attachments;
        }
        const commandId = mintUuidV7();
        // A fresh turn's id is its commandId, known before the ack: an item that
        // arrives ahead of the answer still finds its turn.
        turn.turnId = commandId;
        const effort = effortOf(ctx);
        const started = await rpc.request<{ turnId?: string }>('turn/start', {
          commandId,
          sessionId,
          input: inputOf(prompt, attachments),
          ...(prompt.length === 0 ? {} : { displayText: prompt }),
          ...(effort === null ? {} : { reasoningEffort: effort }),
        });
        if (typeof started.turnId === 'string' && started.turnId.length > 0) turn.turnId = started.turnId;
        ctx.inputReady?.();
        if (turn.isStopped) this.#interrupt(turn);
      }
    } catch (error) {
      const code = await exitWithin(this.#exited, EXIT_GRACE_MS, this.#processClosed);
      if (turn.isStopped) turn.finish('cancelled', null);
      else turn.fail(code === undefined ? commandFailure(error) : this.#exitSentence(code), code === undefined ? logMessageOf(error) : this.#exitSentence(code, true));
      this.#current = null;
      this.#endTurn(turn, true);
      return;
    }

    await turn.finished;
    this.#current = null;
    this.#endTurn(turn, turn.isStopped);
  }

  #endStopped(turn: MuseTurn): void {
    turn.finish('cancelled', null);
    this.#endTurn(turn, false);
  }

  #endTurn(turn: MuseTurn, drop: boolean): void {
    turn.settle();
    // Turns run one at a time: what the map holds was this turn's.
    this.#items.clear();
    this.#running = Math.max(0, this.#running - 1);
    if (drop || this.#closing || this.#retention.idleMs(this.warmMs) <= 0) {
      this.#drop();
      return;
    }
    if (this.#running === 0 && !this.#retention.viewed) this.#armIdle();
  }

  // -- the process ----------------------------------------------------------

  #start(ctx: SessionContext): Promise<void> {
    if (this.#starting === null) this.#starting = noteReady(ctx, 'Muse', () => this.#open(ctx), undefined, () => this.#opening?.isStopped === true || this.#closing || this.#ended);
    return this.#starting;
  }

  async #open(ctx: SessionContext): Promise<void> {
    if (this.#ended) throw new Error('the muse session was closed before it started');
    ctx.protectedExecution?.check();
    this.#quotaSink = ctx.quota ?? null;
    this.#contextSink = ctx.context;
    this.#logSink = ctx.log;
    const executable = museExecutable(ctx.provider);
    const posture = MODE_POSTURE[ctx.thread.permissionMode];
    const declared = profileFor(ctx.provider)?.launch?.args ?? [];
    this.#protection = protectedMuse(ctx, () => this.#current ? {ctx: this.#current.ctx, stopped: this.#current.stopped} : null, declared);
    const args = this.#protection?.args ?? [...declared, ...museHostArgs(executable), ...posture.flags];
    const child = ctx.spawnChild(executable, args, {
      cwd: this.#protection?.cwd ?? ctx.thread.cwd,
      env: this.#protection?.env ?? agentEnv(ctx.provider, ctx.accountEnv),
    });
    this.#child = child;
    this.#killTree = ctx.killTree ?? null;
    const rpc = new MuseRpc(child, {
      notification: (method, params) => {
        if (this.#child !== child) return;
        this.#onNotification(method, params);
      },
      log: (level, message, context) => {
        if (this.#child !== child) return;
        ctx.log(level, message, context);
      },
      fault: (reason) => { void this.#transportFault(child, reason); },
    });
    this.#rpc = rpc;
    this.#watch(child, ctx, rpc);

    const initialized = await this.#within('initialize', handshake(rpc));
    this.#protection?.admit(initialized);

    if (ctx.sessionId !== null && !this.#protection) {
      const resumed = await this.#within(
        'session/resume',
        rpc.command<{ session: MuseSessionRecord }>('session/resume', {
          sessionId: ctx.sessionId,
          excludeItems: true,
        }),
      );
      this.#sessionId = this.#controls.adopt(resumed.session);
      return;
    }

    const model = modelOf(ctx);
    if (this.#protection) this.#replaces = ctx.sessionId;
    const created = await this.#within(
      'session/start',
      rpc.command<{ session: MuseSessionRecord }>('session/start', {
        sessionId: mintUuidV7(),
        workspaceRoot: this.#protection?.cwd ?? ctx.thread.cwd,
        approvalMode: posture.approvalMode,
        ...(model === null ? {} : { modelId: model, providerId: META_PROVIDER }),
      }),
    );
    this.#protection?.ready(created.session, posture.approvalMode, model);
    this.#sessionId = this.#controls.adopt(created.session);
  }

  /** One startup step, or the host closed and a sentence naming the step it hung on. */
  #within<T>(step: string, pending: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the muse host did not answer ${step} within ${Math.round(startupDeadlineMs / 1000)} s`));
        this.#closing = true;
        this.#drop();
      }, startupDeadlineMs);
      timer.unref?.();
      pending.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  #watch(child: SpawnedChild, ctx: SessionContext, rpc: MuseRpc): void {
    // Refuse warm reuse immediately, without interrupting stdout drainage.
    child.stdin.once('close', () => { if (this.#child === child) this.#closing = true; });
    let closed = (): void => undefined;
    this.#processClosed = new Promise<void>(resolve => { closed = resolve; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (this.#child !== child) return;
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim();
        if (text.length === 0) continue;
        this.#lastStderr = text.slice(0, STDERR_MAX);
        ctx.log('warn', `muse host: ${this.#lastStderr}`, { kind: 'provider-output', event: 'provider.output' });
      }
    });
    this.#exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        if (this.#child === child) this.#exitCode = code;
        resolve(code);
      });
      child.once('close', () => {
        closed();
        if (this.#child !== child) return;
        const sentence = this.#exitSentence(this.#exitCode);
        rpc.fail(sentence, this.#exitSentence(this.#exitCode, true));
        this.#failCurrent(sentence, this.#exitSentence(this.#exitCode, true));
        if (!this.#closing) this.#drop();
      });
      child.once('error', (error) => {
        resolve(null);
        closed();
        if (this.#child !== child) return;
        const sentence = `the muse host did not start: ${messageOf(error)}`;
        rpc.fail(sentence);
        this.#failCurrent(sentence, logMessageOf(error));
        if (!this.#closing) this.#drop();
      });
    });
  }

  async #transportFault(child: SpawnedChild, reason: string): Promise<void> {
    if (this.#child !== child) return;
    this.#closing = true;
    const code = await exitWithin(this.#exited, EXIT_GRACE_MS, this.#processClosed);
    if (this.#child !== child) return;
    this.#failCurrent(code === undefined ? reason : this.#exitSentence(code), code === undefined ? reason : this.#exitSentence(code, true));
    this.#drop();
  }

  #failCurrent(reason: string, diagnostic: string): void {
    const turn = this.#current;
    if (turn?.isStopped) turn.finish('cancelled', null);
    else turn?.fail(reason, diagnostic);
  }

  #exitSentence(code: number | null, diagnostic = false): string {
    const head = `the muse host exited with code ${code === null ? 'unknown' : code}`;
    return diagnostic || this.#lastStderr.length === 0 ? head : `${head}: ${this.#lastStderr}`;
  }

  #drop(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#closing = true;
    this.#clearIdle();
    try { this.#protection?.close(this.#processClosed); }
    catch (error) { this.#logSink?.('error', `muse: protected cleanup failed: ${logMessageOf(error)}`); }
    this.#protection = null;
    // The running turn ends now, while the journal is still open, not from the
    // child's close event, which can fire after core shutdown closed it.
    const turn = this.#current;
    this.#current = null;
    endOnClose(turn, 'the muse session was closed');
    for (const question of this.#questions.values()) question.settle();
    this.#questions.clear();
    this.#approvals.clear();
    this.#items.clear();
    this.#rpc?.fail('the muse session was closed');
    this.#rpc = null;
    const child = this.#child;
    this.#child = null;
    // The whole tree on Windows, so a shell a tool left running goes too.
    releaseChild(child, this.#killTree);
    this.onEnded(this);
  }

  #armIdle(): void {
    this.#clearIdle();
    this.#idle = setTimeout(() => {
      this.#idle = null;
      this.#drop();
    }, this.#retention.idleMs(this.warmMs));
    this.#idle?.unref?.();
  }

  #clearIdle(): void {
    if (this.#idle === null) return;
    clearTimeout(this.#idle);
    this.#idle = null;
  }

  // -- what the host sends --------------------------------------------------

  #onNotification(method: string, params: Record<string, unknown>): void {
    // One host, one session: anything about another session is not this thread's.
    if (typeof params['sessionId'] === 'string' && params['sessionId'] !== this.#sessionId) return;
    switch (method) {
      case 'usage/changed': {
        const usage = museQuotaReading(params);
        if (usage) this.#quotaSink?.(usage.reading, usage.observedAt);
        return;
      }
      case 'session/modelChanged':
        if (typeof params['modelId'] === 'string') this.#controls.modelId = params['modelId'];
        return;
      case 'session/approvalModeChanged':
        if (typeof params['mode'] === 'string') this.#controls.approvalMode = params['mode'];
        return;
      case 'session/contextUsage': {
        const used = params['usedTokens'];
        if (typeof used !== 'number') return;
        const window = params['windowTokens'];
        this.#contextSink?.({ tokens: used, window: typeof window === 'number' ? window : null });
        return;
      }
      case 'session/closed': {
        // The host unloaded the session (its idle policy, a restart of it): this
        // host takes no more turns, and the next one resumes on a fresh host.
        if (this.#closing) return;
        this.#closing = true;
        const turn = this.#current;
        if (turn !== null) turn.fail(`Muse closed the session: ${textOf(params['reason']) || 'no reason given'}`);
        else if (this.#running === 0) this.#drop();
        return;
      }
      default:
        break;
    }

    const turn = this.#current;
    if (turn === null) return;
    switch (method) {
      case 'item/started':
      case 'item/updated':
      case 'item/completed': {
        const item = params['item'] as MuseItem | undefined;
        if (item !== undefined && typeof item.itemId === 'string') this.#onItem(turn, item);
        break;
      }
      case 'item/delta':
        this.#onDelta(turn, params);
        break;
      case 'turn/completed': {
        if (turn.compacting || params['turnId'] !== turn.turnId) break;
        const usage = params['usage'] as MuseTokenUsage | undefined;
        if (usage !== undefined) turn.usage = mapUsage(usage);
        const error = params['error'] as { kind?: string; message?: string } | undefined;
        turn.finish(textOf(params['terminal']), turnFailure(error, textOf(params['reason'])));
        break;
      }
      case 'turn/retryScheduled':
        turn.ctx.log(
          'warn',
          `muse: retrying the turn (attempt ${String(params['nextAttempt'])} of ${String(params['maxAttempts'])}): ${textOf(params['reason'])}`,
        );
        break;
      case 'session/tokenUsage': {
        if (params['turnId'] !== turn.turnId) break;
        const usage = params['usage'] as MuseTokenUsage | undefined;
        if (usage !== undefined) turn.observed = addUsage(turn.observed, mapUsage(usage));
        break;
      }
      case 'session/todoListChanged': {
        const items = params['items'];
        if (Array.isArray(items)) turn.ctx.tasks?.(tasksOf(items));
        break;
      }
      case 'approval/requested':
      case 'approval/updated':
        this.#onApproval(turn, method, params as ApprovalParams);
        break;
      case 'approval/resolved': {
        const open = this.#approvals.get(textOf(params['approvalId']));
        if (open === undefined) break;
        this.#approvals.delete(open.approvalId);
        open.external(textOf(params['decision']).startsWith('approved') ? 'allow' : 'deny');
        break;
      }
      case 'userInput/requested':
        void this.#onQuestions(turn, params);
        break;
      case 'userInput/settled': {
        const open = this.#questions.get(textOf(params['userInputId']));
        if (open === undefined) break;
        this.#questions.delete(textOf(params['userInputId']));
        open.settle();
        break;
      }
      case 'view/gap':
        turn.ctx.log('warn', 'muse: the host skipped some updates of this turn; the saved session is complete');
        break;
      default:
        // turn/started (the id is already known), session/statusChanged,
        // session/nameChanged and the rest: nothing to draw.
        break;
    }
  }

  #onItem(turn: MuseTurn, item: MuseItem): void {
    const revision = typeof item.revision === 'number' ? item.revision : 0;
    const seen = this.#items.get(item.itemId);
    if (seen !== undefined && seen.revision >= revision && revision > 0) return;
    const terminal = item.status !== undefined && item.status !== 'inProgress';

    if (item.kind === 'compaction') {
      this.#items.set(item.itemId, { kind: item.kind, revision });
      if (!terminal) return;
      if (item.outcome === 'failed') {
        const reason = item.reason ?? item.failureReason ?? 'Muse could not compact the context';
        if (turn.compacting) turn.fail(reason);
        else turn.ctx.log('warn', `muse: automatic compaction failed: ${reason}`);
        return;
      }
      turn.part(turn.takeIndex(), {
        type: 'compaction',
        trigger: item.trigger === 'auto' ? 'auto' : 'manual',
        preTokens: typeof item.tokensBefore === 'number' ? item.tokensBefore : (turn.ctx.thread.context?.tokens ?? null),
        postTokens: typeof item.tokensAfter === 'number' ? item.tokensAfter : null,
      });
      // The item already names the new size: the meter moves with the part
      // instead of waiting for a contextUsage that may land after the turn ended.
      if (typeof item.tokensAfter === 'number') {
        turn.ctx.context({ tokens: item.tokensAfter, window: turn.ctx.thread.context?.window ?? null });
      }
      if (turn.compacting) turn.finish('completed', null);
      return;
    }

    // Items of another turn (a queued one, a replay) are not this card's.
    if (item.turnId !== undefined && item.turnId !== null && item.turnId !== turn.turnId) return;
    this.#items.set(item.itemId, { kind: item.kind, revision });
    switch (item.kind) {
      case 'agentMessage':
        turn.appendSnapshot(item.itemId, 'text', 'text', item.text);
        break;
      case 'reasoning':
        turn.appendSnapshot(item.itemId, 'text', 'thinking', item.text);
        item.summary?.forEach((text, index) => {
          turn.appendSnapshot(item.itemId, `summary.${index}`, 'thinking', text);
        });
        break;
      case 'toolCall':
        turn.upsertTool(item.itemId, toolViewOf(item));
        break;
      case 'subagent':
        turn.upsertTool(item.itemId, {
          name: SUBAGENT_TOOL_NAME,
          input: { objective: item.objective ?? '', ...(item.role === undefined ? {} : { role: item.role }) },
          output: item.result?.summary ?? item.failureReason ?? null,
          status: itemStatus(item.status),
        });
        break;
      default:
        // userMessage is the prompt Boite already shows; userShell, workflow and
        // reminderChild have no part in the contract.
        break;
    }
  }

  #onDelta(turn: MuseTurn, params: Record<string, unknown>): void {
    const itemId = textOf(params['itemId']);
    const delta = textOf(params['delta']);
    if (itemId.length === 0 || delta.length === 0) return;
    if (typeof params['turnId'] === 'string' && params['turnId'] !== turn.turnId) return;
    const kind = this.#items.get(itemId)?.kind;
    const field = typeof params['field'] === 'string' ? params['field'] : 'text';
    if (kind === 'agentMessage' && field === 'text') turn.appendDelta(itemId, field, 'text', delta);
    else if (kind === 'reasoning' && (field === 'text' || field.startsWith('summary.'))) {
      turn.appendDelta(itemId, field, 'thinking', delta);
    }
    // A tool's output delta waits for the item's own snapshot, which carries it whole.
  }

  // -- approvals ------------------------------------------------------------

  #onApproval(turn: MuseTurn, method: string, params: ApprovalParams): void {
    const approvalId = params.approvalId;
    const requirement = params.currentRequirementId;
    if (typeof approvalId !== 'string' || requirement === undefined) return;
    if (typeof params.turnId === 'string' && params.turnId !== turn.turnId) return;

    let open = this.#approvals.get(approvalId);
    if (open === undefined) {
      // An update for an approval nobody asked about is a late persistence notice.
      if (method !== 'approval/requested') return;
      let external: (decision: 'allow' | 'deny') => void = () => undefined;
      const externally = new Promise<'allow' | 'deny'>((resolve) => {
        external = resolve;
      });
      open = {
        approvalId,
        turnId: params.turnId ?? null,
        requirement,
        choices: params.availableChoices ?? [],
        subject: params.subject ?? {},
        toolName: params.toolName ?? '',
        rawArgs: params.rawArgs ?? '',
        protectedWrite: params.protectedWrite === true,
        judgeEscalated: params.judgeEscalated === true,
        decidedStage: null,
        asking: false,
        external,
        externally,
      };
      this.#approvals.set(approvalId, open);
    } else {
      open.requirement = requirement;
      if (params.availableChoices !== undefined) open.choices = params.availableChoices;
      if (params.subject !== undefined) open.subject = params.subject;
    }

    // A stage already decided, or a card already up for this stage, needs nothing new.
    if (open.asking || open.decidedStage === open.requirement.sourceIndex) return;
    void this.#decideApproval(turn, open);
  }

  async #decideApproval(turn: MuseTurn, open: OpenApproval): Promise<void> {
    open.asking = true;
    let answer: 'allow' | 'deny' | 'abort';
    if (turn.isStopped) {
      answer = 'abort';
    } else if (turn.ctx.thread.permissionMode === 'yolo' || this.#editAllowed(turn, open)) {
      answer = 'allow';
    } else {
      const { toolName, input, description } = approvalCardOf(open);
      const ticket = turn.ctx.requestPermission(toolName, input, description);
      const index = turn.takeIndex();
      turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: null });
      const picked = await Promise.race([
        ticket,
        turn.stopped.then(() => 'abort' as const),
        open.externally.then((decision) => ({ external: decision })),
      ]);
      if (typeof picked === 'object') {
        // The host settled it on its own: the card shows what it decided, nothing is sent.
        turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: picked.external });
        open.asking = false;
        return;
      }
      answer = picked;
      if (answer !== 'abort') {
        turn.part(index, { type: 'permission', requestId: ticket.requestId, toolName, decision: answer });
      }
    }

    const choice = choiceFor(open.choices, answer);
    const rpc = this.#rpc;
    const sessionId = this.#sessionId;
    open.asking = false;
    if (choice === null || rpc === null || sessionId === null) {
      turn.ctx.log('warn', `muse: no choice to send for approval ${open.approvalId} (${answer})`);
      return;
    }
    open.decidedStage = open.requirement.sourceIndex;
    try {
      await rpc.command('approval/decide', {
        sessionId,
        approvalId: open.approvalId,
        requirementId: open.requirement,
        choiceId: choice.choiceId,
      });
    } catch (error) {
      turn.ctx.log('warn', `muse: approval/decide failed: ${messageOf(error)}`);
    }
  }

  /**
   * `acceptEdits`: a file write inside the thread's folder, which Muse neither
   * marks as a protected path nor escalated through its own judge, is approved
   * without a card, once. Inside means after the links are followed, so a
   * junction in the folder pointing out of it still gets a card.
   */
  #editAllowed(turn: MuseTurn, open: OpenApproval): boolean {
    if (turn.ctx.thread.permissionMode !== 'acceptEdits') return false;
    if (open.protectedWrite || open.judgeEscalated) return false;
    const subject = open.subject;
    if (subject.kind !== 'fileAccess') return false;
    if (subject.access !== 'write' && subject.access !== 'readWrite') return false;
    if (typeof subject.path !== 'string' || subject.path.trim().length === 0) return false;
    const root = resolve(turn.ctx.thread.cwd);
    if (resolve(root, subject.path) === root) return false;
    return writeLandsInside(root, subject.path);
  }

  // -- questions ------------------------------------------------------------

  /**
   * `userInput/requested` carries one or more questions. Each becomes one
   * question card, asked in order; the answers go back together with
   * `userInput/answer`. A stop cancels the set with `userInput/cancel`, and a
   * set the host settled on its own (a timeout) is left alone.
   */
  async #onQuestions(turn: MuseTurn, params: Record<string, unknown>): Promise<void> {
    const userInputId = textOf(params['userInputId']);
    const raw = params['questions'];
    if (userInputId.length === 0 || !Array.isArray(raw) || this.#questions.has(userInputId)) return;
    if (typeof params['turnId'] === 'string' && params['turnId'] !== turn.turnId) return;
    let settle: () => void = () => undefined;
    const settled = new Promise<null>((resolve) => {
      settle = () => {
        resolve(null);
      };
    });
    this.#questions.set(userInputId, { settle, settled });

    const answers: MuseAnswer[] = [];
    let cancelled = false;
    for (const entry of raw as MuseQuestion[]) {
      const questionId = typeof entry?.id === 'string' ? entry.id : '';
      if (questionId.length === 0) continue;
      const options = optionsOf(entry.options);
      const ask: QuestionAsk = {
        text: questionTextOf(entry),
        options,
        allowText: true,
        multiple: entry.selection?.mode === 'multiple',
      };
      const ticket = turn.ctx.askQuestion(ask);
      const index = turn.takeIndex();
      turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer: null });
      const answer = await Promise.race([ticket, turn.stopped.then(() => null), settled]);
      if (!this.#questions.has(userInputId)) return;
      if (answer === null) {
        cancelled = true;
        break;
      }
      turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer });
      answers.push(answerOf(questionId, answer, options, ask.multiple));
    }
    this.#questions.delete(userInputId);

    const rpc = this.#rpc;
    const sessionId = this.#sessionId;
    if (rpc === null || sessionId === null) return;
    try {
      if (cancelled) await rpc.command('userInput/cancel', { sessionId, userInputId });
      else await rpc.command('userInput/answer', { sessionId, userInputId, answers });
    } catch (error) {
      turn.ctx.log('warn', `muse: ${cancelled ? 'userInput/cancel' : 'userInput/answer'} failed: ${messageOf(error)}`);
    }
  }
}
