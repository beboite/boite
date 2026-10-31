import { sharedProjectMethods } from './fake-client/shared-projects';
import { sharedLookupMethods } from './fake-client/shared-lookup';
import { sharedBoardMethods } from './fake-client/shared-board';
import { sharedComputeMethods, setSharedRepository, setSharedNativeExecution, finishSharedCompute } from './fake-client/shared-compute';
import { sharedAccessMethods } from './fake-client/shared-access';
import { sharedLetterMethods } from './fake-client/shared-letters';
import { sharedState, sharedContact, reconcileShared, refusedShared } from './fake-client/shared-state';
import { startupMethods, resetStartup } from './fake-client/startup';
import { composerMethods } from './fake-client/composer';
import { holdContactMail } from './fake-client/contact-hold';
import { seedIdle, seedWorking } from './fake-client/working-seed';
import { sweepMergedPrFixtures, type MergedPrFixture } from './fake-client/merged-pr-archive';
import {
  RPC_CHUNK_BYTES,
  RpcErrorCode,
  accessRefusal,
  checkRpcParams,
  type CoreInfo,
  type CoreLogContext,
  type ExperimentId,
  type HookRun,
  type MemoryEvent,
  type PolicyState,
  type ProcessRecord,
  type Principal,
  type RpcEventName,
  type RpcEvents,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
  type ThreadId,
  type ThreadRetry,
  type ThreadWorktreeRemoval,
} from '@boite/contracts';
import { RpcFailure, type CallOptions, type ClientState, type EventHandler, type ObservableClient } from './client';
import { closedFailure } from './rpc-error';
import { accountMethods } from './fake-client/accounts';
import { activityMethods, pauseActivity } from './fake-client/activity';
import { brainMethods } from './fake-client/brain';
import { FakeContext, type FakeClientOptions, type FakeMethods } from './fake-client/context';
import { hookMethods, recordHookRun } from './fake-client/hooks';
import { logMethods, seedDiagnostics } from './fake-client/logs';
import { coordinationMethods, registerCore, trusts, unregisterCore } from './fake-client/coordination';
import { delegationMethods, seedDelegationDemo } from './fake-client/delegation';
import { seedBoardDemo } from './fake-client/board-demo';
import { seedSubagentsDemo } from './fake-client/subagents-demo';
import { seedAgentsDemo } from './fake-client/agents-demo';
import { agentSettingMethods } from './fake-client/agent-settings';
import type { AgentSettingMethod } from './fake-agents';
import { groupMethods } from './fake-client/group';
import { contactMethods } from './fake-client/contacts';
import { pairingMethods } from './fake-client/pairing';
import { projectMethods } from './fake-client/projects';
import { pathKey } from './fake-client/checks';
import { projectIconMethods } from './fake-client/project-icons';
import { providerCatalogMethods } from './fake-client/provider-catalog';
import { providerInstallMethods } from './fake-client/provider-installs';
import { RELEASES } from './fake-client/providers';
import { clearRequestsOf, requestMethods } from './fake-client/requests';
import { closeSecrets, secretMethods } from './fake-client/secrets';
import { resourceMethods } from './fake-client/resources';
import { seed } from './fake-client/seed';
import { settingsMethods } from './fake-client/settings';
import { gatewayMoveMethods } from './fake-client/gateway-move';
import { speechMethods } from './fake-client/speech';
import { terminalMethods } from './fake-client/terminals';
import { capabilityMethods } from './fake-client/capabilities';
import { agentShapeMethods } from './fake-client/agent-shape';
import { deleteExpiredDoneThreads, purgeDeletedThreads, threadMethods } from './fake-client/threads';
import { threadMoveMethods } from './fake-client/thread-move';
import { spawnMethods } from './fake-client/spawn';
import { todoMethods } from './fake-client/todos';
import { workdirMethods } from './fake-client/workdir';
import { browserMethods } from './fake-client/browser';
import { devicesMethods } from './fake-client/devices';
import { seedWindowsDemo, windowsMethods } from './fake-client/windows';
import { desktopMethods } from './fake-client/desktop';
import { pullRequestMethods } from './fake-client/pull-requests';
import { worktreeMethods } from './fake-client/worktrees';
import { serverUpdateMethods } from './fake-client/server-update';
import { planRetry, retryMethods, seedRetry } from './fake-client/retry';
import { closeSideQuestions } from './fake-client/side-questions';
import { holdAfterRestart } from './fake-client/recovery';
import { journalInspectionMethods } from './fake-client/journal-inspection';
import { forkReturnMethods } from './fake-client/fork-return';
import { startLoad } from './fake-client/load';
import { applyPolicy, policyGate } from './fake-client/policy';

