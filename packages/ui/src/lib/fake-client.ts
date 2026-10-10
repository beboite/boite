import { sweepMergedPrFixtures, type MergedPrFixture } from './fake-client/merged-pr-archive';
import {
  RPC_CHUNK_BYTES,
  RpcErrorCode,
  type CoreInfo,
  type CoreLogContext,
  type HookRun,
  type MemoryEvent,
  type Principal,
  type RpcEventName,
  type RpcEvents,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
  type ThreadId,
} from '@boite/contracts';
import { RpcFailure, type CallOptions, type ClientState, type EventHandler, type ObservableClient } from './client';
import { accountMethods } from './fake-client/accounts';
import { activityMethods, pauseActivity } from './fake-client/activity';
import { brainMethods } from './fake-client/brain';
import { FakeContext, type FakeClientOptions, type FakeMethods } from './fake-client/context';
import { hookMethods, recordHookRun } from './fake-client/hooks';
import { logMethods } from './fake-client/logs';
import { coordinationMethods, registerCore, unregisterCore } from './fake-client/coordination';
import { seedStewardDemo, stewardMethods } from './fake-client/stewards';
import { delegationMethods, seedDelegationDemo } from './fake-client/delegation';
import { groupMethods } from './fake-client/group';
import { pairingMethods } from './fake-client/pairing';
import { projectMethods } from './fake-client/projects';
import { pathKey } from './fake-client/checks';
import { projectIconMethods } from './fake-client/project-icons';
import { providerCatalogMethods } from './fake-client/provider-catalog';
import { providerInstallMethods } from './fake-client/provider-installs';
import { RELEASES } from './fake-client/providers';
import { clearRequestsOf, requestMethods } from './fake-client/requests';
import { resourceMethods } from './fake-client/resources';
import { seed } from './fake-client/seed';
import { settingsMethods } from './fake-client/settings';
import { DEVICE_METHODS, toSummary } from './fake-client/shared';
import { speechMethods } from './fake-client/speech';
import { terminalMethods } from './fake-client/terminals';
import { capabilityMethods } from './fake-client/capabilities';
import { deleteExpiredDoneThreads, purgeDeletedThreads, threadMethods } from './fake-client/threads';
import { threadMoveMethods } from './fake-client/thread-move';
import { spawnMethods } from './fake-client/spawn';
import { todoMethods } from './fake-client/todos';
import { workdirMethods } from './fake-client/workdir';
import { browserMethods } from './fake-client/browser';
import { devicesMethods } from './fake-client/devices';
import { pullRequestMethods } from './fake-client/pull-requests';
import { worktreeMethods } from './fake-client/worktrees';
import { serverUpdateMethods } from './fake-client/server-update';
import { closeSideQuestions } from './fake-client/side-questions';
import { holdAfterRestart } from './fake-client/recovery';
import { journalInspectionMethods } from './fake-client/journal-inspection';
import { forkReturnMethods } from './fake-client/fork-return';

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
  #mergedPrSweep: Promise<number> | null = null;
  #doneSweep: Promise<void> | null = null;
  #transportGeneration = 0;

  constructor(options: FakeClientOptions = {}) {
    const ctx = new FakeContext(options);
    this.#ctx = ctx;
    this.#methods = this.#answer(ctx);
    registerCore(ctx);
    seed(ctx);
    if (options.delegationDemo) seedDelegationDemo(ctx);
    if (options.stewardDemo) seedStewardDemo(ctx);
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
  }

  // -------------------------------------------------------------------------
  // Client surface
  // -------------------------------------------------------------------------

  get state(): ClientState {
    return this.#ctx.bus.state;
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
   * Turns this client into a paired device, or back into the owner, in the
   * spirit of `drop` and `restore`: the boundary is the core's, so a test can
   * cross it without a second socket. `hello` and every later call answer as
   * the new principal from here on.
   */
  becomes(principal: Principal): void {
    this.#ctx.bus.principal = principal;
  }

  /** Test fixture: no provider turn is started. */
  holdAfterRestart(threadId: ThreadId, prompt: string) {
    return holdAfterRestart(this.#ctx, threadId, prompt);
  }

  /**
   * Takes a folder off the fake's disk, as a repository deleted outside the
   * app: the project there reads `missing` on its next answer, and a thread
   * in it or under it is refused a turn.
   */
  loseFolder(path: string): void {
    this.#ctx.goneFolders.add(pathKey(path));
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
    closeSideQuestions(ctx);
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
      throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'not connected' });
    }
    await this.#ctx.tick();
    if (generation !== this.#transportGeneration || (bus.state !== 'ready' && method !== 'hello')) {
      throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'connection changed before RPC dispatch' });
    }
    // The fixture has no thread-bound agent token; do not widen this scoped read.
    if (bus.principal === 'agent' && (method === 'threads.capabilities' || method === 'threads.mergeBack')) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${method} requires a thread-bound agent identity` });
    if (bus.principal === 'agent' && (method === 'core.logs' || method === 'projects.setAutoArchiveMergedPr' || method === 'quotas.reset')) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${method} is not one of the agent's methods` });
    // The router's gate, word for word: deny by default, `hello` before it.
    if (bus.principal === 'session' && method !== 'hello' && !DEVICE_METHODS.has(method)) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${method} is for the owner only` });
    }
    if (bus.principal === 'session' && method === 'agents.message.send' && (params as RpcParams<'agents.message.send'>).threadId !== undefined) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'agents.message.send: paired devices must omit threadId and speak as the user' });
    if (bus.principal === 'session' && method === 'git.diff' && ![undefined, '', 'HEAD'].includes((params as RpcParams<'git.diff'>).ref)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'git.diff: paired devices compare the working tree with HEAD only' });
    const result = await bus.hold(this.#dispatch(method, params)) as RpcResult<M>;
    if (options.onProgress) reportSlices(result, options.onProgress);
    // The real client writes its set from the answer, never from the request.
    if (method === 'threads.subscribe') {
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
   * thread's summary with a fresh `load` and the timestamp it already had,
   * pushed once a second for every thread with a live process. It is not a
   * `touch`: a load sample moves no row in the sidebar.
   */
  sampleLoad(threadId: ThreadId, processes = 1): void {
    const thread = this.#ctx.thread(threadId);
    thread.load = { processes, cpuPercent: 12, memoryBytes: 48 * 1024 * 1024 };
    this.#ctx.emit('thread.updated', structuredClone(toSummary(thread)));
  }

  /** A line of the core's own log, as `core.log` carries it: a failed scheduler, a guard at work. */
  emitCoreLog(level: RpcEvents['core.log']['level'], message: string, context: CoreLogContext = {}): void {
    this.#ctx.emit('core.log', { level, message, at: this.#ctx.now(), ...context });
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
    this.#ctx.speechRequests.clear();
    this.#ctx.bus.dropPending(message, dropped);
  }

  // Every method's input and output are checked against the real RPC contract,
  // and each domain module answers its own share of it.
  #answer(ctx: FakeContext): FakeMethods {
    const threads = threadMethods(ctx);
    const projects = projectMethods(ctx);
    const methods: FakeMethods = {
      'core.shutdown': async () => { ctx.agents.close(); await Promise.all([...ctx.threads.keys()].map(id => ctx.stopTurn(id))); setTimeout(() => this.close(), 25); return { ok: true }; },
      'hello': async (params) => {
        return { core: ctx.core, principal: ctx.bus.principal };
      },
      ...brainMethods(ctx),
      ...logMethods(ctx),
      ...serverUpdateMethods(ctx),
      ...hookMethods(ctx),
      ...pairingMethods(ctx),
      ...projects,
      ...projectIconMethods(ctx),
      ...threads,
      ...capabilityMethods(ctx),
      ...forkReturnMethods(ctx),
      ...journalInspectionMethods(ctx),
      ...threadMoveMethods(ctx),
      ...spawnMethods(ctx, threads['threads.create'], projects['projects.add']),
      ...activityMethods(ctx),
      ...requestMethods(ctx),
      ...providerCatalogMethods(ctx),
      ...providerInstallMethods(ctx),
      ...accountMethods(ctx),
      ...terminalMethods(ctx),
      ...resourceMethods(ctx),
      ...settingsMethods(ctx),
      ...speechMethods(ctx),
      ...delegationMethods(ctx),
      ...coordinationMethods(ctx),
      ...stewardMethods(ctx, () => methods),
      ...groupMethods(ctx),
      ...todoMethods(ctx),
      ...workdirMethods(ctx),
      ...browserMethods(ctx),
      ...devicesMethods(ctx),
      ...pullRequestMethods(ctx),
      ...worktreeMethods(ctx),
      // The one owner connection is this client: the event comes back to it, as the core's reaches each owner.
      'ui.reveal': async (params) => { ctx.emit('ui.reveal', { target: params.target }); return { delivered: 1 }; },
    };
    return methods;
  }
}
