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
import { echoDriver } from './echo.ts';
import { lazyDriver } from './lazy.ts';
import type { Driver, ProbeContext, ProbeFilter, ProbeResult } from './types.ts';

const DRIVERS = new Map<Protocol, Driver>([
  ['echo', echoDriver],
  [
    'claude-sdk',
    lazyDriver('claude-sdk', () => import('./claude.ts').then(module => module.createClaudeDriver({
      loadQuery: () => import('@anthropic-ai/claude-agent-sdk').then(sdk => sdk.query),
    })), { titles: true, prepare: true, sideQuestion: true }),
  ],
  [
    'acp',
    lazyDriver('acp', () => import('./acp.ts').then(module => module.createAcpDriver({
      loadSdk: () => import('@agentclientprotocol/sdk'),
    }))),
  ],
  [
    'codex-appserver',
    lazyDriver('codex-appserver', () => import('./codex.ts').then((module) => module.createCodexDriver()), { titles: true, prepare: true, forkSession: true }),
  ],
  ['muse', lazyDriver('muse', () => import('./muse.ts').then((module) => module.createMuseDriver()))],
  ['pi', lazyDriver('pi', () => import('./pi.ts').then((module) => module.createPiDriver()))],
  ['agy', lazyDriver('agy', () => import('./agy.ts').then((module) => module.createAgyDriver()))],
]);

const RUNNABLE = new Set<Protocol>(['echo', 'claude-sdk', 'acp', 'codex-appserver', 'muse', 'pi', 'agy']);

export function getDriver(protocol: Protocol): Driver {
  const driver = DRIVERS.get(protocol);
  if (driver === undefined) throw unavailable(`no driver for protocol ${protocol}`, { protocol });
  return driver;
}

/** Whether this protocol's agent writes thread titles (`Driver.title`). */
export function writesTitles(protocol: Protocol): boolean {
  return DRIVERS.get(protocol)?.title !== undefined;
}

/** Called before a turn is queued so the refusal reaches the caller, not only the journal. */
export function assertDriverRunnable(
  protocol: Protocol,
  provider: ProviderSummary | undefined,
  account: Account,
  /** The launcher script PATH holds instead of a program, asked only once the provider reads as missing. */
  launcherScript: () => string | null = () => null,
): void {
  if (!RUNNABLE.has(protocol)) throw unavailable(`no driver for protocol ${protocol}`, { protocol });
  if (provider === undefined || !provider.available) {
    const script = provider === undefined ? null : launcherScript();
    throw unavailable(
      script === null
        ? `the provider ${account.providerId} is not available on this machine`
        : `the provider ${account.providerId} is not available on this machine: PATH has only the launcher script ${script}, which Boite cannot start. Install the agent's own program, or let Boite install it`,
      {
        providerId: account.providerId,
        executable: provider?.executable ?? null,
        ...(script === null ? {} : { launcherScript: script }),
      },
    );
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
 * echo does.
 */
export function probeModels(protocol: Protocol, ctx: ProbeContext): Promise<ProbeResult> {
  const driver = DRIVERS.get(protocol);
  if (driver?.probe === undefined) {
    return Promise.resolve({ models: ctx.provider.models, probedAt: Date.now() });
  }
  return driver.probe(ctx);
}

/** The models a probe already read for this account, or null if none ever ran. */
const externalModels = new Map<string, { providerId: ProviderId; accountId: AccountId; models: ModelInfo[] }>();

export function rememberExternalModels(protocol: Protocol, providerId: ProviderId, accountId: AccountId, models: ModelInfo[]): void {
  externalModels.set(JSON.stringify([protocol, providerId, accountId]), { providerId, accountId, models });
}

export function probedModelsOf(
  protocol: Protocol,
  providerId: ProviderId,
  accountId: AccountId,
): ModelInfo[] | null {
  return externalModels.get(JSON.stringify([protocol, providerId, accountId]))?.models ?? DRIVERS.get(protocol)?.probedModels?.(providerId, accountId) ?? null;
}

/** A reload, a changed account or a removed one: what a probe cached is stale. */
export function forgetProbes(filter: ProbeFilter = {}): void {
  for (const [key, entry] of externalModels) {
    if ((!filter.providerId || entry.providerId === filter.providerId) && (!filter.accountId || entry.accountId === filter.accountId)) externalModels.delete(key);
  }
  for (const driver of DRIVERS.values()) driver.forgetProbes?.(filter);
}

/** A thread that is archived or gone keeps no warm process: every driver drops it. */
export function releaseThread(threadId: ThreadId): void {
  for (const driver of DRIVERS.values()) driver.releaseThread?.(threadId);
}

/** Viewing pins only existing sessions; it never loads an unsupported driver. */
export function setThreadViewed(threadId: ThreadId, viewed: boolean): void {
  for (const driver of DRIVERS.values()) driver.setViewed?.(threadId, viewed);
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
