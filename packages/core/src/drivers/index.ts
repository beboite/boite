import type {
  Account,
  AccountId,
  ModelInfo,
  Protocol,
  ProviderId,
  ProviderSummary,
  ThreadId,
} from '@boite/contracts';
import { unavailable } from '../errors.ts';
import { createAcpDriver } from './acp.ts';
import { createClaudeDriver } from './claude.ts';
import { echoDriver } from './echo.ts';
import type { Driver, ProbeContext, ProbeFilter, ProbeResult, TurnContext, TurnHandle } from './types.ts';

/**
 * A driver whose module is imported on its first turn. The Claude and ACP
 * drivers load their SDK that way; the Codex one carries its own transport, so
 * the whole module is what stays out of core start.
 */
function lazyDriver(protocol: Protocol, load: () => Promise<Driver>): Driver {
  let loaded: Driver | null = null;
  const ready = async (): Promise<Driver> => {
    if (loaded === null) loaded = await load();
    return loaded;
  };
  return {
    protocol,
    startTurn(ctx: TurnContext): TurnHandle {
      let inner: TurnHandle | null = null;
      let stopped = false;
      const done = ready().then((driver) => {
        inner = driver.startTurn(ctx);
        if (stopped) inner.stop();
        return inner.done;
      });
      return {
        done,
        stop: (): void => {
          stopped = true;
          inner?.stop();
        },
      };
    },
    releaseThread(threadId: ThreadId): void {
      loaded?.releaseThread?.(threadId);
    },
    shutdown(): void {
      loaded?.shutdown?.();
    },
  };
}

const DRIVERS = new Map<Protocol, Driver>([
  ['echo', echoDriver],
  [
    'claude-sdk',
    createClaudeDriver({
      loadQuery: () => import('@anthropic-ai/claude-agent-sdk').then((module) => module.query),
    }),
  ],
  [
    'acp',
    createAcpDriver({
      loadSdk: () => import('@agentclientprotocol/sdk'),
    }),
  ],
  [
    'codex-appserver',
    lazyDriver('codex-appserver', () => import('./codex.ts').then((module) => module.createCodexDriver())),
  ],
]);

const RUNNABLE = new Set<Protocol>(['echo', 'claude-sdk', 'acp', 'codex-appserver']);

export function getDriver(protocol: Protocol): Driver {
  const driver = DRIVERS.get(protocol);
  if (driver === undefined) throw unavailable(`no driver for protocol ${protocol}`, { protocol });
  return driver;
}

/** Called before a turn is queued so the refusal reaches the caller, not only the journal. */
export function assertDriverRunnable(
  protocol: Protocol,
  provider: ProviderSummary | undefined,
  account: Account,
): void {
  if (!RUNNABLE.has(protocol)) throw unavailable(`no driver for protocol ${protocol}`, { protocol });
  if (provider === undefined || !provider.available) {
    throw unavailable(`the provider ${account.providerId} is not available on this machine`, {
      providerId: account.providerId,
      executable: provider?.executable ?? null,
    });
  }
  if (account.status === 'unauthenticated') {
    throw unavailable(`the account ${account.label} is not logged in`, {
      accountId: account.id,
      providerId: account.providerId,
    });
  }
}

/**
 * Ask the driver of this protocol what the agent can run. A protocol whose
 * driver has no probe answers with the descriptor's own models, which is what
 * every non-ACP provider does.
 */
export function probeModels(protocol: Protocol, ctx: ProbeContext): Promise<ProbeResult> {
  const driver = DRIVERS.get(protocol);
  if (driver?.probe === undefined) {
    return Promise.resolve({ models: ctx.provider.models, probedAt: Date.now() });
  }
  return driver.probe(ctx);
}

/** The models a probe already read for this account, or null if none ever ran. */
export function probedModelsOf(
  protocol: Protocol,
  providerId: ProviderId,
  accountId: AccountId,
): ModelInfo[] | null {
  return DRIVERS.get(protocol)?.probedModels?.(providerId, accountId) ?? null;
}

/** A reload, a changed account or a removed one: what a probe cached is stale. */
export function forgetProbes(filter: ProbeFilter = {}): void {
  for (const driver of DRIVERS.values()) driver.forgetProbes?.(filter);
}

/** A thread that is archived or gone keeps no warm process: every driver drops it. */
export function releaseThread(threadId: ThreadId): void {
  for (const driver of DRIVERS.values()) driver.releaseThread?.(threadId);
}

/** Core shutdown: what a driver kept between turns goes before the journal closes. */
export function shutdownDrivers(): void {
  for (const driver of DRIVERS.values()) driver.shutdown?.();
}

/** Test seam: run a turn against a scripted driver instead of the registered one. */
export function setDriver(protocol: Protocol, driver: Driver): () => void {
  const previous = DRIVERS.get(protocol);
  DRIVERS.set(protocol, driver);
  return (): void => {
    if (previous === undefined) DRIVERS.delete(protocol);
    else DRIVERS.set(protocol, previous);
  };
}

export type {
  Driver,
  TurnContext,
  TurnHandle,
  TurnResult,
  EmitSink,
  PermissionTicket,
  ProbeContext,
  ProbeFilter,
  ProbeResult,
} from './types.ts';
