import type { Account, Protocol, ProviderSummary, ThreadId } from '@boite/contracts';
import { unavailable } from '../errors.ts';
import { createAcpDriver } from './acp.ts';
import { createClaudeDriver } from './claude.ts';
import { echoDriver } from './echo.ts';
import type { Driver } from './types.ts';

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
]);

const RUNNABLE = new Set<Protocol>(['echo', 'claude-sdk', 'acp']);

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

export type { Driver, TurnContext, TurnHandle, TurnResult, EmitSink, PermissionTicket } from './types.ts';
