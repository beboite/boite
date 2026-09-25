import { mkdirSync } from 'node:fs';
import { messageOf, unavailable } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { launchPrefix, profileFor, resolveExecutable } from '../../providers/loader.ts';
import type { TurnContext } from '../types.ts';
import {
  agentEnv,
  commandsOf,
  contentText,
  imagesOf,
  modelArgs,
  numberOf,
  piCacheLife,
  sessionDirOf,
  textOf,
} from './mapping.ts';
import { AGENT_OWN_MODEL, EXIT_GRACE_MS, STDERR_MAX, UI_DIALOGS, UI_NOTICES } from './protocol.ts';
import type { PiAssistantMessage, PiCommand, PiUsage } from './protocol.ts';
import { dataOf, PiPeer } from './rpc.ts';
import type { PiTurn } from './turn.ts';

type Timer = ReturnType<typeof setTimeout>;

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
 * One `pi --mode rpc` process for a thread: launched on the thread's own
 * `--session-id` and `--session-dir`, so a later process reopens the transcript
 * the first one wrote. With `warmProcessMinutes` at zero the process goes with
 * the turn; above zero it takes the next turns of the thread until the idle
 * window, a stop, an archive, core shutdown or a changed setup ends it.
 */
export class PiSession {
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
   *
   * The deadline runs to the end of the turn, not to its decision: a stop
   * during pi's prompt preflight is decided by `get_state` while the prompt
   * still has no answer, and closing pi is what rejects that command.
   */
  private armStopDeadline(turn: PiTurn): void {
    if (turn.stopDeadline) return;
    turn.stopDeadline = true;
    const ms = stopDeadlineMs;
    const timer = setTimeout(() => {
      if (turn.settled || (turn.decided && !turn.awaitingPi)) return;
      turn.ctx.log(
        'warn',
        turn.decided
          ? `pi: the agent did not answer within ${ms / 1000} s of abort, closing it`
          : `pi: the agent did not settle within ${ms / 1000} s of abort, closing it`,
      );
      turn.settleRun();
      this.drop();
    }, ms);
    timer.unref?.();
    void turn.done.then(() => {
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
    turn.awaitingPi = true;
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
      turn.awaitingPi = false;
      // A child that died takes the pipe with it, and its exit says more than
      // "the command failed": give it a moment to be reported.
      const code = await this.exitWithin(EXIT_GRACE_MS);
      turn.fail(code === undefined ? messageOf(error) : this.exitSentence(code));
      this.current = null;
      this.endTurn(turn, true);
      return;
    }
    turn.awaitingPi = false;

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
    // A turn the user already stopped stays stopped, as Muse's does.
    if (turn?.isStopped === true) turn.settleRun();
    else turn?.fail('the pi session was closed');
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
