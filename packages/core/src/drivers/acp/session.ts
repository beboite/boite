/** One ACP agent process for a thread, from `initialize` to its last turn. */
import { Readable, Writable } from 'node:stream';
import type {
  ClientConnection,
  ClientContext,
  LoadSessionResponse,
  PromptResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { OsProfile, PermissionMode, ProviderDescriptor, ProviderId } from '@boite/contracts';
import pkg from '../../../package.json';
import { messageOf, unavailable } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { agentEnv, launchPrefix, profileFor, resolveExecutable } from '../../providers/loader.ts';
import { grokLaunchArgs } from '../grok.ts';
import { stderrLines } from '../lines.ts';
import type { TurnContext } from '../types.ts';
import { SessionControls } from './controls.ts';
import { loadRefusal, LoadRefused, rpcReason, rpcRefusal } from './load.ts';
import { AGENT_OWN_MODEL } from './models.ts';
import { CLIENT_NAME, EXIT_GRACE_MS, isGrok, STDERR_MAX, type AcpDeps, type Timer } from './protocol.ts';
import { jsonLinesOnly } from './stdout.ts';
import { commandsOf, imageBlocksOf, usdCostOf, type AcpTurn } from './turn.ts';
import { answerPermission, drawUpdate } from './updates.ts';

/** A glog line at info severity: `I0921 09:51:32.917720 10292 main.py:80] ...`. */
const GLOG_INFO = /^I\d{4} \d{2}:\d{2}:\d{2}\.\d+\s/;
/** How long an agent gets to answer `session/cancel` before its process is closed. */
const STOP_GRACE_MS = 3_000;

/**
 * The argv a turn spawns with: the descriptor's `launch.args` as they are, plus
 * the thread's permission mode spliced in for an agent whose mode is a command
 * line option rather than a `session/set_mode`. A probe has no thread and no
 * mode, so it launches the declared line untouched.
 */
function launchArgs(profile: OsProfile | undefined, provider: ProviderDescriptor, mode: PermissionMode): string[] {
  const declared = profile?.launch?.args ?? [];
  return [...launchPrefix(profile), ...(isGrok(provider) ? grokLaunchArgs(declared, mode) : declared)];
}

/**
 * What the driver learns about agents across their processes, for the life of
 * the core.
 */
export interface AcpMemory {
  /**
   * Providers seen to count a loaded session's cost from zero in each new
   * process, against the protocol's "cumulative session cost": their cold
   * turns are charged the whole total the process reports.
   */
  costPerProcess: Set<ProviderId>;
  /** `provider\0sessionId` of loads refused once with an `unsure` error. */
  refusedLoads: Set<string>;
}

/**
 * One ACP agent process for a thread: one `initialize`, one `session/new` or
 * `session/load`, then one `session/prompt` per turn. With
 * `warmProcessMinutes` at zero the process goes with the turn; above zero it
 * takes the next turns of the thread until the idle window, a stop, an
 * archive, core shutdown or a changed setup ends it.
 */
export class AcpSession {
  private child: SpawnedChild | null = null;
  private connection: ClientConnection | null = null;
  private agent: ClientContext | null = null;
  private starting: Promise<void> | null = null;
  /**
   * The thread's latest `TurnContext`, kept across turns. `available_commands_update`
   * typically arrives right after `session/new` or `session/load`, before any
   * turn is in flight, so the update handler reports through this rather than
   * through `current`, or the list would be dropped between turns.
   */
  private ctx: TurnContext | null = null;

  private sessionId: string | null = null;
  private canLoad = false;
  /** This process resumed the thread's session with `session/load`, rather than creating one. */
  private loaded = false;
  /**
   * The thread's session this process could not load and replaced with a new
   * one: the turn that asked for it is sent the conversation so far.
   */
  private replaces: string | null = null;
  /**
   * The last USD running total this process reported, in a turn, between two
   * turns or while a `session/load` replayed the history. What the next turn
   * adds is measured from it.
   */
  private reportedCost: number | null = null;
  private imagesSupported = false;
  /** The model, the effort and the mode, as last sent and as the agent last reported them. */
  private readonly controls = new SessionControls(() => ({ agent: this.agent, sessionId: this.sessionId }));
  private lastStderr = '';
  private exited: Promise<number | null> | null = null;
  private idle: Timer | null = null;
  /** The turn whose `session/prompt` is in flight; updates outside one are dropped. */
  private current: AcpTurn | null = null;
  /** The turn the queue is running, from its start to its end, prompt or not. */
  private active: AcpTurn | null = null;
  /** Armed by a stop on a prompt in flight: an agent that ignores the cancel is closed. */
  private stopTimer: Timer | null = null;
  private queue: Promise<void> = Promise.resolve();
  private running = 0;
  private closing = false;
  private ended = false;

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly deps: AcpDeps,
    private readonly memory: AcpMemory,
    private readonly onEnded: (session: AcpSession) => void,
    /** The config options a session answered with, for the next session of the account to start from. */
    private readonly onOptions: (options: SessionConfigOption[]) => void = () => undefined,
  ) {}

  seedConfig(options: SessionConfigOption[]): void {
    this.controls.seed(options);
  }

  /** Reusable only while the process is up and the turn asks for the very same setup. */
  usable(key: string, warmMs: number): boolean {
    return !this.ended && !this.closing && this.key === key && warmMs > 0 && this.warmMs > 0;
  }

  busy(): boolean {
    return this.running > 0;
  }

  attach(turn: AcpTurn, warmMs: number): void {
    this.warmMs = warmMs;
    this.running += 1;
    this.clearIdle();
    this.queue = this.queue.then(async () => {
      try {
        await this.runTurn(turn);
      } catch (error) {
        if (turn.isStopped) turn.stopNow();
        else turn.fail(messageOf(error));
        this.endTurn(turn, true);
      }
    });
  }

  /**
   * `session/cancel` is the only stop ACP has, and the prompt response ends the
   * turn. It only asks, though: an agent that ignores it is closed past
   * `STOP_GRACE_MS`, and one still starting (`initialize`, `session/new` or
   * `session/load`, a `set_*` call) is closed at once, since nothing it has
   * not answered yet can be cancelled. Closing the connection rejects the
   * pending request, and the turn settles as stopped.
   */
  stopTurn(turn: AcpTurn): void {
    if (turn.settled) return;
    turn.markStopped();
    // Not begun: `runTurn` settles it the moment the queue reaches it.
    if (this.active !== turn) return;
    if (this.current !== turn) {
      this.drop();
      return;
    }
    this.cancel();
    if (this.stopTimer !== null) return;
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (!turn.settled) this.drop();
    }, STOP_GRACE_MS);
    this.stopTimer.unref?.();
  }

  private cancel(): void {
    const agent = this.agent;
    const sessionId = this.sessionId;
    if (agent === null || sessionId === null) return;
    void agent.notify('session/cancel', { sessionId }).catch(() => undefined);
  }

  /** Archive, shutdown, an idle window, a changed setup: the process goes. */
  close(reason: string | null, ctx?: TurnContext): void {
    if (this.ended) return;
    this.closing = true;
    if (reason !== null && ctx !== undefined) ctx.log('warn', `acp session: ${reason}`);
    this.drop();
  }

  // -- the process ----------------------------------------------------------

  private async runTurn(turn: AcpTurn): Promise<void> {
    this.active = turn;
    if (turn.isStopped) {
      turn.stopNow();
      this.endTurn(turn, false);
      return;
    }
    this.ctx = turn.ctx;
    try {
      await this.start(turn.ctx);
    } catch (error) {
      if (turn.isStopped) {
        turn.stopNow();
      } else if (error instanceof LoadRefused) {
        turn.sessionLost = error.lost;
        turn.fail(error.message);
      } else {
        // An agent that exits while it starts takes the connection with it,
        // and its exit code and last stderr line say more than that.
        const code = await this.exitWithin(EXIT_GRACE_MS);
        turn.fail(code === undefined ? messageOf(error) : this.exitSentence(code));
      }
      this.endTurn(turn, true);
      return;
    }

    const agent = this.agent;
    const sessionId = this.sessionId;
    if (agent === null || sessionId === null) {
      if (turn.isStopped) turn.stopNow();
      else turn.fail('the acp session went away before the prompt');
      this.endTurn(turn, true);
      return;
    }
    let prompt = turn.ctx.prompt;
    let attachments = turn.ctx.attachments;
    // The agent could not resume the thread's session and this process opened
    // a new one: the prompt carries the conversation so far, as it does after
    // a session the agent lost.
    if (this.replaces !== null && this.replaces === turn.ctx.sessionId) {
      this.replaces = null;
      try {
        const carried = turn.ctx.continuation?.();
        if (carried !== undefined) {
          prompt = carried.prompt;
          attachments = carried.attachments;
        }
      } catch (error) {
        turn.fail(messageOf(error));
        this.endTurn(turn, true);
        return;
      }
    }

    if (attachments.length > 0 && !this.imagesSupported) {
      turn.fail(`${turn.ctx.provider.name} takes no images`);
      this.endTurn(turn, true);
      return;
    }

    turn.noteSession(sessionId);
    // Every turn, not only the first: a warm session outlives a change to any
    // of the three, the agent may have switched on its own since the last
    // prompt, and a `session/load` reports none of them reliably. Each call
    // sends nothing when what it carries has not moved.
    await this.controls.applyModel(turn.ctx);
    await this.controls.applyConfig(turn.ctx);
    await this.controls.applyMode(turn.ctx);
    const judged = this.costBaseline(turn);
    this.current = turn;
    let response: PromptResponse;
    try {
      const pending = agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }, ...imageBlocksOf(attachments)],
      });
      if (turn.isStopped) this.cancel();
      response = await pending;
    } catch (error) {
      this.current = null;
      if (turn.isStopped) {
        // The stop closed the process under the prompt.
        turn.stopNow();
      } else {
        // A child that died takes the connection with it, and its exit says more
        // than "the connection closed": give it a moment to be reported.
        const code = await this.exitWithin(EXIT_GRACE_MS);
        turn.fail(code === undefined ? messageOf(error) : this.exitSentence(code));
      }
      this.endTurn(turn, true);
      return;
    }
    this.current = null;
    turn.finish(response);
    // A resumed session whose first total came in below what the session
    // already cost: this agent counts each process from zero.
    const total = turn.costUsdEquivalent;
    if (judged && total !== null && total < turn.costBefore && !this.memory.costPerProcess.has(turn.ctx.provider.id)) {
      this.memory.costPerProcess.add(turn.ctx.provider.id);
      turn.ctx.log('info', `acp: ${turn.ctx.provider.id} reports a resumed session's cost from zero; its cold turns are charged their whole total`);
    }
    this.endTurn(turn, turn.isStopped);
  }

  /**
   * What the session had cost before this turn, which `usage_update`'s running
   * total is measured from. A total this process already reported is exact. A
   * session it created starts at zero. A session it loaded and that has said
   * nothing yet starts where the journal left it, since the protocol defines
   * the cost as the session's and OpenCode computes it from the session's
   * stored messages; an agent seen to count from zero again starts at zero.
   * True when the turn's reading has to tell which of the two the agent does.
   */
  private costBaseline(turn: AcpTurn): boolean {
    if (this.reportedCost !== null) {
      turn.costBefore = this.reportedCost;
      return false;
    }
    if (!this.loaded || this.memory.costPerProcess.has(turn.ctx.provider.id)) {
      turn.costBefore = 0;
      return false;
    }
    turn.costBefore = turn.ctx.sessionBefore?.costUsd ?? 0;
    return turn.costBefore > 0;
  }

  private endTurn(turn: AcpTurn, drop: boolean): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.active === turn) this.active = null;
    const dropping = drop || this.closing || this.warmMs <= 0;
    turn.settle();
    this.running = Math.max(0, this.running - 1);
    if (dropping) {
      this.drop();
      return;
    }
    if (this.running === 0) this.armIdle();
  }

  private start(ctx: TurnContext): Promise<void> {
    if (this.starting === null) this.starting = this.open(ctx);
    return this.starting;
  }

  private async open(ctx: TurnContext): Promise<void> {
    const sdk = await this.deps.loadSdk();
    // A stop while the SDK loaded: nothing may be spawned for a session that is over.
    if (this.ended) throw new Error('the acp session was closed before it started');
    const profile = profileFor(ctx.provider);
    const executable = profile === undefined ? null : resolveExecutable(profile);
    if (executable === null) {
      throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
    }

    const child = ctx.spawnChild(executable, launchArgs(profile, ctx.provider, ctx.thread.permissionMode), {
      cwd: ctx.thread.cwd,
      env: agentEnv(ctx.provider, ctx.accountEnv),
    });
    this.child = child;
    this.watch(child, ctx);

    const stream = sdk.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      jsonLinesOnly(Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>, (line) => {
        ctx.log('warn', `acp agent: ${line.slice(0, STDERR_MAX)}`);
      }),
    );
    const connection = sdk
      .client({ name: CLIENT_NAME })
      .onNotification('session/update', ({ params }) => {
        this.onUpdate(params);
      })
      .onRequest('session/request_permission', ({ params }) => answerPermission(this.current, params))
      .connect(stream);
    this.connection = connection;
    this.agent = connection.agent;

    // No fs, no terminal: an agent that calls one anyway gets a
    // method-not-found from the SDK, which is the loud refusal we want.
    const init = await connection.agent.request('initialize', {
      protocolVersion: sdk.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: CLIENT_NAME, version: pkg.version },
    });
    this.canLoad = init.agentCapabilities?.loadSession === true;
    this.imagesSupported = init.agentCapabilities?.promptCapabilities?.image === true;

    if (ctx.sessionId !== null && this.canLoad) {
      // A fresh core has no probe cache, and session/load may omit controls.
      // Discover them before loading so the resumed session stays the active
      // one. What it finds is kept for the account, so the next cold turn of
      // any thread does not open a throwaway session again.
      if (!isGrok(ctx.provider) && !this.controls.hasOptions()
        && (ctx.thread.model !== AGENT_OWN_MODEL || ctx.thread.effort !== null)) {
        const discovered = await connection.agent.request('session/new', { cwd: ctx.thread.cwd, mcpServers: [] });
        this.seedConfig(discovered.configOptions ?? []);
        this.onOptions(discovered.configOptions ?? []);
      }
      // Every `session/update` of a load is history replay: `current` is null,
      // so the update handler drops them, all but a running cost.
      const refusedKey = `${ctx.provider.id}\0${ctx.sessionId}`;
      let loaded: LoadSessionResponse;
      try {
        loaded = await connection.agent.request('session/load', {
          sessionId: ctx.sessionId,
          cwd: ctx.thread.cwd,
          mcpServers: [],
        });
      } catch (error) {
        // Only an answer from a live agent says anything about the session; a
        // dead pipe is the process's failure.
        if (!rpcRefusal(error) || this.ended || child.exitCode !== null) throw error;
        const reason = rpcReason(error);
        ctx.log('warn', `acp: ${ctx.provider.id} refused to load the session ${ctx.sessionId}: ${reason}`);
        const kind = loadRefusal(error, reason);
        if (kind === 'gone' || (kind === 'unsure' && this.memory.refusedLoads.has(refusedKey))) {
          // Pruned, migrated, another project: retrying the same id would fail
          // every turn of the thread from now on.
          this.memory.refusedLoads.delete(refusedKey);
          throw new LoadRefused(
            `${ctx.provider.name} no longer has this conversation (${reason}). Send the message again: Boite starts a new session that carries the conversation so far.`,
            true,
          );
        }
        if (kind === 'unsure') this.memory.refusedLoads.add(refusedKey);
        // Signed out, or a failure on the agent's side: the session may well
        // still be there, and the next turn loads it again.
        throw new LoadRefused(
          `${ctx.provider.name} could not open this conversation (${reason}). The session is kept: send the message again to retry.`,
          false,
        );
      }
      this.memory.refusedLoads.delete(refusedKey);
      this.sessionId = ctx.sessionId;
      this.loaded = true;
      this.controls.noteSession(loaded.modes, loaded.configOptions ?? null, loaded);
      return;
    }
    if (ctx.sessionId !== null) {
      // The thread has a session this agent cannot resume: its process ended
      // (the turn took it, an idle window, an archive, a restart). The new
      // session this opens is sent the conversation so far.
      ctx.log('warn', `acp: ${ctx.provider.id} cannot load a session, so this turn starts a new one carrying the conversation`);
      this.replaces = ctx.sessionId;
    }

    const created = await connection.agent.request('session/new', {
      cwd: ctx.thread.cwd,
      mcpServers: [],
    });
    this.sessionId = created.sessionId;
    this.controls.noteSession(created.modes, created.configOptions ?? null, created);
    this.onOptions(created.configOptions ?? []);
  }

  private watch(child: SpawnedChild, ctx: TurnContext): void {
    child.stdin.on('error', () => undefined);
    stderrLines(child.stderr, (text) => {
      this.lastStderr = text.slice(0, STDERR_MAX);
      // Antigravity writes every protocol frame to stderr as a glog info line,
      // three hundred a turn: only what the agent itself calls a warning is one.
      if (GLOG_INFO.test(text)) return;
      ctx.log('warn', `acp agent: ${this.lastStderr}`);
    });
    this.exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
        // A process that dies on its own leaves nothing reusable behind: the
        // next turn of the thread starts a fresh one.
        if (!this.closing) this.drop();
      });
      child.once('error', () => {
        resolve(null);
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
    const head = `the acp agent exited with code ${code === null ? 'unknown' : code}`;
    return this.lastStderr.length === 0 ? head : `${head}: ${this.lastStderr}`;
  }

  /** The one teardown: the connection goes, then the child, through the registry. */
  private drop(): void {
    if (this.ended) return;
    this.ended = true;
    this.closing = true;
    this.clearIdle();
    const connection = this.connection;
    this.connection = null;
    this.agent = null;
    try {
      connection?.close();
    } catch {
      // the connection is already closed
    }
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

  private onUpdate(params: SessionNotification): void {
    const update = params.update;
    // Not gated on `current`: this one arrives between turns as often as
    // during one, right after `session/new` or `session/load`.
    if (update.sessionUpdate === 'available_commands_update') {
      this.ctx?.commands(commandsOf(update.availableCommands));
      return;
    }
    // Same reason: an agent announces a mode change between two turns as well
    // as during one. Dropped here, the cached id stays what the last turn set,
    // `applyMode` finds nothing to send, and the next turn runs in the agent's
    // mode instead of the user's. The thread record is not touched: the mode
    // the user picked stands. A replayed one from a `session/load` is harmless,
    // the load's own answer overwrites it right after.
    if (update.sessionUpdate === 'current_mode_update') {
      this.controls.noteMode(update.currentModeId);
      this.ctx?.log('info', `acp: the agent switched to the session mode ${update.currentModeId}`);
      return;
    }
    // A running total outside a turn is still what the next one is measured
    // from: an agent may report it while a load replays, or between turns.
    if (update.sessionUpdate === 'usage_update') {
      const cost = usdCostOf(update);
      if (cost !== null) this.reportedCost = cost;
    }
    const turn = this.current;
    if (turn === null) return;
    drawUpdate(turn, update);
  }
}

/**
 * What a session was started with and cannot be told to change. A turn that
 * differs on any of it needs its own. The model and the effort are deliberately
 * not in here: ACP changes them in place with `session/set_config_option`, and
 * Grok with `session/set_model`, so a warm session follows the thread. Neither
 * is the permission mode for an agent that takes it as a `session/set_mode`; it
 * is in here for Grok alone, whose mode is a command line option, so a change
 * there drops the process the way it does for Codex.
 */
export function sessionKey(ctx: TurnContext): string {
  return JSON.stringify({
    permissionMode: isGrok(ctx.provider) ? ctx.thread.permissionMode : null,
    cwd: ctx.thread.cwd,
    accountId: ctx.account.id,
    providerId: ctx.provider.id,
    env: ctx.accountEnv,
  });
}