export type { FakeClientOptions } from './fake-client/context';

/**
 * What the core's chunk frames would have told `onProgress` about `result`:
 * nothing for an answer that fits in one slice, else each slice's running
 * count against the whole. The size is the result's JSON, without the few
 * bytes of the response envelope the core also counts.
 */
function reportSlices(result: unknown, onProgress: (received: number, total: number) => void): void {
  const total = new TextEncoder().encode(JSON.stringify(result) ?? '').byteLength;
  if (total <= RPC_CHUNK_BYTES) return;
  for (let received = RPC_CHUNK_BYTES; received < total; received += RPC_CHUNK_BYTES) onProgress(received, total);
  onProgress(total, total);
}

/**
 * The in-memory client: the whole RPC contract answered by one fake core,
 * behind the same surface as `WsClient`. The core's state and its domains
 * live under `fake-client/`, one module per domain; this class is the socket.
 */
export class FakeClient implements ObservableClient {
  readonly #ctx: FakeContext;
  readonly #methods: FakeMethods;
  readonly #missing: ReadonlySet<string>;
  readonly #agentSettings: ReturnType<typeof agentSettingMethods>;
  #mergedPrSweep: Promise<number> | null = null;
  #doneSweep: Promise<void> | null = null;
  #transportGeneration = 0;
  readonly #stopWorking: () => void;
  #stopLoad: () => void = () => undefined;

