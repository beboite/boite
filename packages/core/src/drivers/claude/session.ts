import type { Options, Query, SDKMessage, SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { BackgroundTask, PermissionMode } from '@boite/contracts';
import { messageOf, unavailable } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { profileFor, resolveExecutable } from '../../providers/resolve.ts';
import type { LiveTurnSettings, SessionContext, TurnContext } from '../types.ts';
import { hookReport } from './hooks.ts';
import { authenticationFailureOf, authenticationSuspectOf, backgroundKind, commandsOf, isApiRetry, isAuthenticationFailure, restoredCost, subagentOf } from './mapping.ts';
import { toolGate } from './permissions.ts';
import { agentEnv, liveSetup, PROMPT_EFFORT, PromptQueue, STDERR_MAX, THINKING_DISPLAY_FLAG } from './query.ts';
import type { ClaudeDeps, LiveSetup } from './query.ts';
import type { ClaudeTurn } from './turn.ts';
import { SessionRetention } from '../session-retention.ts';
import { CONTEXT_ENV, CONTEXT_GUIDES_ENV } from '../../context-mode.ts';
import { noteClaudeMessage } from './diagnostics.ts';
import { userStdioServers, type LazyServerEntry } from '../../mcp/lazy.ts';
import { compactFocus, openWithCompaction } from './compaction.ts';

/** How long `stop()` lets the CLI end its turn before the abort signal takes it. */
/** Claude Code's own subagent and workflow tools; `Task` is the older name of `Agent`. */
export const NATIVE_SUBAGENT_TOOLS = ['Agent', 'Task', 'Workflow'] as const;
const STOP_GRACE_MS = 3_000;
/** How long the CLI has to exit on its own once the prompt stream is over. */
const FINISH_GRACE_MS = 5_000;
/** The CLI re-emits its `init` frame right after a flag change (under 200 ms, CLI 2.1.291). */
const FAST_REPORT_MS = 2_000;

/**
 * How long a session with nothing left in the background waits for the CLI to
 * go on by itself (it reads the task's notification and answers it) before the
 * usual idle or close rule applies.
 */
const LINGER_MS = 15_000;
/** What a session keeps of the output the CLI writes with no turn attached, until one is. */
const ORPHANS_MAX = 5_000;
/** The system message a turn the agent opened on its own starts with. */
const WAKE_TEXT = 'Background work finished';

type Timer = ReturnType<typeof setTimeout>;

/** What the driver has to do for a session that ends, and for turns it hands back. */
export interface SessionHooks {
  ended(session: ClaudeSession): void;
  /** Turns this query cannot serve: they go on a session started with their own setup. */
  stranded(turns: ClaudeTurn[]): void;
}

/**
 * One `query()` and one prompt stream for a thread. With `warmProcessMinutes`
 * at zero it lives for one turn, which is what the driver did before warm
 * sessions existed; above zero it takes the next turns of the thread too, and
 * only an idle window, a stop, a changed setup or the core going down ends it.
 * Model, effort, speed and permission changes go through the SDK's live
 * setters, so the CLI takes them without losing its request headers.
 * Permission changes also reach the active turn, and a flag overlay toggles
 * configured hooks when entering or leaving YOLO.
 */
export class ClaudeSession {
  private readonly retention = new SessionRetention();
  private readonly abortController = new AbortController();
  private prompts = new PromptQueue();
  /** The launch policy. Changes take effect between turns, never by interrupting one. */
  private compactionTokens: number | null = null;
  private compactionModel: string | null = null;
  private readonly timers = new Set<Timer>();
  private readonly waiting: ClaudeTurn[] = [];
  /** Turns whose prompt was queued, or which adopted the CLI's own run. */
  private readonly steerable = new WeakSet<ClaudeTurn>();
  /** What the CLI runs in the background, as its last `background_tasks_changed` said. */
  private background: BackgroundTask[] = [];
  private readonly backgroundFinishers = new Map<string, NonNullable<SessionContext['backgroundFinished']>[]>();
  /** `task_started` by task id: the tool call that launched it and when. */
  private readonly launched = new Map<string, { toolId: string | null; startedAt: number }>();
  /** What the CLI wrote with no turn attached, replayed into the turn the core opens for it. */
  private orphans: SDKMessage[] = [];
  /** The core was asked for a turn for the orphans and has not attached one yet. */
  private woken = false;
  /**
   * Results still owed to a run the CLI started by itself, which a user's turn
   * took over before that run finished: they close that run, not the turn.
   */
  private foreignResults = 0;
  /** The uuids of the messages each turn put in the prompt stream: its prompt and its steers. */
  private readonly promptIds = new WeakMap<ClaudeTurn, Set<string>>();
  /** No `init` yet: what the CLI writes before it is about an earlier process. */
  private beforeInit = true;
  /**
   * A resume found background tasks the previous CLI left running. The CLI
   * reports each one before its first `init`, then closes that report with one
   * empty result (`num_turns` 0) before it runs the prompt (CLI 2.1.284,
   * probed on 2026-09-30). That result is not the turn's.
   */
  private replayResult = false;
  private linger: Timer | null = null;

  private query: Query | null = null;
  private ctx: SessionContext;
  private sessionId: string | null;
  private idle: Timer | null = null;
  private started = false;
  /** When the CLI was spawned, for the time it took to say init. */
  private spawnedAt: number | null = null;
  private closing = false;
  private ended = false;
  private loginRejected = false;
  /** An `authentication_failed` frame whose result has not said yet whether it was a 401 or a 403. */
  private authSuspect = false;
  /** The last `total_cost_usd` this CLI process reported, which the next result includes. */
  private costSoFar = 0;
  /** A resumed session's earlier turns, until the first result says whether the CLI restored them. */
  private carried: { costUsd: number; tokens: number } | null;
  /** What the query was last told to be: the options it opened on, plus every setter since. */
  private applied: LiveSetup | null = null;
  /** The setup setters of one turn finish before the next turn's prompt. */
  private pending: Promise<void> = Promise.resolve();
  /** An unanswered live control makes the query unsafe to retain for another turn. */
  private permissionTurn: ClaudeTurn | null = null;
  /** Callers waiting for the fast mode state of the next `init` frame. */
  private fastReports: ((state: string | undefined) => void)[] = [];
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;
  /** The permission callback and the tool hooks, reading the turn the CLI is on. */
  private readonly gate = toolGate({ head: () => this.head(), ctx: () => this.ctx });

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly deps: ClaudeDeps,
    private readonly hooks: SessionHooks,
    ctx: SessionContext,
  ) {
    this.ctx = ctx;
    this.sessionId = ctx.sessionId;
    this.carried = ctx.sessionId === null ? null : (ctx.sessionBefore ?? null);
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
  }

  /**
   * Reusable only while the CLI is up and the turn asks for the very same
   * setup. A CLI kept for its background work is reused whatever the warm
   * setting says: starting another would kill what it runs.
   */
  usable(key: string, warmMs: number): boolean {
    return !this.ended && !this.closing && this.key === key && (this.retention.reusable(warmMs, this.warmMs) || this.holding());
  }

  setViewed(viewed: boolean): void {
    this.retention.setViewed(viewed);
    this.clearIdle();
    if (!viewed) this.afterTurns();
  }

  prepare(forTurn = false): Promise<void> {
    this.retention.prepare(forTurn);
    if (!this.started) {
      this.started = true;
      this.applied = liveSetup(this.ctx.thread);
      void this.run();
    }
    return this.ready;
  }

  /** Background work, or output of the CLI's own that no turn took yet: the CLI must stay. */
  holding(): boolean {
    return this.background.length > 0 || this.woken || this.linger !== null;
  }

  /** The CLI went on by itself and wrote something the next turn is opened for. */
  adoptable(): boolean {
    return !this.ended && !this.closing && this.woken;
  }

  /** A turn is running or queued on it, so nothing may take the CLI away yet. */
  busy(): boolean {
    return this.waiting.length > 0;
  }

  attach(turn: ClaudeTurn, warmMs: number): void {
    this.retention.beginTurn();
    this.warmMs = warmMs;
    this.ctx = turn.ctx;
    this.clearIdle();
    this.clearLinger();
    this.waiting.push(turn);
    if (this.woken) {
      // The turn opened for what the CLI writes on its own takes that output
      // and sends no prompt; any other turn takes it first, without its result.
      this.woken = false;
      const adopted = turn.ctx.turn.execution?.operation === 'background';
      const replay = this.orphans;
      this.orphans = [];
      for (const message of replay) {
        if (!adopted && message.type === 'result') continue;
        this.receive(message, true);
      }
      if (adopted) {
        this.steerable.add(turn);
        return;
      }
      // The CLI's own run is still going: its result is not this turn's.
      if (!replay.some(message => message.type === 'result')) this.foreignResults += 1;
    } else {
      // Bookkeeping that no output followed was already applied as it came.
      this.orphans = [];
      if (turn.ctx.turn.execution?.operation === 'background') {
        // Nothing to adopt: whatever woke the core is already gone.
        this.waiting.pop();
        turn.settle();
        this.afterTurns();
        return;
      }
    }
    if (!this.started) {
      this.started = true;
      // The options the query opens on are this turn's: nothing to apply yet.
      this.applied = liveSetup(turn.ctx.thread);
      if ((turn.ctx.autoCompactTokens?.() ?? null) === null) {
        this.send(turn, turn.promptText(), turn.ctx.attachments);
        this.forgetPrompt(turn);
        this.steerable.add(turn);
        void this.run(turn);
        return;
      }
      void this.run(turn);
    }
    // A warm query takes a changed model, effort, speed or mode through the SDK's own
    // setters, and this turn's prompt only goes in once they landed. The chain
    // keeps the prompts in the order the turns attached.
    this.pending = this.pending.then(() => this.follow(turn));
  }

  /** User follow-ups enter the active query's stream with its existing setup. */
  async steer(turn: ClaudeTurn, text: string, attachments: TurnContext['attachments'] = []): Promise<boolean> {
    if (this.head() !== turn || !this.steerable.has(turn) || turn.settled || turn.isStopped || !this.query || this.closing || this.ended) return false;
    // The CLI reads this live stream while working, without interrupting its agent loop.
    this.send(turn, text, attachments);
    return true;
  }

  private send(turn: ClaudeTurn, text: string, attachments: TurnContext['attachments']): void {
    const id = this.prompts.push(text, attachments);
    const ids = this.promptIds.get(turn);
    if (ids === undefined) this.promptIds.set(turn, new Set([id]));
    else ids.add(id);
  }

  /** The result names one of this turn's messages: the CLI took it into the run this result ends. */
  private answers(turn: ClaudeTurn, result: Extract<SDKMessage, { type: 'result' }>): boolean {
    const ids = this.promptIds.get(turn);
    if (ids === undefined) return false;
    const named = result.user_message_uuids ?? (result.user_message_uuid === undefined ? [] : [result.user_message_uuid]);
    return named.some(id => ids.has(id));
  }

  async setPermissionMode(turn: ClaudeTurn, mode: PermissionMode): Promise<boolean> {
    await this.ready;
    await this.pending;
    if (this.head() !== turn || turn.settled || turn.isStopped || !this.query || !this.applied || this.closing || this.ended) return false;
    const query = this.query;
    const applied = this.applied;
    const current = () => this.head() === turn && !turn.settled && !turn.isStopped &&
      this.query === query && this.applied === applied && !this.closing && !this.ended;
    const wanted = liveSetup({ ...turn.ctx.thread, permissionMode: mode });
    this.permissionTurn = turn;
    try {
      if (wanted.disableHooks !== applied.disableHooks) {
        await query.applyFlagSettings({ disableAllHooks: wanted.disableHooks ? true : null });
        if (!current()) return false;
        applied.disableHooks = wanted.disableHooks;
      }
      if (wanted.permissionMode !== applied.permissionMode) {
        await query.setPermissionMode(wanted.permissionMode);
        if (!current()) return false;
        applied.permissionMode = wanted.permissionMode;
      }
      turn.ctx.thread.permissionMode = mode;
      return true;
    } finally {
      if (this.permissionTurn === turn) this.permissionTurn = null;
    }
  }

  /**
   * Effort and speed for the requests the running turn has not sent yet. The
   * CLI reads its flag layer before each model request, so a new level holds
   * from the next one: probed on CLI 2.1.291, where the tool hooks of the same
   * turn reported the new effort 1.5 s after the call. `ultrathink` is a word
   * of the prompt already sent, and fast mode can only be switched off this
   * way (see `applyLive`): both are left to the next turn.
   */
  async applySettings(turn: ClaudeTurn, change: LiveTurnSettings): Promise<LiveTurnSettings> {
    await this.ready;
    await this.pending;
    if (this.head() !== turn || turn.settled || turn.isStopped || !this.query || !this.applied || this.closing || this.ended) return {};
    const query = this.query;
    const applied = this.applied;
    const current = () => this.head() === turn && !turn.settled && !turn.isStopped &&
      this.query === query && this.applied === applied && !this.closing && !this.ended;
    const taken: LiveTurnSettings = {};
    if ('effort' in change && change.effort !== PROMPT_EFFORT) {
      const effort = change.effort ?? null;
      const level = liveSetup({ ...turn.ctx.thread, effort }).effortLevel;
      if (level !== applied.effortLevel) {
        await query.applyFlagSettings({ effortLevel: level });
        if (!current()) return taken;
        applied.effortLevel = level;
      }
      turn.ctx.thread.effort = effort;
      taken.effort = effort;
    }
    if ('speed' in change && change.speed !== 'fast') {
      if (applied.fastMode) {
        await query.applyFlagSettings({ fastMode: false });
        if (!current()) return taken;
        applied.fastMode = false;
      }
      turn.ctx.thread.speed = change.speed ?? null;
      taken.speed = change.speed ?? null;
    }
    return taken;
  }

  /** The fast mode state of the next `init` frame, or undefined when none comes in time. */
  private nextFastState(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const report = (state: string | undefined): void => {
        clearTimeout(timer);
        resolve(state);
      };
      const timer = setTimeout(() => {
        const at = this.fastReports.indexOf(report);
        if (at >= 0) this.fastReports.splice(at, 1);
        resolve(undefined);
      }, FAST_REPORT_MS);
      timer.unref?.();
      this.fastReports.push(report);
    });
  }

  /** Apply the next turn's settings before its prompt enters the warm stream. */
  private async follow(turn: ClaudeTurn): Promise<void> {
    if (turn.isStopped || this.closing || this.ended) return;
    // The query is built after the SDK import: a turn that arrives during it
    // would otherwise send its prompt with nothing applied.
    await this.ready;
    if (turn.isStopped || this.closing || this.ended) return;
    const tokens = turn.ctx.autoCompactTokens?.() ?? null;
    if (tokens !== this.compactionTokens || (tokens !== null && turn.ctx.thread.model !== this.compactionModel)) {
      if (this.head() === turn && !this.holding()) {
        this.strand(turn, 'native compaction launch settings changed');
        return;
      }
      turn.ctx.log('warn', 'claude: native compaction settings wait for active and background work to finish; keeping the between-turn fallback');
    }
    if (!(await this.applyLive(turn))) return;
    if (turn.isStopped || this.closing || this.ended) return;
    this.send(turn, turn.promptText(), turn.ctx.attachments);
    this.forgetPrompt(turn);
    this.steerable.add(turn);
  }

  /**
   * Once a turn's prompt is in the stream, the session keeps its callbacks and
   * setup but not its prompt, images or `continuation`, which reads them: a
   * warm or viewed session would otherwise hold the last photo until the next
   * turn. The turn's own context stays whole, since a stranded turn pushes it
   * again elsewhere; `thread` stays shared with it.
   */
  private forgetPrompt(turn: ClaudeTurn): void {
    if (this.ctx !== turn.ctx) return;
    const { prompt: _prompt, attachments: _attachments, continuation: _continuation, ...kept } = turn.ctx;
    this.ctx = kept;
  }

  /**
   * The thread's model, effort, speed and permission mode on a query already
   * up. Each goes out only when it moved, through the setter that changes
   * it in place, so nothing is sent on a turn that changed nothing. False means
   * the turn is no longer this session's.
   */
  private async applyLive(turn: ClaudeTurn): Promise<boolean> {
    const query = this.query;
    const applied = this.applied;
    if (query === null || applied === null) return true;
    const wanted = liveSetup(turn.ctx.thread);
    const live = { ...applied };
    try {
      if (wanted.model !== live.model) {
        // `undefined` is the SDK's "back to the default model".
        await query.setModel(wanted.model ?? undefined);
        live.model = wanted.model;
      }
      if (wanted.effortLevel !== live.effortLevel) {
        // Null clears the level from the flag layer: the model's own default,
        // which is what a thread with no effort and `ultrathink` both want.
        await query.applyFlagSettings({ effortLevel: wanted.effortLevel });
        live.effortLevel = wanted.effortLevel;
      }
      if (wanted.fastMode !== live.fastMode) {
        // Switching fast mode on is accepted by the setter and reported back
        // as `fastMode: true` by `getSettings`, yet a running CLI may keep
        // answering at standard speed: on a Max account without extra usage
        // (CLI 2.1.291, probed on 2026-10-07) the re-emitted `init` says
        // `off` with `extra_usage_disabled`, while the same account gets fast
        // answers from a process launched with the setting. Only that frame
        // tells, so anything but `on` moves the turn to a new process.
        const reported = wanted.fastMode ? this.nextFastState() : null;
        await query.applyFlagSettings({ fastMode: wanted.fastMode });
        if (reported !== null && (await reported) !== 'on') throw new Error('fast mode stays off on the running process');
        live.fastMode = wanted.fastMode;
      }
      if (wanted.permissionMode !== live.permissionMode) {
        await query.setPermissionMode(wanted.permissionMode);
        live.permissionMode = wanted.permissionMode;
      }
      if (wanted.disableHooks !== live.disableHooks) {
        await query.applyFlagSettings({ disableAllHooks: wanted.disableHooks ? true : null });
        live.disableHooks = wanted.disableHooks;
      }
    } catch (error) {
      this.applied = live;
      this.strand(turn, messageOf(error));
      return false;
    }
    this.applied = live;
    return true;
  }

  /**
   * A setter the CLI refused. That query keeps the setup it opened on, so it
   * cannot serve this turn: it ends, and the driver puts this turn and
   * everything queued behind it on a query started with the new setup, which is
   * what a changed model did before the setters existed. One warning, never a
   * failed turn.
   */
  private strand(turn: ClaudeTurn, reason: string): void {
    const at = this.waiting.indexOf(turn);
    const moved = at < 0 ? [turn] : this.waiting.splice(at);
    turn.ctx.log('warn', `claude: the warm session refused the new setup (${reason}); starting a new one`);
    this.close(null);
    this.hooks.stranded(moved);
  }

  stopTurn(turn: ClaudeTurn): void {
    if (turn.settled) return;
    turn.markStopped();
    const index = this.waiting.indexOf(turn);
    if (index < 0) {
      turn.settle();
      return;
    }
    // A turn the CLI has not reached yet leaves the queue on its own; the running
    // one is interrupted, and a stopped turn always ends the session with it.
    if (index > 0) {
      this.waiting.splice(index, 1);
      turn.settle();
      return;
    }
    const running = this.query;
    if (running !== null) void running.interrupt().catch(() => undefined);
    this.close(null, STOP_GRACE_MS);
  }

  /** Archive, shutdown, a changed setup: end the CLI and settle whatever is left. */
  close(reason: string | null, graceMs = FINISH_GRACE_MS): void {
    if (this.closing || this.ended) return;
    this.closing = true;
    this.clearIdle();
    if (reason !== null) this.ctx.log('warn', `claude session: ${reason}`);
    this.prompts.end();
    if (!this.started) {
      this.finish(null);
      return;
    }
    this.arm(graceMs, () => {
      this.abortController.abort();
      try {
        this.query?.close();
      } catch {
        // the query is already closed
      }
    });
  }

  // -- the query ------------------------------------------------------------

  private async run(first?: ClaudeTurn): Promise<void> {
    const lazy = this.lazyServers(this.ctx);
    try {
      const options = this.options(this.ctx, lazy?.entries ?? null);
      this.compactionTokens = this.ctx.autoCompactTokens?.() ?? null;
      this.compactionModel = this.ctx.thread.model;
      const queryFn = await this.deps.loadQuery();
      // Loading the SDK is the first await of the session, so a stop can land here.
      if (!first?.isStopped && !this.closing) {
        // This frame lives as long as the CLI: holding the first turn here would
        // keep its tool outputs and images for the whole warm session.
        first = undefined;
        const opened = await openWithCompaction(queryFn, options, this.compactionTokens,
          () => this.closing || this.abortController.signal.aborted,
          reason => this.ctx.log('warn', reason), this.prompts);
        if (opened === null) { this.finish(null); return; }
        this.query = opened.query;
        this.prompts = opened.prompts;
        // The next turn's setters have something to talk to from here on.
        this.markReady();
        // Not awaited: an older CLI that has no answer for this is one warning,
        // never a reason to hold up the turn's own messages.
        void this.query
          .supportedCommands()
          .then((commands) => this.ctx.commands(commandsOf(commands)))
          .catch((error) => this.ctx.log('warn', `claude: supportedCommands failed: ${messageOf(error)}`));
        for await (const message of this.query) this.receive(message);
      }
      this.finish(null);
    } catch (error) {
      this.finish(messageOf(error));
    } finally {
      // The CLI is gone: the servers it started through the core go too.
      lazy?.release();
    }
  }

  /**
   * The user's stdio MCP servers, reached through the core so that each
   * starts on its first call instead of with the CLI. None for a context mode
   * that starts without MCP, and the servers as configured when the core
   * cannot take them over.
   */
  private lazyServers(ctx: SessionContext): ReturnType<NonNullable<SessionContext['lazyMcp']>> {
    const mode = ctx.thread.contextMode ?? null;
    if (ctx.lazyMcp === undefined || (mode !== null && !mode.mcp)) return null;
    try {
      const servers = userStdioServers(ctx.accountEnv.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR, ctx.thread.cwd);
      return ctx.lazyMcp(this.cliEnv(ctx), servers);
    } catch (error) {
      ctx.log('warn', `claude: MCP servers start with the CLI: ${messageOf(error)}`);
      return null;
    }
  }

  private cliEnv(ctx: SessionContext): Record<string, string | undefined> {
    const mode = ctx.thread.contextMode ?? null;
    const env = agentEnv(ctx.accountEnv, ctx.toolSummaries === true, ctx.shortAnswers === true);
    return mode === null ? env : {
      ...env,
      [CONTEXT_ENV]: mode.label,
      [CONTEXT_GUIDES_ENV]: mode.guides ? undefined : '0',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: mode.instructions ? undefined : '1',
    };
  }

  /** `replayed` is an adopted message handed to the turn that opened for it: already diagnosed when it came. */
  private receive(message: SDKMessage, replayed = false): void {
    if (authenticationSuspectOf(message)) this.authSuspect = true;
    const authFailure = authenticationFailureOf(message, this.authSuspect);
    if (message.type === 'result' && subagentOf(message) === null) this.authSuspect = false;
    if (authFailure !== null) {
      this.loginRejected = true;
      (this.head()?.ctx ?? this.ctx).authenticationFailed?.();
      if (this.head() === null) { this.finish(authFailure); return; }
    }
    const sessionId = (message as { session_id?: string }).session_id;
    if (typeof sessionId === 'string' && sessionId.length > 0) this.sessionId = sessionId;
    if (message.type === 'system') this.noteTasks(message);
    // A stop makes the CLI write an error result for the interrupt: that is the stop, not a failure.
    if (!replayed && !(message.type === 'result' && (this.closing || this.head()?.isStopped === true))) noteClaudeMessage(this.head()?.ctx ?? this.ctx, message, this.spawnedAt);
    if (message.type === 'system' && message.subtype === 'init') this.spawnedAt = null;
    if (message.type === 'system' && message.subtype === 'init') {
      for (const report of this.fastReports.splice(0)) report(message.fast_mode_state);
    }
    if (message.type === 'system' && (message.subtype === 'init' || message.subtype === 'status')) this.noteMode(message.permissionMode);
    if (this.replayed(message)) return;
    // Counted once here, with or without a turn: an adopted message is handed
    // to the turn that opens for it later.
    if (message.type === 'system' && message.subtype === 'hook_response') (this.head()?.ctx ?? this.ctx).hook?.(hookReport(message));
    const turn = this.head();
    if (turn === null) {
      this.adopt(message);
      return;
    }
    if (this.sessionId !== null) turn.noteSession(this.sessionId);
    if (message.type === 'result' && this.foreignResults > 0) {
      // A prompt that reaches the CLI while its own run is still between tool
      // rounds is folded into that run (CLI 2.1.300): one result answers both,
      // and it names the prompt. Without that name it is the CLI's own result.
      if (this.answers(turn, message)) {
        this.foreignResults = 0;
      } else {
        this.foreignResults -= 1;
        if (typeof message.total_cost_usd === 'number') this.costSoFar = message.total_cost_usd;
        return;
      }
    }
    // `total_cost_usd` counts from the start of the CLI process, so on a warm
    // query every result after the first carries the turns before it too. The
    // turn is told what was already charged before it reads the result. A cold
    // process that resumed a session starts from that session's restored total.
    if (message.type === 'result') {
      const restored = this.carried === null ? this.costSoFar : restoredCost(message, this.carried);
      if (restored !== null) this.costSoFar = restored;
      this.carried = null;
      turn.noteCostBefore(restored);
    }
    turn.handle(message);
    // One result per user message: that is the end of this turn, not of the CLI.
    if (message.type === 'result') {
      if (typeof message.total_cost_usd === 'number') this.costSoFar = message.total_cost_usd;
      // A CLI that could not resume holds no session worth keeping warm: the
      // retry the core sends next must get a query of its own, with no resume.
      if (turn.sessionLost || this.loginRejected) this.close(null);
      this.endTurn(turn);
    }
  }

  /**
   * The permission mode the CLI says it runs in. Claude can switch it by
   * itself: EnterPlanMode puts it in plan, and an ExitPlanMode the user
   * refused leaves it there. Recording it makes the next turn's `applyLive`
   * see the drift and put the thread's own mode back, instead of sending
   * nothing because the thread's setting did not move.
   */
  private noteMode(mode: string | undefined): void {
    if (typeof mode !== 'string' || mode.length === 0 || this.applied === null) return;
    this.applied.permissionMode = mode as LiveSetup['permissionMode'];
  }

  /** True for the empty result that closes a resume's report of dead background tasks. */
  private replayed(message: SDKMessage): boolean {
    if (message.type === 'system' && message.subtype === 'init') this.beforeInit = false;
    if (message.type === 'system' && message.subtype === 'task_notification' && this.beforeInit) this.replayResult = true;
    if (message.type !== 'result' || !this.replayResult) return false;
    this.replayResult = false;
    return message.num_turns === 0;
  }

  private endTurn(turn: ClaudeTurn): void {
    // Retire this transport instead of waiting indefinitely for its control reply.
    if (this.permissionTurn === turn) this.close(null, STOP_GRACE_MS);
    this.waiting.shift();
    turn.settle();
    this.afterTurns();
  }

  /** Nothing attached any more: keep the CLI for its background work, else the warm rule. */
  private afterTurns(): void {
    if (this.closing || this.ended || this.waiting.length > 0) return;
    if (this.background.length > 0 || this.woken) return;
    if (this.retention.viewed) return;
    if (this.retention.idleMs(this.warmMs) > 0) this.armIdle();
    else this.close(null);
  }

  /**
   * `background_tasks_changed` is the whole set, each time; `task_started`
   * names the tool call behind a task. Ambient tasks (watchers the CLI runs
   * for itself) are not work anyone waits on.
   */
  private noteTasks(message: Extract<SDKMessage, { type: 'system' }>): void {
    if (this.ended || this.closing) return;
    if (message.subtype === 'task_notification') {
      const owners = this.backgroundFinishers.get(message.task_id);
      const finish = owners?.shift();
      const state = message.status === 'completed' ? 'completed' : message.status === 'failed' ? 'error' : 'cancelled';
      finish?.(message.task_id, state);
      if (!owners?.length) this.backgroundFinishers.delete(message.task_id);
      return;
    }
    if (message.subtype === 'task_started') {
      if (this.ctx.backgroundFinished) {
        const owners = this.backgroundFinishers.get(message.task_id) ?? [];
        if (owners.at(-1) !== this.ctx.backgroundFinished) owners.push(this.ctx.backgroundFinished);
        this.backgroundFinishers.set(message.task_id, owners);
      }
      this.launched.set(message.task_id, { toolId: message.tool_use_id ?? null, startedAt: Date.now() });
      return;
    }
    if (message.subtype !== 'background_tasks_changed') return;
    const next = message.tasks.filter(task => task.ambient !== true).map((task): BackgroundTask => {
      if (!this.backgroundFinishers.has(task.task_id) && this.ctx.backgroundFinished) this.backgroundFinishers.set(task.task_id, [this.ctx.backgroundFinished]);
      const known = this.launched.get(task.task_id) ?? this.background.find(entry => entry.id === task.task_id);
      return {
        id: task.task_id,
        kind: backgroundKind(task.task_type),
        description: task.description,
        toolId: known?.toolId ?? null,
        startedAt: known?.startedAt ?? Date.now(),
      };
    });
    const ended = this.background.length > 0 && next.length === 0;
    this.background = next;
    for (const id of [...this.launched.keys()]) if (!next.some(task => task.id === id)) this.launched.delete(id);
    this.ctx.background?.(next);
    if (!ended || this.waiting.length > 0 || this.closing) return;
    // The CLI usually answers the task's notification by itself within a
    // second; the linger gives it that moment before the warm rule applies.
    this.clearLinger();
    this.linger = setTimeout(() => {
      this.linger = null;
      this.afterTurns();
    }, LINGER_MS);
    this.linger.unref?.();
  }

  /**
   * Output with no turn attached: the CLI went on by itself once background
   * work it started finished. It is kept, and the core is asked, once, for a
   * turn to hold it. Only real output asks: bookkeeping alone opens nothing.
   */
  private adopt(message: SDKMessage): void {
    if (this.closing || this.ended) return;
    // A background subagent still talking after the turn is not the CLI going
    // on by itself: no turn opens for it, and the turn that comes drops it.
    if (subagentOf(message) !== null) return;
    // The result closes the adopted turn: it is kept beyond the cap.
    if (this.orphans.length >= ORPHANS_MAX && message.type !== 'result') return;
    this.orphans.push(message);
    // Bookkeeping before any output (a task list, a notification) is kept for
    // the turn that may come, but holds nothing: the linger and the warm rule
    // still close the CLI if no output follows.
    // A retried API call is the CLI's own run already under way, before any
    // output: an unavailable or rate-limited model retries for minutes, and the
    // idle window must not end the CLI in the middle and lose the wake.
    if (!this.woken && message.type !== 'assistant' && message.type !== 'stream_event' && !isApiRetry(message)) return;
    this.clearIdle();
    this.clearLinger();
    if (this.woken) return;
    this.woken = true;
    this.ctx.wake?.(WAKE_TEXT);
  }

  private clearLinger(): void {
    if (this.linger === null) return;
    clearTimeout(this.linger);
    this.linger = null;
  }

  /** The loop is over: the CLI is gone, so nothing of this session survives. */
  private finish(reason: string | null): void {
    if (this.ended) return;
    // A CLI gone between its `authentication_failed` frame and the result that
    // would have named the status: the label is all there is to go on.
    if ((reason !== null && isAuthenticationFailure(reason)) || this.authSuspect) (this.head()?.ctx ?? this.ctx).authenticationFailed?.();
    this.authSuspect = false;
    this.ended = true;
    // Nothing waits on a query that will never open.
    this.markReady();
    this.clearIdle();
    this.clearLinger();
    this.orphans = [];
    this.woken = false;
    this.foreignResults = 0;
    this.replayResult = false;
    this.backgroundFinishers.clear();
    // The CLI no longer tracks what it ran in the background. The command itself
    // can outlive it (Windows kills no tree): the registry's orphan sweep, which
    // the core schedules when it releases the thread, stops that.
    if (this.background.length > 0) {
      this.background = [];
      this.ctx.background?.([]);
    }
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    try {
      this.query?.close();
    } catch {
      // the query is already closed
    }
    const left = this.waiting.splice(0, this.waiting.length);
    for (const turn of left) {
      if (reason !== null && !turn.isStopped) turn.fail(reason);
      turn.settle();
    }
    // Between turns nobody is listening, so the reason goes to the core log.
    // A CLI Boite asked to end (a stop, an idle or archived session) may exit
    // on the error result it wrote for the interrupt, which the SDK then
    // reports as the exit's cause: that is the end Boite asked for.
    if (reason !== null && left.length === 0) {
      this.ctx.log(this.closing ? 'info' : 'error', `the warm claude session ended: ${reason}`);
    }
    this.hooks.ended(this);
  }

  private head(): ClaudeTurn | null {
    return this.waiting[0] ?? null;
  }

  private armIdle(): void {
    this.idle = setTimeout(() => {
      this.idle = null;
      this.close(null);
    }, this.retention.idleMs(this.warmMs));
    this.idle.unref?.();
  }

  private clearIdle(): void {
    if (this.idle === null) return;
    clearTimeout(this.idle);
    this.idle = null;
  }

  private arm(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  private options(ctx: SessionContext, lazyMcp: Record<string, LazyServerEntry> | null = null): Options {
    const profile = profileFor(ctx.provider);
    const executable = profile === undefined ? null : resolveExecutable(profile);
    if (executable === null) {
      throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
    }
    // The same values the setters carry later, so what the query opens on
    // and what the session records as applied can never say different things.
    const setup = liveSetup(ctx.thread);
    const mode = ctx.thread.contextMode ?? null;
    return {
      resume: ctx.sessionId ?? undefined,
      // A rewind or a fork: the transcript up to that entry, under a new
      // session id, so the original session is never cut.
      ...(ctx.sessionId !== null && ctx.resumeAt ? { resumeSessionAt: ctx.resumeAt, forkSession: true } : {}),
      cwd: ctx.thread.cwd,
      model: setup.model ?? undefined,
      // A level the CLI knows goes in the options; `ultrathink` goes in the prompt.
      ...(setup.effortLevel === null ? {} : { effort: setup.effortLevel }),
      permissionMode: setup.permissionMode,
      // This enables the live setter; permissionMode still controls the actual approvals.
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: executable,
      // Claude Code's own prompt, tuned per model by Anthropic, with Boite's guide
      // appended. Without a preset the SDK sends an empty one and the model gets a
      // single identity line. Working directory and memory path go to the first
      // message, so every thread and worktree shares one cached system prompt.
      // The CLI records the prompt on a session's first request and reuses it
      // until compaction, so a resumed session keeps the one it started with.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        excludeDynamicSections: true,
        ...(ctx.systemGuide ? { append: ctx.systemGuide } : {}),
      },
      settingSources: ['user', 'project', 'local'],
      // Subagents in Boite are Boite conversations (`boite delegate spawn`), so the user
      // can follow, steer and stop them; the CLI's own subagent tools never reach the model.
      disallowedTools: [...NATIVE_SUBAGENT_TOOLS],
      // A context mode: what the conversation starts without (docs/context-modes.md).
      ...(mode?.tools ? { tools: [...mode.tools] } : {}),
      ...(mode && !mode.mcp ? { strictMcpConfig: true, mcpServers: {} } : {}),
      // A server given here replaces the user's own of the same name, which then never starts.
      ...(lazyMcp !== null ? { mcpServers: lazyMcp } : {}),
      settings: {
        fastMode: setup.fastMode,
        // Memory belongs to the user's brain and Boite's own notes, not to a
        // per-folder store the preset would otherwise tell the agent to write.
        autoMemoryEnabled: false,
        ...(setup.disableHooks ? { disableAllHooks: true } : {}),
      },
      includePartialMessages: true,
      // Every run of the user's own hooks, for the ledger Settings shows.
      includeHookEvents: true,
      // A CLI driven through the SDK asks the API to leave its reasoning out
      // ("omitted"): the thinking blocks arrive empty. A summary of it costs the
      // same thinking tokens. Only the display moves: whether and how much the
      // model thinks stays the CLI's call (effort, `alwaysThinkingEnabled`).
      extraArgs: { [THINKING_DISPLAY_FLAG]: 'summarized' },
      abortController: this.abortController,
      env: this.cliEnv(ctx),
      canUseTool: this.gate.canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [this.gate.preToolUse] }],
        PostToolUse: [{ hooks: [this.gate.postToolUse] }],
        PreCompact: [{ hooks: [compactFocus] }],
      },
      spawnClaudeCodeProcess: (options: SdkSpawnOptions): SpawnedChild => this.spawnCli(options),
    };
  }

  private spawnCli(options: SdkSpawnOptions): SpawnedChild {
    this.spawnedAt = Date.now();
    const child = this.ctx.spawnChild(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
    });
    // The SDK reads stderr only for the process it spawns itself, so with a
    // custom spawner nothing drains that pipe unless we do it here.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) this.ctx.log('warn', `claude cli: ${text.slice(0, STDERR_MAX)}`, { kind: 'provider-output', event: 'provider.output' });
    });
    return child;
  }
}
