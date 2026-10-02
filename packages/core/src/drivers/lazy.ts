import type { AccountId, ModelInfo, Protocol, ProviderId, ThreadId } from '@boite/contracts';
import type { Driver, ProbeContext, ProbeFilter, TurnHandle, TurnResult } from './types.ts';

interface PendingLoad {
  threadId?: ThreadId;
  probe?: ProbeContext;
  cancel(): void;
}

/** Keep a protocol's implementation cold until a turn, preparation or query needs it. */
export function lazyDriver(
  protocol: Protocol,
  load: () => Promise<Driver>,
  options: { titles?: boolean; prepare?: boolean; sideQuestion?: boolean } = {},
): Driver {
  let loaded: Driver | null = null;
  let loading: Promise<Driver> | null = null;
  let shutdownPending = false;
  const viewed = new Set<ThreadId>();
  const pending = new Set<PendingLoad>();
  const cancelled = (): never => { throw new DOMException('Driver request cancelled before loading', 'AbortError'); };

  function ready(): Promise<Driver> {
    if (loaded !== null) return Promise.resolve(loaded);
    // One instance owns all warm sessions, including concurrent first requests.
    loading ??= Promise.resolve().then(load).then(driver => {
      if (shutdownPending) {
        shutdownPending = false;
        driver.shutdown?.();
      }
      loaded = driver;
      for (const threadId of viewed) driver.setViewed?.(threadId, true);
      return driver;
    }).finally(() => { loading = null; });
    return loading;
  }

  function defer<T>(
    identity: Pick<PendingLoad, 'threadId' | 'probe'>,
    invoke: (driver: Driver) => T | Promise<T>,
    onCancel: () => T = cancelled,
    signal?: AbortSignal,
  ): { result: Promise<T>; cancel(): void } {
    if (signal?.aborted) return { result: Promise.reject(signal.reason), cancel: () => undefined };
    const cancellation = Promise.withResolvers<T>();
    let stopped = false;
    const entry: PendingLoad = {
      ...identity,
      cancel() {
        if (!pending.delete(entry)) return;
        stopped = true;
        try { cancellation.resolve(onCancel()); } catch (error) { cancellation.reject(error); }
      },
    };
    pending.add(entry);
    signal?.addEventListener('abort', entry.cancel, { once: true });
    if (signal?.aborted) entry.cancel();
    const operation = ready().then(driver => {
      pending.delete(entry);
      return stopped ? onCancel() : invoke(driver);
    });
    const result = Promise.race([operation, cancellation.promise]).finally(() => {
      pending.delete(entry);
      signal?.removeEventListener('abort', entry.cancel);
    });
    return { result, cancel: entry.cancel };
  }

  return {
    protocol,
    // Capability checks run before the first module import.
    ...(options.titles ? {
      title: ctx => defer({ threadId: ctx.thread.id }, driver => driver.title?.(ctx) ?? null, () => null).result,
    } : {}),
    ...(options.sideQuestion ? {
      sideQuestion: ctx => defer({ threadId: ctx.thread.id }, driver => {
        if (!driver.sideQuestion) throw new Error(`${protocol} has no side-question implementation`);
        return driver.sideQuestion(ctx);
      }, cancelled, ctx.signal).result,
    } : {}),
    ...(options.prepare ? {
      prepare: ctx => defer({ threadId: ctx.thread.id }, async driver => {
        if (viewed.has(ctx.thread.id)) await driver.prepare?.(ctx);
      }, () => undefined).result,
      setViewed(threadId: ThreadId, active: boolean) {
        if (active) viewed.add(threadId);
        else viewed.delete(threadId);
        loaded?.setViewed?.(threadId, active);
      },
    } : {}),
    startTurn(ctx): TurnHandle {
      if (loaded !== null) return loaded.startTurn(ctx);
      let inner: TurnHandle | null = null;
      let stopRequested = false;
      const stopped = (): TurnResult => ({ status: 'stopped', sessionId: ctx.sessionId, usage: null });
      const deferred = defer({ threadId: ctx.thread.id }, driver => {
        inner = driver.startTurn(ctx);
        if (stopRequested) inner.stop();
        return inner.done;
      }, stopped);
      return {
        done: deferred.result,
        get setPermissionMode() { return inner?.setPermissionMode?.bind(inner); },
        get steer() { return inner?.steer?.bind(inner); },
        get steerUser() { return inner?.steerUser?.bind(inner); },
        stop() {
          stopRequested = true;
          if (inner !== null) inner.stop();
          else deferred.cancel();
        },
      };
    },
    probe: ctx => defer({ probe: ctx }, driver => driver.probe?.(ctx) ?? { models: ctx.provider.models, probedAt: Date.now() }).result,
    probedModels(providerId: ProviderId, accountId: AccountId): ModelInfo[] | null {
      return loaded?.probedModels?.(providerId, accountId) ?? null;
    },
    forgetProbes(filter: ProbeFilter = {}) {
      for (const entry of pending) {
        if (entry.probe && (filter.providerId === undefined || filter.providerId === entry.probe.provider.id)
          && (filter.accountId === undefined || filter.accountId === entry.probe.accountId)) entry.cancel();
      }
      loaded?.forgetProbes?.(filter);
    },
    releaseThread(threadId) {
      if (viewed.delete(threadId)) loaded?.setViewed?.(threadId, false);
      for (const entry of pending) if (entry.threadId === threadId) entry.cancel();
      loaded?.releaseThread?.(threadId);
    },
    shutdown() {
      viewed.clear();
      for (const entry of pending) entry.cancel();
      if (loading !== null) shutdownPending = true;
      loaded?.shutdown?.();
    },
  };
}
