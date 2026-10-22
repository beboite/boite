/**
 * The last list each account's agent answered, kept in the journal so it
 * outlives a restart. Reading it again starts the agent: Antigravity unpacks
 * itself first, 12.3 s on a desktop (2026-10-22) and 45 to 54 s on a laptop,
 * and OpenCode 2 took 3 to 5 s on the server. A picker that has no list yet is
 * answered from here while a fresh read runs behind it.
 */
import { createHash } from 'node:crypto';
import type { AccountId, ModelInfo, ProviderId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { activeSubscriptionProxy } from '../subscription-proxy.ts';

const PREFIX = 'model-catalog:';

export interface SavedCatalog {
  models: ModelInfo[];
  probedAt: number;
}

interface Stored extends SavedCatalog {
  /** What the list was read under, see `contextOf`. */
  context: string;
}

const keyOf = (providerId: ProviderId, accountId: AccountId): string => `${PREFIX}${JSON.stringify([providerId, accountId])}`;

/**
 * What an agent's list depends on: its descriptor, the program that answers,
 * the gateway it goes through and the login. Hashed, since the gateway
 * settings name an address. Null when the provider or the account is gone.
 */
function contextOf(core: Core, providerId: ProviderId, accountId: AccountId): string | null {
  const provider = core.providers.get(providerId);
  const account = core.journal.getAccount(accountId);
  if (provider === undefined || account === null || account.providerId !== providerId) return null;
  const executable = core.providers.list().loaded.find(summary => summary.id === providerId)?.executable ?? null;
  const login = { status: account.status, identity: account.identity, isolationDir: account.isolationDir };
  return createHash('sha256')
    .update(JSON.stringify([provider, executable, activeSubscriptionProxy(core, provider), login]))
    .digest('base64url');
}

/** The saved list when it was read under what stands now, else null. */
export function readSavedCatalog(core: Core, providerId: ProviderId, accountId: AccountId): SavedCatalog | null {
  const stored = core.journal.getSetting(keyOf(providerId, accountId)) as Stored | undefined;
  if (stored === undefined || !Array.isArray(stored.models) || typeof stored.probedAt !== 'number') return null;
  if (stored.context !== contextOf(core, providerId, accountId)) return null;
  return { models: stored.models, probedAt: stored.probedAt };
}

export function saveCatalog(core: Core, providerId: ProviderId, accountId: AccountId, catalog: SavedCatalog): void {
  const context = contextOf(core, providerId, accountId);
  if (context === null) return;
  const stored = core.journal.getSetting(keyOf(providerId, accountId)) as Stored | undefined;
  // One account can be probed for each model it lands on: an unchanged list writes nothing.
  if (stored?.context === context && JSON.stringify(stored.models) === JSON.stringify(catalog.models)) return;
  core.journal.setSetting(keyOf(providerId, accountId), { context, models: catalog.models, probedAt: catalog.probedAt } satisfies Stored);
}

export function forgetSavedCatalog(core: Core, accountId: AccountId): void {
  core.journal.db.query('DELETE FROM settings WHERE key GLOB ?').run(`${PREFIX}*${JSON.stringify(accountId)}]`);
}
