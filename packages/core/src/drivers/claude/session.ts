import type { Options, Query, SDKMessage, SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { BackgroundTask } from '@boite/contracts';
import { messageOf, unavailable } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { profileFor, resolveExecutable } from '../../providers/resolve.ts';
import type { TurnContext } from '../types.ts';
import { backgroundKind, commandsOf, restoredCost, subagentOf } from './mapping.ts';
import { toolGate } from './permissions.ts';
import { childEnv, liveSetup, PromptQueue, STDERR_MAX } from './query.ts';
import type { ClaudeDeps, LiveSetup } from './query.ts';
import type { ClaudeTurn } from './turn.ts';

/** How long `stop()` lets the CLI end its turn before the abort signal takes it. */
const STOP_GRACE_MS = 3_000;
/** How long the CLI has to exit on its own once the prompt stream is over. */
const FINISH_GRACE_MS = 5_000;

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
 * A changed model, effort or permission mode is not a changed setup: the SDK
 * has a setter for each of the three, so the CLI takes the new one in place.
 * The one exception is a move in or out of `bypassPermissions`, which needs a
 * query-start option and therefore a new query (`sessionKey`).
 */
export class ClaudeSession {
  private readonly abortController = new AbortController();
  private readonly prompts = new PromptQueue();
  private readonly timers = new Set<Timer>();
  private readonly waiting: ClaudeTurn[] = [];
  /** What the CLI runs in the background, as its last `background_tasks_changed` said. */
  private background: BackgroundTask[] = [];
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
  private linger: Timer | null = null;

  private query: Query | null = null;
  private ctx: TurnContext;
  private sessionId: string | null;
  private idle: Timer | null = null;
  private started = false;
  private closing = false;
  private ended = false;
  /** The last `total_cost_usd` this CLI process reported, which the next result includes. */
  private costSoFar = 0;
  /** A resumed session's earlier turns, until the first result says whether the CLI restored them. */
  private carried: { costUsd: number; tokens: number } | null;
  /** What the query was last told to be: the options it opened on, plus every setter since. */
  private applied: LiveSetup | null = null;
  /** The setters of one turn run to the end before the next turn's, and before its prompt. */
  private pending: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;
  /** The permission callback and the tool hooks, reading the turn the CLI is on. */
  private readonly gate = toolGate({ head: () => this.head(), ctx: () => this.ctx });

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly deps: ClaudeDeps,
    private readonly hooks: SessionHooks,
    ctx: TurnContext,
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
    return !this.ended && !this.closing && this.key === key && ((warmMs > 0 && this.warmMs > 0) || this.holding());
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
        this.receive(message);
      }
      if (adopted) return;
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
      this.prompts.push(turn.promptText(), turn.ctx.attachments);
      void this.run(turn);
      return;
    }
    // A warm query takes a changed model, effort or mode through the SDK's own
    // setters, and this turn's prompt only goes in once they landed. The chain
    // keeps the prompts in the order the turns attached.
    this.pending = this.pending.then(() => this.follow(turn));
  }

  /** A turn on a warm query: its setup first, its prompt after, or it moves house. */
  private async follow(turn: ClaudeTurn): Promise<void> {
    if (turn.isStopped || this.closing || this.ended) return;
    // The query is built after the SDK import: a turn that arrives during it
    // would otherwise send its prompt with nothing applied.
    await this.ready;
    if (turn.isStopped || this.closing || this.ended) return;
    if (!(await this.applyLive(turn))) return;
    if (turn.isStopped || this.closing || this.ended) return;
    this.prompts.push(turn.promptText(), turn.ctx.attachments);
  }

  /**
   * The thread's model, effort and permission mode on a query that is already
   * up. Each one goes out only when it moved, through the setter that changes
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
      if (wanted.permissionMode !== live.permissionMode) {
        // Never a move in or out of `bypassPermissions`: that one is in the
        // session key, so such a turn never reaches a query opened on the other
        // side of it.
        await query.setPermissionMode(wanted.permissionMode);
        live.permissionMode = wanted.permissionMode;
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

  private async run(first: ClaudeTurn): Promise<void> {
    try {
      const options = this.options(first.ctx);
      const queryFn = await this.deps.loadQuery();
      // Loading the SDK is the first await of the session, so a stop can land here.
      if (!first.isStopped && !this.closing) {
        this.query = queryFn({ prompt: this.prompts.stream(), options });
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
    }
  }

  private receive(message: SDKMessage): void {
    const sessionId = (message as { session_id?: string }).session_id;
    if (typeof sessionId === 'string' && sessionId.length > 0) this.sessionId = sessionId;
    if (message.type === 'system') this.noteTasks(message);
    const turn = this.head();
    if (turn === null) {
      this.adopt(message);
      return;
    }
    if (this.sessionId !== null) turn.noteSession(this.sessionId);
    if (message.type === 'result' && this.foreignResults > 0) {
      this.foreignResults -= 1;
      if (typeof message.total_cost_usd === 'number') this.costSoFar = message.total_cost_usd;
      return;
    }
    // `total_cost_usd` counts from the start of the CLI process, so on a warm
    // query every result after the first carries the turns before it too. The
    // turn is told what was already charged before it reads the result. A cold
    // process that resumed a session starts from that session's restored total.
    if (message.type === 'result') {
      if (this.carried !== null) this.costSoFar = restoredCost(message, this.carried);
      this.carried = null;
      turn.noteCostBefore(this.costSoFar);
    }
    turn.handle(message);
    // One result per user message: that is the end of this turn, not of the CLI.
    if (message.type === 'result') {
      if (typeof message.total_cost_usd === 'number') this.costSoFar = message.total_cost_usd;
      // A CLI that could not resume holds no session worth keeping warm: the
      // retry the core sends next must get a query of its own, with no resume.
      if (turn.sessionLost) this.close(null);
      this.endTurn(turn);
    }
  }

  private endTurn(turn: ClaudeTurn): void {
    this.waiting.shift();
    turn.settle();
    this.afterTurns();
  }

  /** Nothing attached any more: keep the CLI for its background work, else the warm rule. */
  private afterTurns(): void {
    if (this.closing || this.ended || this.waiting.length > 0) return;
    if (this.background.length > 0 || this.woken) return;
    if (this.warmMs > 0) this.armIdle();
    else this.close(null);
  }

  /**
   * `background_tasks_changed` is the whole set, each time; `task_started`
   * names the tool call behind a task. Ambient tasks (watchers the CLI runs
   * for itself) are not work anyone waits on.
   */
  private noteTasks(message: Extract<SDKMessage, { type: 'system' }>): void {
    if (message.subtype === 'task_started') {
      this.launched.set(message.task_id, { toolId: message.tool_use_id ?? null, startedAt: Date.now() });
      return;
    }
    if (message.subtype !== 'background_tasks_changed') return;
    const next = message.tasks.filter(task => task.ambient !== true).map((task): BackgroundTask => {
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
    if (!this.woken && message.type !== 'assistant' && message.type !== 'stream_event') return;
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
    this.ended = true;
    // Nothing waits on a query that will never open.
    this.markReady();
    this.clearIdle();
    this.clearLinger();
    this.orphans = [];
    this.woken = false;
    this.foreignResults = 0;
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
    if (reason !== null && left.length === 0) {
      this.ctx.log('error', `the warm claude session ended: ${reason}`);
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
    }, this.warmMs);
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

  private options(ctx: TurnContext): Options {
    const profile = profileFor(ctx.provider);
    const executable = profile === undefined ? null : resolveExecutable(profile);
    if (executable === null) {
      throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
    }
    // The same three values the setters carry later, so what the query opens on
    // and what the session records as applied can never say different things.
    const setup = liveSetup(ctx.thread);
    return {
      resume: ctx.sessionId ?? undefined,
      cwd: ctx.thread.cwd,
      model: setup.model ?? undefined,
      // A level the CLI knows goes in the options; `ultrathink` goes in the prompt.
      ...(setup.effortLevel === null ? {} : { effort: setup.effortLevel }),
      permissionMode: setup.permissionMode,
      allowDangerouslySkipPermissions: setup.permissionMode === 'bypassPermissions',
      pathToClaudeCodeExecutable: executable,
      settingSources: ['user', 'project', 'local'],
      settings: { fastMode: ctx.thread.speed === 'fast' },
      includePartialMessages: true,
      abortController: this.abortController,
      env: childEnv(ctx.accountEnv),
      canUseTool: this.gate.canUseTool,
      hooks: {
        PreToolUse: [{ hooks: [this.gate.preToolUse] }],
        PostToolUse: [{ hooks: [this.gate.postToolUse] }],
      },
      spawnClaudeCodeProcess: (options: SdkSpawnOptions): SpawnedChild => this.spawnCli(options),
    };
  }

  private spawnCli(options: SdkSpawnOptions): SpawnedChild {
    const child = this.ctx.spawnChild(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
    });
    // The SDK reads stderr only for the process it spawns itself, so with a
    // custom spawner nothing drains that pipe unless we do it here.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) this.ctx.log('warn', `claude cli: ${text.slice(0, STDERR_MAX)}`);
    });
    return child;
  }
}
