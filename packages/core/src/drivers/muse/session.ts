import { resolve } from 'node:path';
import { messageOf } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { agentEnv, profileFor } from '../../providers/loader.ts';
import { writeLandsInside } from '../../workdir.ts';
import type { QuestionAsk, TurnContext } from '../types.ts';
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
  SUBAGENT_TOOL_NAME,
} from './protocol.ts';
import { handshake, mintUuidV7, MuseRpc } from './rpc.ts';
import { MuseTurn } from './turn.ts';

/** One question set still open, settled by an answer, a stop or the host itself. */
interface OpenQuestion {
  settle: () => void;
  settled: Promise<null>;
}

// ---------------------------------------------------------------------------
// The session: one `muse serve` host per thread
// ---------------------------------------------------------------------------

/**
 * One `muse serve` process for a thread: one `initialize`, one `session/start`
 * or `session/resume`, then one `turn/start` per turn. With
 * `warmProcessMinutes` at zero the host goes with the turn; above zero it takes
 * the next turns of the thread until the idle window, a stop, an archive, core
 * shutdown or a changed setup ends it.
 */
export class MuseSession {
  private child: SpawnedChild | null = null;
  private rpc: MuseRpc | null = null;
  private starting: Promise<void> | null = null;

  /** The Muse session id: what `ctx.sessionId` stores and `session/resume` takes. */
  private sessionId: string | null = null;
  /** The session's model and approval mode as the host last reported them. */
  private modelId: string | null = null;
  private approvalMode: string | null = null;
  private lastStderr = '';
  private exitCode: number | null = null;
  private exited: Promise<number | null> | null = null;
  private idle: Timer | null = null;
  private current: MuseTurn | null = null;
  private contextSink: TurnContext['context'] | null = null;
  private readonly items = new Map<string, { kind: string; revision: number }>();
  private readonly approvals = new Map<string, OpenApproval>();
  private readonly questions = new Map<string, OpenQuestion>();
  private queue: Promise<void> = Promise.resolve();
  private running = 0;
  private closing = false;
  private ended = false;

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly onEnded: (session: MuseSession) => void,
  ) { }

  usable(key: string, warmMs: number): boolean {
    return !this.ended && !this.closing && this.key === key && warmMs > 0 && this.warmMs > 0;
  }

  busy(): boolean {
    return this.running > 0;
  }

  attach(turn: MuseTurn, warmMs: number): void {
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
   * `turn/interrupt`, then the turn's own `turn/completed`. A host that does not
   * confirm within the deadline is closed, and the turn ends stopped anyway.
   */
  stopTurn(turn: MuseTurn): void {
    if (turn.settled) return;
    turn.markStopped();
    if (this.current !== turn) return;
    if (turn.compacting) {
      // A compaction has no turn to interrupt; the stop is the user's to take.
      turn.finish('cancelled', null);
      return;
    }
    this.interrupt(turn);
  }

  private interrupt(turn: MuseTurn): void {
    const rpc = this.rpc;
    const sessionId = this.sessionId;
    if (rpc === null || sessionId === null || turn.turnId === null) return;
    void rpc.command('turn/interrupt', { sessionId, turnId: turn.turnId }).catch((error: unknown) => {
      turn.ctx.log('warn', `muse: turn/interrupt failed: ${messageOf(error)}`);
    });
    const deadline = setTimeout(() => {
      if (turn.decided) return;
      turn.ctx.log('warn', `muse: the host did not confirm the stop in ${INTERRUPT_DEADLINE_MS / 1000} s, closing it`);
      turn.finish('cancelled', null);
      this.closing = true;
    }, INTERRUPT_DEADLINE_MS);
    deadline.unref?.();
    void turn.finished.then(() => {
      clearTimeout(deadline);
    });
  }

  close(reason: string | null, ctx?: TurnContext): void {
    if (this.ended) return;
    this.closing = true;
    if (reason !== null && ctx !== undefined) ctx.log('warn', `muse session: ${reason}`);
    this.drop();
  }

  // -- the turn -------------------------------------------------------------

  private async runTurn(turn: MuseTurn): Promise<void> {
    try {
      await this.start(turn.ctx);
    } catch (error) {
      turn.fail(messageOf(error));
      this.endTurn(turn, true);
      return;
    }

    const rpc = this.rpc;
    const sessionId = this.sessionId;
    if (rpc === null || sessionId === null) {
      turn.fail('the muse session went away before the turn');
      this.endTurn(turn, true);
      return;
    }

    turn.sessionId = sessionId;
    this.current = turn;
    this.contextSink = turn.ctx.context;
    const ctx = turn.ctx;
    try {
      await this.align(rpc, sessionId, ctx);
      if (turn.compacting) {
        const result = await rpc.command<{ status?: string; reason?: string }>('session/compact', { sessionId });
        if (result.status === 'noop') {
          turn.fail(`Muse had nothing to compact${result.reason === undefined ? '' : ` (${result.reason})`}`);
        }
      } else {
        const commandId = mintUuidV7();
        // A fresh turn's id is its commandId, known before the ack: an item that
        // arrives ahead of the answer still finds its turn.
        turn.turnId = commandId;
        const effort = effortOf(ctx);
        const started = await rpc.request<{ turnId?: string }>('turn/start', {
          commandId,
          sessionId,
          input: inputOf(ctx.prompt, ctx.attachments),
          ...(ctx.prompt.length === 0 ? {} : { displayText: ctx.prompt }),
          ...(effort === null ? {} : { reasoningEffort: effort }),
        });
        if (typeof started.turnId === 'string' && started.turnId.length > 0) turn.turnId = started.turnId;
        if (turn.isStopped) this.interrupt(turn);
      }
    } catch (error) {
      const code = await this.exitWithin(EXIT_GRACE_MS);
      turn.fail(code === undefined ? commandFailure(error) : this.exitSentence(code));
      this.current = null;
      this.endTurn(turn, true);
      return;
    }

    await turn.finished;
    this.current = null;
    this.endTurn(turn, turn.isStopped);
  }

  /**
   * The thread as it stands for this turn: its model and its approval mode,
   * sent only when the host reports something else. The effort rides on
   * `turn/start` itself.
   */
  private async align(rpc: MuseRpc, sessionId: string, ctx: TurnContext): Promise<void> {
    const model = modelOf(ctx);
    if (model !== null && model !== this.modelId) {
      await rpc.command('session/setModel', { sessionId, model: { modelId: model, providerId: META_PROVIDER } });
      this.modelId = model;
    }
    const mode = MODE_POSTURE[ctx.thread.permissionMode].approvalMode;
    if (mode !== this.approvalMode) {
      await rpc.command('session/setApprovalMode', { sessionId, mode });
      this.approvalMode = mode;
    }
  }

  private endTurn(turn: MuseTurn, drop: boolean): void {
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
    const executable = museExecutable(ctx.provider);
    const posture = MODE_POSTURE[ctx.thread.permissionMode];
    const child = ctx.spawnChild(executable, [...(profileFor(ctx.provider)?.launch?.args ?? []), ...posture.flags], {
      cwd: ctx.thread.cwd,
      env: agentEnv(ctx.provider, ctx.accountEnv),
    });
    this.child = child;
    const rpc = new MuseRpc(child, {
      notification: (method, params) => {
        this.onNotification(method, params);
      },
      log: (level, message) => {
        ctx.log(level, message);
      },
    });
    this.rpc = rpc;
    this.watch(child, ctx, rpc);

    await handshake(rpc);

    if (ctx.sessionId !== null) {
      const resumed = await rpc.command<{ session: MuseSessionRecord }>('session/resume', {
        sessionId: ctx.sessionId,
        excludeItems: true,
      });
      this.adopt(resumed.session);
      return;
    }

    const model = modelOf(ctx);
    const created = await rpc.command<{ session: MuseSessionRecord }>('session/start', {
      sessionId: mintUuidV7(),
      workspaceRoot: ctx.thread.cwd,
      approvalMode: posture.approvalMode,
      ...(model === null ? {} : { modelId: model, providerId: META_PROVIDER }),
    });
    this.adopt(created.session);
  }

  private adopt(session: MuseSessionRecord): void {
    this.sessionId = session.sessionId;
    this.modelId = session.modelId ?? null;
    this.approvalMode = session.approvalMode?.mode ?? null;
  }

  private watch(child: SpawnedChild, ctx: TurnContext, rpc: MuseRpc): void {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim();
        if (text.length === 0) continue;
        this.lastStderr = text.slice(0, STDERR_MAX);
        ctx.log('warn', `muse host: ${this.lastStderr}`);
      }
    });
    this.exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        this.exitCode = code;
        resolve(code);
      });
      child.once('close', () => {
        const sentence = this.exitSentence(this.exitCode);
        rpc.fail(sentence);
        this.current?.fail(sentence);
        if (!this.closing) this.drop();
      });
      child.once('error', (error) => {
        resolve(null);
        const sentence = `the muse host did not start: ${messageOf(error)}`;
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
    const head = `the muse host exited with code ${code === null ? 'unknown' : code}`;
    return this.lastStderr.length === 0 ? head : `${head}: ${this.lastStderr}`;
  }

  private drop(): void {
    if (this.ended) return;
    this.ended = true;
    this.closing = true;
    this.clearIdle();
    for (const question of this.questions.values()) question.settle();
    this.questions.clear();
    this.approvals.clear();
    this.rpc?.fail('the muse session was closed');
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

  // -- what the host sends --------------------------------------------------

  private onNotification(method: string, params: Record<string, unknown>): void {
    // One host, one session: anything about another session is not this thread's.
    if (typeof params['sessionId'] === 'string' && params['sessionId'] !== this.sessionId) return;
    switch (method) {
      case 'session/modelChanged':
        if (typeof params['modelId'] === 'string') this.modelId = params['modelId'];
        return;
      case 'session/approvalModeChanged':
        if (typeof params['mode'] === 'string') this.approvalMode = params['mode'];
        return;
      case 'session/contextUsage': {
        const used = params['usedTokens'];
        if (typeof used !== 'number') return;
        const window = params['windowTokens'];
        this.contextSink?.({ tokens: used, window: typeof window === 'number' ? window : null });
        return;
      }
      default:
        break;
    }

    const turn = this.current;
    if (turn === null) return;
    switch (method) {
      case 'item/started':
      case 'item/updated':
      case 'item/completed': {
        const item = params['item'] as MuseItem | undefined;
        if (item !== undefined && typeof item.itemId === 'string') this.onItem(turn, item);
        break;
      }
      case 'item/delta':
        this.onDelta(turn, params);
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
        this.onApproval(turn, method, params as ApprovalParams);
        break;
      case 'approval/resolved': {
        const open = this.approvals.get(textOf(params['approvalId']));
        if (open === undefined) break;
        this.approvals.delete(open.approvalId);
        open.external(textOf(params['decision']).startsWith('approved') ? 'allow' : 'deny');
        break;
      }
      case 'userInput/requested':
        void this.onQuestions(turn, params);
        break;
      case 'userInput/settled': {
        const open = this.questions.get(textOf(params['userInputId']));
        if (open === undefined) break;
        this.questions.delete(textOf(params['userInputId']));
        open.settle();
        break;
      }
      case 'session/closed':
        if (!this.closing) turn.fail(`Muse closed the session: ${textOf(params['reason']) || 'no reason given'}`);
        break;
      case 'view/gap':
        turn.ctx.log('warn', 'muse: the host skipped some updates of this turn; the saved session is complete');
        break;
      default:
        // turn/started (the id is already known), session/statusChanged,
        // session/nameChanged and the rest: nothing to draw.
        break;
    }
  }

  private onItem(turn: MuseTurn, item: MuseItem): void {
    const revision = typeof item.revision === 'number' ? item.revision : 0;
    const seen = this.items.get(item.itemId);
    if (seen !== undefined && seen.revision >= revision && revision > 0) return;
    this.items.set(item.itemId, { kind: item.kind, revision });
    const terminal = item.status !== undefined && item.status !== 'inProgress';

    if (item.kind === 'compaction') {
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
      if (turn.compacting) turn.finish('completed', null);
      return;
    }

    // Items of another turn (a queued one, a replay) are not this card's.
    if (item.turnId !== undefined && item.turnId !== null && item.turnId !== turn.turnId) return;
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

  private onDelta(turn: MuseTurn, params: Record<string, unknown>): void {
    const itemId = textOf(params['itemId']);
    const delta = textOf(params['delta']);
    if (itemId.length === 0 || delta.length === 0) return;
    const kind = this.items.get(itemId)?.kind;
    const field = typeof params['field'] === 'string' ? params['field'] : 'text';
    if (kind === 'agentMessage' && field === 'text') turn.appendDelta(itemId, field, 'text', delta);
    else if (kind === 'reasoning' && (field === 'text' || field.startsWith('summary.'))) {
      turn.appendDelta(itemId, field, 'thinking', delta);
    }
    // A tool's output delta waits for the item's own snapshot, which carries it whole.
  }

  // -- approvals ------------------------------------------------------------

  private onApproval(turn: MuseTurn, method: string, params: ApprovalParams): void {
    const approvalId = params.approvalId;
    const requirement = params.currentRequirementId;
    if (typeof approvalId !== 'string' || requirement === undefined) return;
    if (typeof params.turnId === 'string' && params.turnId !== turn.turnId) return;

    let open = this.approvals.get(approvalId);
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
      this.approvals.set(approvalId, open);
    } else {
      open.requirement = requirement;
      if (params.availableChoices !== undefined) open.choices = params.availableChoices;
      if (params.subject !== undefined) open.subject = params.subject;
    }

    // A stage already decided, or a card already up for this stage, needs nothing new.
    if (open.asking || open.decidedStage === open.requirement.sourceIndex) return;
    void this.decideApproval(turn, open);
  }

  private async decideApproval(turn: MuseTurn, open: OpenApproval): Promise<void> {
    open.asking = true;
    let answer: 'allow' | 'deny' | 'abort';
    if (this.editAllowed(turn, open)) {
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
    const rpc = this.rpc;
    const sessionId = this.sessionId;
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
  private editAllowed(turn: MuseTurn, open: OpenApproval): boolean {
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
  private async onQuestions(turn: MuseTurn, params: Record<string, unknown>): Promise<void> {
    const userInputId = textOf(params['userInputId']);
    const raw = params['questions'];
    if (userInputId.length === 0 || !Array.isArray(raw) || this.questions.has(userInputId)) return;
    if (typeof params['turnId'] === 'string' && params['turnId'] !== turn.turnId) return;
    let settle: () => void = () => undefined;
    const settled = new Promise<null>((resolve) => {
      settle = () => {
        resolve(null);
      };
    });
    this.questions.set(userInputId, { settle, settled });

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
      if (!this.questions.has(userInputId)) return;
      if (answer === null) {
        cancelled = true;
        break;
      }
      turn.part(index, { type: 'question', questionId: ticket.questionId, ...ask, answer });
      answers.push(answerOf(questionId, answer, options, ask.multiple));
    }
    this.questions.delete(userInputId);

    const rpc = this.rpc;
    const sessionId = this.sessionId;
    if (rpc === null || sessionId === null) return;
    try {
      if (cancelled) await rpc.command('userInput/cancel', { sessionId, userInputId });
      else await rpc.command('userInput/answer', { sessionId, userInputId, answers });
    } catch (error) {
      turn.ctx.log('warn', `muse: ${cancelled ? 'userInput/cancel' : 'userInput/answer'} failed: ${messageOf(error)}`);
    }
  }
}