  constructor(options: FakeClientOptions = {}) {
    const ctx = new FakeContext(options);
    this.#ctx = ctx;
    this.#methods = this.#answer(ctx);
    this.#missing = new Set(options.missing ?? []);
    ctx.core.features = { ...ctx.core.features, composerPersistence: !this.#missing.has('composer.list'), listChanges: !this.#missing.has('threads.listChanges') };
    this.#agentSettings = agentSettingMethods(ctx);
    registerCore(ctx);
    seed(ctx);
    if (options.delegationDemo) seedDelegationDemo(ctx);
    if (options.agentsDemo) seedAgentsDemo(ctx);
    if (options.subagentsDemo) seedSubagentsDemo(ctx);
    if (options.boardDemo) seedBoardDemo(ctx);
    seedRetry(ctx);
    this.#stopWorking = seedWorking(ctx, options.working ?? 0);
    seedIdle(ctx, options.idle ?? 0);
    if (options.watchDemo) {
      const at = Date.now();
      const watch = (number: number) => ({ url: `https://github.com/mtsu-dev/boite/pull/${number}`, repository: 'mtsu-dev/boite', number, since: at - 600_000 });
      ctx.thread('t-trace').pullRequestWatches = [
        { ...watch(512), paused: null, seen: { checkedAt: at - 30_000, head: '3e535df', base: 'main', checks: { total: 26, running: 4, failed: 1 }, conflicting: false } },
        { ...watch(498), paused: { reason: 'rate-limit', until: at + 240_000, message: 'API rate limit exceeded' }, seen: { checkedAt: at - 300_000, head: '2f257f4', base: 'main', checks: { total: 26, running: 0, failed: 0 }, conflicting: true } },
      ];
    }
    if (options.windowsDemo) seedWindowsDemo(ctx);
    if (options.uninstalled) {
      ctx.providers = ctx.providers.filter(provider => provider.id !== 'echo').map(provider => ({
        ...provider, available: false, executable: null,
        install: RELEASES[provider.id] ? { state: 'absent', ...RELEASES[provider.id]! } : null,
      }));
      ctx.accounts = [];
      // A first launch: no folder opened yet, so the app lands in the drafts.
      ctx.projects = [];
      ctx.threads.clear();
      ctx.importable = [];
      ctx.pendingPermissions.clear();
      ctx.pendingQuestions.clear();
      ctx.processes = [];
      ctx.todos = [];
      ctx.usage.clear();
      ctx.usageSeeded = false;
      ctx.scheduler = { ...ctx.scheduler, running: [], queued: [] };
    }
    // Again once the seeds and a first launch have set the providers the policy marks.
    applyPolicy(ctx);
    if (options.load) this.#stopLoad = startLoad(ctx, options.load, options.loadTickMs);
    // After a first launch has cleared the threads, so no record names one that is gone.
    seedDiagnostics(ctx);
  }

  // -------------------------------------------------------------------------
  // Client surface
  // -------------------------------------------------------------------------

  get state(): ClientState {
    return this.#ctx.bus.state;
  }

  /** A second device connected to this fake core's shared composer. */
  composerPeer(options: Omit<FakeClientOptions, 'composerState'> = {}): FakeClient {
    const peer = new FakeClient({ ...options, composerState: this.#ctx.composer });
    // A new connection sees the current core snapshot, including newly created conversations.
    peer.#ctx.threads.clear();
    for (const [id, thread] of this.#ctx.threads) peer.#ctx.threads.set(id, structuredClone(thread));
    peer.#ctx.projects.splice(0, peer.#ctx.projects.length, ...structuredClone(this.#ctx.projects));
    peer.#ctx.seq = Math.max(peer.#ctx.seq, this.#ctx.seq);
    return peer;
  }

  get core(): CoreInfo | null {
    return this.#ctx.bus.state === 'ready' ? this.#ctx.core : null;
  }

  /**
   * Who the core says this client is, `null` until `hello` has answered, which
   * is what the real `WsClient` reports. The fake is the desktop owner unless
   * it was built with `{ principal: 'session' }`, the paired phone.
   */
  get principal(): Principal | null {
    return this.#ctx.bus.state === 'ready' ? this.#ctx.bus.principal : null;
  }

  /**
   * Turns this client into a paired device, an agent, or back into the owner,
   * in the spirit of `drop` and `restore`: the boundary is the core's, so a
   * test can cross it without a second socket. `hello` and every later call
   * answer as the new principal from here on. An agent speaks for the thread
   * its token names, `threadId` or the one the client was built with.
   */
  becomes(principal: Principal, threadId?: ThreadId): void {
    this.#ctx.bus.principal = principal;
    if (threadId !== undefined) this.#ctx.agentThreadId = threadId;
  }

  setBrainLinkPermission(denied: boolean): void {
    this.#ctx.brainLinkPermission = denied;
  }

  /** Test fixture: no provider turn is started. */
  holdAfterRestart(threadId: ThreadId, prompt: string) {
    return holdAfterRestart(this.#ctx, threadId, prompt);
  }
  /** A fixture for a retry the core planned: the thread's row carries it until it is cancelled. */
  planRetry(threadId: ThreadId, retry: ThreadRetry) {
    planRetry(this.#ctx, threadId, retry);
  }


  /**
   * Takes a folder off the fake's disk, as a repository deleted outside the
   * app: the project there reads `missing` on its next answer, and a thread
   * in it or under it is refused a turn.
   */
  loseFolder(path: string): void {
    this.#ctx.goneFolders.add(pathKey(path));
  }

  /**
   * What the core's settled worktree cleanup leaves behind: the thread's
   * folder gone from the fake's disk and the removal on its summary.
   */
  removeWorktree(threadId: ThreadId, removal: Omit<ThreadWorktreeRemoval, 'path'>): void {
    const thread = this.#ctx.threads.get(threadId);
    if (!thread) throw new Error(`no fake thread ${threadId}`);
    this.#ctx.goneFolders.add(pathKey(thread.cwd));
    thread.worktreeRemoved = { ...removal, path: thread.cwd };
    this.#ctx.touch(thread);
  }

  /** What the core says of a thread whose history read contact mail outside a shared project. */
  holdForContactMail(threadId: ThreadId, contacts: string[]): void {
    const thread = this.#ctx.threads.get(threadId);
    if (!thread) throw new Error(`no fake thread ${threadId}`);
    holdContactMail(this.#ctx, threadId, contacts);
  }

  setMergedPrFixture(threadId: ThreadId, fixture: MergedPrFixture): void {
    this.#ctx.mergedPrFixtures.set(threadId, fixture);
  }

  sweepMergedPrArchives(): Promise<number> {
    if (this.#mergedPrSweep) return this.#mergedPrSweep;
    this.#mergedPrSweep = sweepMergedPrFixtures(this.#ctx).finally(() => { this.#mergedPrSweep = null; });
    return this.#mergedPrSweep;
  }

  sweepDoneThreads(): Promise<void> {
    return this.#doneSweep ??= deleteExpiredDoneThreads(this.#ctx, id => this.#methods['threads.remove']({ threadId: id }))
      .finally(() => { this.#doneSweep = null; });
  }

  onState(handler: (state: ClientState) => void): () => void {
    return this.#ctx.bus.onState(handler);
  }

  on<E extends RpcEventName>(event: E, handler: EventHandler<E>): () => void {
    return this.#ctx.bus.on(event, handler);
  }

  async connect(): Promise<CoreInfo> {
    if ([...this.#ctx.threads.values()].some(thread => thread.doneAt != null)) await this.sweepDoneThreads();
    purgeDeletedThreads(this.#ctx);
    this.#ctx.agents.open();
    this.#ctx.bus.setState('connecting');
    await this.#ctx.tick();
    this.#ctx.bus.setState('ready');
    return this.#ctx.core;
  }

  close(): void {
    const ctx = this.#ctx;
    ctx.composer.detach(ctx);
    this.#stopWorking();
    closeSideQuestions(ctx);
    closeSecrets(ctx);
    this.#stopLoad();
    ctx.agents.close();
    unregisterCore(ctx);
    for (const thread of ctx.threads.values()) pauseActivity(ctx, thread);
    ctx.plugins.close();
    ctx.workflows.close();
    for (const url of ctx.artifactUrls) URL.revokeObjectURL(url);
    ctx.artifactUrls.clear();
    ctx.bus.setState('closed');
    this.#dropPending('client closed');
  }

  /**
   * The socket going away under the app, what `WsClient` does from
   * `socket.onclose`: every call it was holding rejects with the transport's
   * own failure, the state falls back to `connecting`, and the core's events
   * of that gap reach nobody. The core keeps running behind it.
   */
  drop(): void {
    if (this.#ctx.bus.state !== 'ready') return;
    this.#ctx.bus.setState('connecting');
    this.#dropPending('connection closed', true);
  }

  /** The socket back and the hello answered, `#resubscribe` included. */
  async restore(): Promise<CoreInfo> {
    const { bus } = this.#ctx;
    if (bus.state === 'ready') return this.#ctx.core;
    bus.setState('connecting');
    await this.#ctx.tick();
    bus.setState('ready');
    // `WsClient.#resubscribe` sends one `threads.subscribe` per id it kept.
    for (const threadId of bus.clientSubscribed) bus.subscribed.add(threadId);
    return this.#ctx.core;
  }

  /**
   * Another device's call on this core, which runs while this socket is down:
   * its events of the gap reach nobody here, as after `drop`.
   */
  elsewhere<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    return this.#dispatch(method, params) as Promise<RpcResult<M>>;
  }

  /** The ids the core holds this socket on, the set `emitToThread` gates on. */
  get coreSubscribers(): ThreadId[] {
    return [...this.#ctx.bus.subscribed];
  }

  /** The ids the client would resubscribe after a reconnect. */
  get clientSubscriptions(): ThreadId[] {
    return [...this.#ctx.bus.clientSubscribed];
  }

  async call<M extends RpcMethodName>(method: M, params: RpcParams<M>, options: CallOptions = {}): Promise<RpcResult<M>> {
    const { bus } = this.#ctx;
    const generation = this.#transportGeneration;
    if (bus.state !== 'ready' && method !== 'hello') {
      throw closedFailure();
    }
    await this.#ctx.tick();
    if (this.#ctx.rttMs > 0) await this.#ctx.leg();
    if (generation !== this.#transportGeneration || (bus.state !== 'ready' && method !== 'hello')) {
      throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'connection changed before RPC dispatch' });
    }
    if (this.#missing.has(method)) throw new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: `unknown method ${method}` });
    // The router's gate, word for word: `hello` before it, then who may call what, then the method's params rule.
    if (method !== 'hello') {
      const refusal = accessRefusal(method, { principal: bus.principal, threadId: this.#ctx.agentThreadId }, params);
      if (refusal) throw new RpcFailure({ code: RpcErrorCode.Refused, message: refusal.message, data: refusal.data });
    }
    const checked = checkRpcParams(method, params);
    if (!checked.ok) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: checked.message, data: { field: checked.field } });
    params = checked.params as RpcParams<M>;
    // The admin policy's gate runs before the method, as the core's router does.
    policyGate(this.#ctx, method, params);
    const result = await bus.hold(this.#dispatch(method, params)) as RpcResult<M>;
    if (this.#ctx.rttMs > 0) {
      // An answer still on its way back when the socket changed never arrives.
      await this.#ctx.leg();
      if (generation !== this.#transportGeneration || (bus.state !== 'ready' && method !== 'hello')) {
        throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'connection changed before RPC answer' });
      }
    }
    if (options.onProgress) reportSlices(result, options.onProgress);
    // The real client writes its set from the answer, never from the request.
    if (method === 'threads.create' && (params as RpcParams<'threads.create'>).subscribe) {
      bus.clientSubscribed.add((result as RpcResult<'threads.create'>).id);
    } else if (method === 'threads.subscribe') {
      bus.clientSubscribed.add((params as RpcParams<'threads.subscribe'>).threadId);
    } else if (method === 'threads.get' && (result as RpcResult<'threads.get'>).opened) {
      const request = params as RpcParams<'threads.get'>;
      bus.clientSubscribed.add(request.threadId);
      if (request.open?.previous && request.open.previous !== request.threadId) bus.clientSubscribed.delete(request.open.previous);
    } else if (method === 'threads.unsubscribe') {
      bus.clientSubscribed.delete((params as RpcParams<'threads.unsubscribe'>).threadId);
    }
    return result;
  }

  /**
   * One tick of the core's load sampler (`packages/core/src/procs.ts`): the
   * thread's fresh `load` alone, as `thread.load`, which this client's hello
   * accepts. It is not a `touch`: a load sample moves no row in the sidebar.
   */
  sampleLoad(threadId: ThreadId, processes = 1): void {
    const thread = this.#ctx.thread(threadId);
    thread.load = { processes, cpuPercent: 12, memoryBytes: 48 * 1024 * 1024 };
    this.#ctx.emit('thread.load', { threadId, load: structuredClone(thread.load) });
  }

  /** The thread's last process exits: its row has no load, and no event says so to the list. */
  endLoad(threadId: ThreadId): void {
    this.#ctx.thread(threadId).load = null;
  }

  /** Explicit deterministic Git fixture, separate from any RPC input. */
  setSharedNativeExecution(available: boolean): void { setSharedNativeExecution(this.#ctx, available); }
  setSharedRepository(projectId: string, repository: string, head: string): void { setSharedRepository(this.#ctx, projectId, repository, head); }
  finishSharedCompute(jobId: string, text: string): void { finishSharedCompute(this.#ctx, jobId, text); }
  get sharedSubscriptions() { return [...sharedState(this.#ctx).subscriptions.values()].map(p => ({...p})); }
  setContactConnected(coreId: string, connected: boolean): void {
    const contact = sharedContact(this.#ctx, coreId);
    if (!contact) throw refusedShared('coreId: expected a contact');
    contact.link = connected ? 'connected' : 'offline';
    reconcileShared(this.#ctx);
  }

  /** The desktop app on the fake machine reporting its experiments, as the core's book announces a change. */
  reportDesktopExperiments(experiments: ExperimentId[]): void {
    this.#ctx.desktopExperiments = [...experiments];
    this.#ctx.emit('client.desktopExperiments', { experiments: [...experiments] });
  }

  /** The policy file edited on the fake machine, as the core's watcher rereads it and announces the change. */
  changePolicy(policy: PolicyState): void {
    this.#ctx.policy = structuredClone(policy);
    applyPolicy(this.#ctx);
    this.#ctx.emit('policy.changed', structuredClone(policy));
    this.#ctx.emit('settings.updated', { ...this.#ctx.settings });
    this.#ctx.emit('providers.updated', { loaded: structuredClone(this.#ctx.providers), rejected: [] });
  }

  /** A line of the core's own log, as `core.log` carries it: a failed scheduler, a guard at work. */
  emitCoreLog(level: RpcEvents['core.log']['level'], message: string, context: CoreLogContext = {}): void {
    this.#ctx.emit('core.log', { level, message, at: this.#ctx.now(), ...context });
  }

  /** Output a shell writes by itself, cut where the caller wants: a sequence split across two events. */
  emitTerminalOutput(id: string, data: string): void {
    const shell = this.#ctx.terminals.get(id);
    if (!shell) return;
    shell.output += data;
    shell.sequence = (shell.sequence ?? 0) + 1;
    this.#ctx.emit('terminal.output', { id, data, sequence: shell.sequence });
  }

  /** A traced process starting, or ending once `exitedAt` is set, as the core's `procs.ts` announces it to the thread's subscribers. */
  traceProcess(record: ProcessRecord): void {
    this.#ctx.emitToThread(record.threadId, record.exitedAt === null ? 'process.started' : 'process.exited', structuredClone(record));
  }

  emitMemory(event: MemoryEvent): void {
    const ctx = this.#ctx;
    ctx.memoryState = event.state;
    ctx.emit('resources.memory', structuredClone(event));
    if (event.threadId === null) return;
    const threadId = event.threadId;
    const thread = ctx.threads.get(threadId);
    if (!thread) return;
    const message = thread.messages.at(-1);
    if (!event.anchor && message?.role === 'assistant' && message.state === 'streaming') {
      event = { ...event, anchor: { messageId: message.id, partIndex: message.parts.length } };
    }
    thread.memoryEvents = [...(thread.memoryEvents ?? []), event].slice(-100);
    ctx.emitToThread(threadId, 'thread.memory', { ...event, threadId });
  }

  /**
   * What the core announces when the login under an account changed while its
   * status did not, after a plugin switched the saved login for example
   * (`packages/core/src/plugins.ts`): the account again, which outdates its probes.
   */
  announceLogin(accountId: string): void {
    const account = this.#ctx.accounts.find((a) => a.id === accountId);
    if (!account) throw this.#ctx.notFound('account', accountId);
    this.#ctx.emit('accounts.updated', structuredClone(account));
  }

  /** A hook that blocked, failed, stopped a turn or was skipped, as the core records it and announces it with `hooks.changed`. */
  recordHookRun(run: HookRun): void {
    recordHookRun(this.#ctx, run);
  }

  /** The core's recovery settling every request a thread still waits on (`fake-client/requests.ts`, after `packages/core/src/threads/cards.ts`). */
  clearRequestsOf(threadId: ThreadId): void {
    clearRequestsOf(this.#ctx, threadId);
  }

  /** Resolves when no turn is still streaming. A pending permission blocks it. */
  async settled(): Promise<void> {
    while (this.#ctx.inFlight.size > 0) {
      await Promise.all([...this.#ctx.inFlight.values()].map((entry) => entry.done));
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  #dispatch(method: RpcMethodName, rawParams: unknown): Promise<unknown> {
    const ctx = this.#ctx;
    if (Object.hasOwn(this.#agentSettings, method)) {
      const handler = this.#agentSettings[method as AgentSettingMethod] as (params: unknown) => unknown;
      return Promise.resolve().then(() => handler(rawParams));
    }
    if (method.startsWith('agents.')) return Promise.resolve(ctx.agents.call(method as Extract<RpcMethodName, `agents.${string}`>, rawParams));
    if (ctx.plugins.handles(method)) return ctx.plugins.call(method, rawParams);
    if (ctx.workflows.handles(method)) return ctx.workflows.call(method, rawParams);
    if (!Object.hasOwn(this.#methods, method)) {
      return Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: `unknown method ${String(method)}` }));
    }
    const handler = this.#methods[method as keyof FakeMethods];
    return handler(rawParams as never);
  }

  #dropPending(message: string, dropped = false): void {
    this.#transportGeneration += 1;
    resetStartup(this.#ctx);
    this.#ctx.speechRequests.clear();
    this.#ctx.bus.dropPending(message, dropped);
  }

  // Every method's input and output are checked against the real RPC contract,
  // and each domain module answers its own share of it.
  #answer(ctx: FakeContext): FakeMethods {
    const threads = threadMethods(ctx);
    const projects = projectMethods(ctx);
    const coordination = coordinationMethods(ctx);
    const methods: FakeMethods = {
      'core.restart': async () => ({ ok: true as const }),
      'core.shutdown': async () => { ctx.agents.close(); await Promise.all([...ctx.threads.keys()].map(id => ctx.stopTurn(id))); setTimeout(() => this.close(), 25); return { ok: true }; },
      'hello': async (params) => {
        return { core: ctx.core, principal: ctx.bus.principal };
      },
      ...brainMethods(ctx),
      ...composerMethods(ctx, () => methods),
      ...logMethods(ctx),
      ...serverUpdateMethods(ctx),
      ...retryMethods(ctx),
      ...hookMethods(ctx),
      ...pairingMethods(ctx),
      ...projects,
      ...projectIconMethods(ctx),
      ...threads,
      ...startupMethods(ctx, threads),
      ...capabilityMethods(ctx),
      ...agentShapeMethods(ctx),
      ...forkReturnMethods(ctx),
      ...journalInspectionMethods(ctx),
      ...threadMoveMethods(ctx),
      ...spawnMethods(ctx, threads['threads.create'], projects['projects.add']),
      ...activityMethods(ctx),
      ...requestMethods(ctx),
      ...secretMethods(ctx),
      ...providerCatalogMethods(ctx),
      ...providerInstallMethods(ctx),
      ...accountMethods(ctx),
      ...terminalMethods(ctx),
      ...resourceMethods(ctx),
      ...settingsMethods(ctx),
      ...gatewayMoveMethods(ctx),
      ...speechMethods(ctx),
      ...delegationMethods(ctx),
      ...coordination,
      ...sharedProjectMethods(ctx),
      ...sharedLookupMethods(ctx),
      ...sharedBoardMethods(ctx),
      ...sharedComputeMethods(ctx),
      ...sharedAccessMethods(ctx),
      ...sharedLetterMethods(ctx, coordination),
      ...groupMethods(ctx),
      ...contactMethods(ctx),
      ...todoMethods(ctx),
      ...workdirMethods(ctx, () => methods),
      ...browserMethods(ctx),
      ...devicesMethods(ctx),
      ...windowsMethods(ctx),
      ...desktopMethods(ctx),
      ...pullRequestMethods(ctx),
      ...worktreeMethods(ctx),
      // The one owner connection is this client: the event comes back to it, as the core's reaches each owner.
      'ui.reveal': async (params) => {
        const { target } = params;
        if (target.kind === 'agent' && (target.agentId.length === 0 || target.agentId.length > 200)) {
          throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'ui.reveal target must be { kind: "thread", threadId, coreId? }, { kind: "agent", agentId, coreId? } or { kind: "update" }' });
        }
        if (target.kind !== 'update' && target.coreId !== undefined) {
          // This core's own id is this core; another machine must be one it knows, as the real core checks.
          if (target.coreId === ctx.identity.coreId) {
            const { coreId: _self, ...local } = target;
            ctx.emit('ui.reveal', { target: local });
            return { delivered: 1 };
          }
          if (!trusts(ctx, target.coreId)) {
            throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `ui.reveal target.coreId ${target.coreId} is not this core's id, a machine of its group or a machine trusted for coordination` });
          }
        }
        ctx.emit('ui.reveal', { target });
        return { delivered: 1 };
      },
    };
    return methods;
  }
}
