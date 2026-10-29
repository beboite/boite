import { logMessageOf } from '../../log-errors.ts';
import { Readable, Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import type {
  ClientConnection,
  ClientContext,
  LoadSessionResponse,
  PromptResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { OsProfile, PermissionMode, ProviderDescriptor, ProviderId, ModelInfo } from '@boite/contracts';
import pkg from '../../../package.json';
import { messageOf, unavailable } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { agentEnv, profileFor, resolveLaunch } from '../../providers/resolve.ts';
import { launchTemp } from '../launch-temp.ts';
import { grokLaunchArgs } from '../grok.ts';
import { stderrLines } from '../lines.ts';
import { exitWithin } from '../exit.ts';
import type { LiveTurnSettings, ProbeContext, ProbeFilter, SessionContext } from '../types.ts';
import { OpenCommands } from './commands.ts';
import { ModelRefused, SessionControls } from './controls.ts';
import { failureText, loadRefusal, LoadRefused, rpcReason, rpcRefusal } from './load.ts';
import { AGENT_OWN_MODEL } from './models.ts';
import { canDeleteSessions, CLIENT_NAME, discardSession, EXIT_GRACE_MS, isGrok, STDERR_MAX, type AcpDeps, type Timer } from './protocol.ts';
import { jsonLinesOnly } from './stdout.ts';
import { commandsOf, imageBlocksOf, usdCostOf, type AcpTurn } from './turn.ts';
import { answerPermission, drawUpdate, sessionNotificationOf } from './updates.ts';
import { errorCodeOf, noteReady } from '../driver-log.ts';
import { SessionRetention } from '../session-retention.ts';
import { releaseChild } from '../session-close.ts';
import { OpenCodeConnection } from './opencode-connection.ts';
import {protectedAcp} from './protected.ts';

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
function launchArgs(profile: OsProfile | undefined, prefix: string[], provider: ProviderDescriptor, mode: PermissionMode): string[] {
  const declared = profile?.launch?.args ?? [];
  return [...prefix, ...(isGrok(provider) ? grokLaunchArgs(declared, mode) : declared)];
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
 * `session/load`, then one `session/prompt` per turn. Viewed and prepared
 * sessions stay resident through navigation; other sessions follow the
 * post-turn `warmProcessMinutes` policy. A stop, archive, shutdown or changed
 * setup closes the process.
 */
export class AcpSession {
  private child: SpawnedChild | null = null;
  private killTree: (() => void) | null = null;
  private connection: ClientConnection | OpenCodeConnection | null = null;
  private agent: ClientContext | null = null;
  private starting: Promise<void> | null = null;
  /**
   * The thread's latest session context, kept across turns. `available_commands_update`
   * typically arrives right after `session/new` or `session/load`, before any
   * turn is in flight, so the update handler reports through this rather than
   * through `current`, or the list would be dropped between turns.
   */
  private ctx: SessionContext | null = null;

  private sessionId: string | null = null;
  private canLoad = false;
  /** The agent deletes sessions on request: a discovery session does not outlive its reading. */
  private canDelete = false;
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
  private readonly retention = new SessionRetention();
  /** The turn whose `session/prompt` is in flight; updates outside one are dropped. */
  private current: AcpTurn | null = null;
  /** The turn the queue is running, from its start to its end, prompt or not. */
  private active: AcpTurn | null = null;
  /** Armed by a stop on a prompt in flight: an agent that ignores the cancel is closed. */
  private stopTimer: Timer | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Antigravity's shell commands, the ones that outlived their turn included. */
  private readonly commands = new OpenCommands();
  /** Grok answered `_x.ai/interject` with an error once: this process has no mid-turn input. */
  private interjectRefused = false;
  private running = 0;
  private closing = false;
  private ended = false;
  private catalogValid = true;
  private protection: ReturnType<typeof protectedAcp> = null;

  constructor(
    readonly key: string,
    private warmMs: number,
    private readonly deps: AcpDeps,
    private readonly memory: AcpMemory,
    private readonly onEnded: (session: AcpSession) => void,
    /** The config options a session answered with, for the next session of the account to start from. */
    private readonly onOptions: (options: SessionConfigOption[]) => void = () => undefined,
  ) {}

  async catalog(ctx: ProbeContext): Promise<ModelInfo[] | null> {
    const setup = this.ctx;
    const scope = ctx.catalogThread;
    if (!this.catalogValid || this.ended || this.closing || setup === null || scope === undefined
      || setup.thread.id !== scope.id || scope.providerId !== ctx.provider.id || scope.accountId !== ctx.accountId
      || setup.thread.cwd !== scope.cwd
      || JSON.stringify(setup.thread.contextMode ?? null) !== JSON.stringify(scope.contextMode ?? null)
      || setup.provider.id !== ctx.provider.id || setup.account.id !== ctx.accountId
      || JSON.stringify(setup.accountEnv) !== JSON.stringify(ctx.accountEnv)
      || JSON.stringify(setup.provider) !== JSON.stringify(ctx.provider)) return null;
    // Composition may ask for models while the matching prompt-free opener is
    // still initializing. Share that work before deciding a probe is needed.
    try { await this.starting; } catch { return null; }
    if (!this.catalogValid || this.ended || this.closing || this.sessionId === null) return null;
    return this.controls.catalog(setup);
  }

  forgetCatalog(filter: ProbeFilter): void {
    if (this.ctx === null) return;
    if (filter.providerId !== undefined && filter.providerId !== this.ctx.provider.id) return;
    if (filter.accountId !== undefined && filter.accountId !== this.ctx.account.id) return;
    // A session still opening reads its options after the refresh asked: they
    // are the fresh catalog. The composer asks for one as the app opens, while
    // the draft's own process starts, and a catalog lost here costs the first
    // prompt one more agent process (2.6 s for OpenCode 2 2.0.30).
    if (filter.refresh === true && this.sessionId === null && !this.ended) return;
    this.catalogValid = false;
  }

  seedConfig(options: SessionConfigOption[]): void {
    this.controls.seed(options);
  }

  /**
   * Reusable only while the process is up and the turn asks for the very same
   * setup. A command an earlier turn left running keeps it reusable whatever
   * the warm window: a new process would end that command.
   */
  usable(key: string, warmMs: number): boolean {
    return !this.ended && !this.closing && this.key === key && (this.retention.reusable(warmMs, this.warmMs) || this.commands.outlived());
  }

  setViewed(viewed: boolean): void {
    this.retention.setViewed(viewed);
    this.clearIdle();
    if (!viewed && !this.busy() && !this.ended) this.armIdle();
  }

  async prepare(ctx: SessionContext, forTurn = false): Promise<void> {
    this.retention.prepare(forTurn);
    this.clearIdle();
    try { await this.start(ctx); }
    catch (error) { this.drop(); throw error; }
    finally {
      ctx.finishStartup?.();
      if (!this.ended && !this.busy() && !this.retention.viewed) this.armIdle();
    }
  }

  busy(): boolean {
    return this.running > 0;
  }

  attach(turn: AcpTurn, warmMs: number): void {
    this.warmMs = warmMs;
    this.retention.beginTurn();
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

  /**
   * Grok's `_x.ai/interject`: the text joins the running prompt at the agent's
   * next safe point, between two tool calls or two model calls. Only while this
   * turn's prompt is in flight: on an idle session Grok runs the text as a turn
   * of its own that no Boite turn would draw. An agent that answers with an
   * error, an older Grok without the method, is not asked again.
   */
  async steer(turn: AcpTurn, text: string): Promise<boolean> {
    const agent = this.agent;
    const sessionId = this.sessionId;
    if (this.interjectRefused || agent === null || sessionId === null || this.current !== turn || turn.isStopped) return false;
    try {
      await agent.request('_x.ai/interject', { sessionId, text });
      return true;
    } catch (error) {
      if (!rpcRefusal(error)) throw error;
      this.interjectRefused = true;
      turn.ctx.log('warn', `acp: ${turn.ctx.provider.id} refused _x.ai/interject, answers wait for the turn's end: ${rpcReason(error)}`);
      return false;
    }
  }

  async steerOpenCode(turn: AcpTurn, text: string, attachments: import('@boite/contracts').ImageAttachment[] = [], onAccepted?: () => void): Promise<boolean> {
    if (this.current !== turn || turn.isStopped || !(this.connection instanceof OpenCodeConnection)) return false;
    return this.connection.steer([{ type: 'text', text }, ...imageBlocksOf(attachments)], onAccepted);
  }

  private cancel(): void {
    const agent = this.agent;
    const sessionId = this.sessionId;
    if (agent === null || sessionId === null) return;
    void agent.notify('session/cancel', { sessionId }).catch(() => undefined);
  }

  /** Archive, shutdown, an idle window, a changed setup: the process goes. */
  close(reason: string | null, ctx?: SessionContext): void {
    if (this.ended) return;
    this.closing = true;
    if (reason !== null && ctx !== undefined) ctx.log('warn', `acp session: ${reason}`);
    this.drop();
  }

  // -- the process ----------------------------------------------------------

  async setPermissionMode(turn: AcpTurn, mode: PermissionMode): Promise<boolean> {
    if (turn.ctx.protectedExecution) return false;
    if (this.current !== turn || turn.isStopped || this.closing || this.ended) return false;
    const applied = await this.controls.applyMode({ ...turn.ctx, thread: { ...turn.ctx.thread, permissionMode: mode } });
    if (applied) turn.ctx.thread.permissionMode = mode;
    return applied;
  }

  /**
   * The reasoning effort of a prompt that is still running, as the same
   * `session/set_config_option` a turn starts with. OpenCode 1.18.35 answered
   * it during a tool call with the new current value and finished the prompt
   * normally (probed on 2026-10-07); whether the requests left in that prompt
   * use it is the agent's own business. ACP has no speed. Grok takes its
   * effort inside `session/set_model`, untested while it prompts, so it waits
   * for the next turn.
   */
  async applySettings(turn: AcpTurn, change: LiveTurnSettings): Promise<LiveTurnSettings> {
    if (this.current !== turn || turn.isStopped || this.closing || this.ended) return {};
    const effort = change.effort;
    if (typeof effort !== 'string' || effort.length === 0) return {};
    if (!(await this.controls.applyEffort(turn.ctx, effort))) return {};
    turn.ctx.thread.effort = effort;
    return { effort };
  }

  private async runTurn(turn: AcpTurn): Promise<void> {
    this.active = turn;
    if (turn.isStopped) {
      turn.stopNow();
      this.endTurn(turn, false);
      return;
    }
    this.ctx = turn.ctx;
    try {
      turn.ctx.protectedExecution?.check();
      await this.start(turn.ctx);
    } catch (error) {
      if (turn.isStopped) {
        turn.stopNow();
      } else if (error instanceof LoadRefused && error.lost) {
        turn.loseSession(error.message);
      } else if (error instanceof LoadRefused || error instanceof ModelRefused) {
        turn.fail(error.message);
      } else {
        // An agent that exits while it starts takes the connection with it,
        // and its exit code and last stderr line say more than that.
        const code = await exitWithin(this.exited, EXIT_GRACE_MS);
        turn.fail(code === undefined ? failureText(error) : this.exitSentence(code), code === undefined ? logMessageOf(error) : this.exitSentence(code, true));
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
    // sends nothing when what it carries has not moved. A model the agent did
    // not take ends the turn here: the prompt would run on the previous one.
    try {
      await this.controls.applyModel(turn.ctx);
      await this.controls.applyConfig(turn.ctx);
      await this.controls.applyMode(turn.ctx);
    } catch (error) {
      if (!(error instanceof ModelRefused)) throw error;
      // A stop closes the agent under a switch it has not answered.
      if (turn.isStopped) turn.stopNow();
      else turn.fail(error.message);
      this.endTurn(turn, turn.isStopped);
      return;
    }
    const judged = this.costBaseline(turn);
    this.current = turn;
    let response: PromptResponse;
    try {
      const pending = agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }, ...imageBlocksOf(attachments)],
      });
      if (turn.isStopped) this.cancel();
      // The agent is up and holds the prompt. Until its first update the wait
      // is the model's: OpenCode retries a refused provider for a minute and
      // more without a word on the wire, which must not read as a start.
      else turn.ctx.reportProgress?.('waiting');
      response = await pending;
    } catch (error) {
      this.current = null;
      if (turn.isStopped) {
        // The stop closed the process under the prompt.
        turn.stopNow();
      } else {
        // A child that died takes the connection with it, and its exit says more
        // than "the connection closed": give it a moment to be reported.
        const code = await exitWithin(this.exited, EXIT_GRACE_MS);
        turn.fail(code === undefined ? failureText(error) : this.exitSentence(code), code === undefined ? logMessageOf(error) : this.exitSentence(code, true));
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
    // A command the prompt left running keeps the process: closing it would
    // end the command, which Stop on the idle thread does when asked.
    const outlived = !drop && !this.closing && turn.antigravity && this.commands.promote(turn.ctx);
    const dropping = drop || this.closing || (!outlived && this.retention.idleMs(this.warmMs) <= 0);
    turn.settle();
    this.running = Math.max(0, this.running - 1);
    if (dropping) {
      this.drop();
      return;
    }
    if (this.running === 0 && !this.retention.viewed) this.armIdle();
  }

  private start(ctx: SessionContext): Promise<void> {
    this.ctx = ctx;
    if (this.starting === null) {
      this.starting = noteReady(ctx, `${ctx.provider.id} ACP`, async () => {
        await this.open(ctx);
        this.protection?.assertReady();
        this.protection?.assertMcpReady();
        await this.controls.applyModel(ctx);
        await this.controls.applyConfig(ctx);
        await this.controls.applyMode(ctx);
        if (this.ended) throw new Error('the acp session was closed while it started');
      }, () => ({
        text: this.loaded ? ', loaded the saved session' : this.replaces !== null ? ', a new one replacing a session it cannot load' : '',
        data: { loaded: this.loaded, canLoad: this.canLoad, replaced: this.replaces !== null, images: this.imagesSupported },
        ...(this.replaces !== null ? { resumed: false } : {}),
      }), () => this.active?.isStopped === true || this.ended || this.closing);
    }
    return this.starting;
  }

  private async open(ctx: SessionContext): Promise<void> {
    const sdk = await this.deps.loadSdk();
    // A stop while the SDK loaded: nothing may be spawned for a session that is over.
    if (this.ended) throw Object.assign(new Error('the acp session was closed before it started'), { abandoned: true });
    const profile = profileFor(ctx.provider);
    const launch = resolveLaunch(profile);
    if (launch === null) {
      throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
    }

    this.protection = protectedAcp(ctx, () => this.current, profile?.launch?.args ?? []);
    const temp = launchTemp(ctx.provider, ctx.account.isolationDir);
    let child: SpawnedChild;
    const native = ctx.provider.id === 'opencode-v2';
    const password = native ? randomBytes(32).toString('base64url') : null;
    const args = launchArgs(profile, launch.prefix, ctx.provider, ctx.thread.permissionMode);
    // Preserve executable wrappers and fixture prefixes, replace only the ACP
    // subcommand. The native server's stdin is its ownership lease.
    const nativeArgs = [...launch.prefix, ...(profile?.launch?.args ?? ['acp']).filter(arg => arg !== 'acp'), 'serve', '--stdio', '--port', '0'];
    try {
      child = ctx.spawnChild(launch.executable, native ? nativeArgs : args, {
        cwd: this.protection?.cwd ?? ctx.thread.cwd,
        env: { ...agentEnv(ctx.provider, temp === null ? ctx.accountEnv : { ...ctx.accountEnv, ...temp.env }), ...this.protection?.env, ...(password === null ? {} : { OPENCODE_PASSWORD: password }) },
      });
    } catch (error) {
      void temp?.dispose();
      throw error;
    }
    // The directory the agent unpacked into goes with its last process.
    if (temp !== null) {
      const dispose = (): void => void temp.dispose((message) => ctx.log('warn', `acp session: ${message}`));
      child.once('close', dispose);
      child.once('error', dispose);
    }
    this.child = child;
    this.killTree = ctx.killTree ?? null;
    this.watch(child, ctx);

    const stream = native ? null : sdk.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      jsonLinesOnly(Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>, (line) => {
        ctx.log('warn', `acp agent: ${line.slice(0, STDERR_MAX)}`, { kind: 'provider-output', event: 'provider.output' });
      }),
    );
    const connection = native
      ? await OpenCodeConnection.open(child, password!, ctx.thread.cwd, params => this.onUpdate(params), () => this.current)
      : sdk
      .client({ name: CLIENT_NAME })
      // Checked by hand rather than by the SDK's schema, which also parses
      // every update once more on its own (see `sessionNotificationOf`).
      .onNotification('session/update', sessionNotificationOf, ({ params }) => {
        if (params !== null) this.onUpdate(params);
      })
      .onRequest('session/request_permission', ({ params }) => this.protection ? Promise.resolve({outcome: {outcome: 'cancelled' as const}}) : answerPermission(this.current, params))
      .connect(stream!);
    this.connection = connection;
    this.agent = connection.agent;

    // No fs, no terminal: an agent that calls one anyway gets a
    // method-not-found from the SDK, which is the loud refusal we want.
    const init = await connection.agent.request('initialize', {
      protocolVersion: sdk.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: CLIENT_NAME, version: pkg.version },
    });
    this.canLoad = !this.protection && init.agentCapabilities?.loadSession === true;
    if (this.protection && (init.agentInfo?.name !== 'OpenCode' || init.agentInfo?.version !== '1.19.3')) throw new Error(`execution.acp.agentInfo: expected verified OpenCode 1.19.3, received ${init.agentInfo?.name} ${init.agentInfo?.version}`);
    this.canDelete = canDeleteSessions(init);
    this.imagesSupported = init.agentCapabilities?.promptCapabilities?.image === true;
    // The agent binary fills these: only text and numbers reach the log.
    const scalar = (value: unknown): string | null => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
    const agentName = scalar(init.agentInfo?.name), agentVersion = scalar(init.agentInfo?.version), protocol = scalar(init.protocolVersion);
    ctx.diagnostic?.('info', `${ctx.provider.id} answered initialize as ${agentName ?? 'an unnamed agent'} ${agentVersion ?? ''}, ACP protocol ${protocol ?? 'unknown'}`.replace(/ {2,}/g, ' '), {
      event: 'driver.initialized', data: { agent: agentName, version: agentVersion, protocol, loadSession: this.canLoad },
    });

    if (ctx.sessionId !== null && this.canLoad) {
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
        ctx.diagnostic?.('warn', `session/load refused with code ${errorCodeOf((error as { code?: unknown }).code) ?? 'unknown'}, read as ${kind}`, { event: 'driver.session.load-refused', data: { code: errorCodeOf((error as { code?: unknown }).code), kind } });
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
      // A load may omit its controls; both OpenCode majors answer them, so no
      // empty session is opened for nothing. With no probe cache either, a
      // throwaway session reads them once for the account, and the next cold
      // turn of any thread starts from what it found.
      if (!isGrok(ctx.provider) && !this.controls.hasOptions()
        && (ctx.thread.model !== AGENT_OWN_MODEL || ctx.thread.effort !== null)) {
        const discovered = await connection.agent.request('session/new', { cwd: ctx.thread.cwd, mcpServers: [] });
        this.seedConfig(discovered.configOptions ?? []);
        this.onOptions(discovered.configOptions ?? []);
        await discardSession(connection.agent, this.canDelete, discovered.sessionId);
      }
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
      cwd: this.protection?.cwd ?? ctx.thread.cwd,
      mcpServers: [],
    });
    this.sessionId = created.sessionId;
    this.controls.noteSession(created.modes, created.configOptions ?? null, created);
    this.controls.noteOwnModel(created.configOptions ?? null);
    this.onOptions(created.configOptions ?? []);
  }

  private watch(child: SpawnedChild, ctx: SessionContext): void {
    child.stdin.on('error', () => undefined);
    stderrLines(child.stderr, (text) => {
      this.lastStderr = text.slice(0, STDERR_MAX);
      // Antigravity writes every protocol frame to stderr as a glog info line,
      // three hundred a turn: only what the agent itself calls a warning is one.
      if (GLOG_INFO.test(text)) return;
      ctx.log('warn', `acp agent: ${this.lastStderr}`, { kind: 'provider-output', event: 'provider.output' });
    });
    this.exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
        // A process that dies on its own leaves nothing reusable behind: the
        // next turn of the thread starts a fresh one.
        if (!this.closing) this.drop(this.exitSentence(code), this.exitSentence(code, true));
      });
      child.once('error', () => {
        resolve(null);
        if (!this.closing) this.drop();
      });
    });
  }

  private exitSentence(code: number | null, diagnostic = false): string {
    const head = `the acp agent exited with code ${code === null ? 'unknown' : code}`;
    return diagnostic || this.lastStderr.length === 0 ? head : `${head}: ${this.lastStderr}`;
  }

  /** The turn settles before its connection and child go through the registry. */
  private drop(reason = 'the acp session closed', diagnostic?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.closing = true;
    const current = this.current;
    this.current = null;
    if (current !== null) {
      if (current.isStopped) current.stopNow();
      else current.fail(reason, diagnostic);
      current.settle();
    }
    this.protection?.close(this.exited ?? Promise.resolve());
    this.protection = null;
    this.clearIdle();
    this.commands.clear();
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
    releaseChild(child, this.killTree);
    this.onEnded(this);
  }

  private armIdle(): void {
    this.clearIdle();
    // The window starts once the last command that outlived its turn ended.
    if (this.commands.outlived()) return;
    this.idle = setTimeout(() => {
      this.idle = null;
      this.drop();
    }, this.retention.idleMs(this.warmMs));
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
    // The same announcement from an agent whose modes are a config option. Only
    // for this thread's session once it is open: a `session/load` replays the
    // options of turns long past before the session id is set, and the same
    // connection carries the throwaway session the options were discovered on,
    // whose late update would otherwise overwrite the mode kept for this one.
    if (update.sessionUpdate === 'config_option_update') {
      if (this.sessionId !== null && params.sessionId === this.sessionId) this.controls.noteOptionUpdate(update.configOptions);
      return;
    }
    // A running total outside a turn is still what the next one is measured
    // from: an agent may report it while a load replays, or between turns.
    if (update.sessionUpdate === 'usage_update') {
      const cost = usdCostOf(update);
      if (cost !== null) this.reportedCost = cost;
    }
    // This session's own: a `session/load` replays its history before the id is set.
    if (this.ctx?.provider.quirks?.includes('antigravity') === true && params.sessionId === this.sessionId
      && this.commands.note(update) && !this.busy()) {
      // The last command a finished turn left running ended: the warm rule applies from now.
      if (this.retention.idleMs(this.warmMs) <= 0) this.drop();
      else if (!this.retention.viewed) this.armIdle();
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
export function sessionKey(ctx: SessionContext): string {
  return JSON.stringify({
    protection: ctx.protectedExecution?.fingerprint ?? null,
    permissionMode: isGrok(ctx.provider) ? ctx.thread.permissionMode : null,
    cwd: ctx.thread.cwd,
    contextMode: ctx.thread.contextMode,
    launch: profileFor(ctx.provider),
    accountId: ctx.account.id,
    providerId: ctx.provider.id,
    env: ctx.accountEnv,
  });
}
