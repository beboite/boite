import type { Account, AccountQuota } from '@boite/contracts';
import type { Client } from './client';

/**
 * Subscription limits as every view shows them: the last reading stays on
 * screen, from this browser's storage after a restart, while the next one
 * loads, and only rows worth reading make it through.
 */

const STORAGE = 'boite.quotas';

function stored(key: string): AccountQuota[] | null {
  try {
    const rows = (JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Record<string, unknown>)[key];
    return Array.isArray(rows) ? (rows as AccountQuota[]) : null;
  } catch {
    return null;
  }
}

function remember(key: string, rows: AccountQuota[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(STORAGE, JSON.stringify({ ...all, [key]: rows }));
  } catch {
    // A private window or a full storage only costs the next start its first frame.
  }
}

/**
 * A row a limits view shows: the provider reports on it, the user reads it,
 * and its account is signed in. A signed-out account or a provider nobody
 * connected has nothing to say, and the Antigravity CLI source shows once
 * someone turned it on.
 */
export function shownQuotas(rows: AccountQuota[], accounts?: Account[]): AccountQuota[] {
  return rows.filter((row) => {
    if (row.status === 'unsupported' || row.status === 'disabled' || !row.enabled) return false;
    return accounts?.find((account) => account.id === row.accountId)?.status !== 'unauthenticated';
  });
}

export type QuotaGroup = { providerId: string; providerName: string; rows: AccountQuota[] };

/** One group per provider, in the order the core lists them. */
export function quotaGroups(rows: AccountQuota[]): QuotaGroup[] {
  const groups: QuotaGroup[] = [];
  for (const row of rows) {
    const group = groups.find((entry) => entry.providerId === row.providerId);
    if (group) group.rows.push(row);
    else groups.push({ providerId: row.providerId, providerName: row.providerName, rows: [row] });
  }
  return groups;
}

export class QuotaReader {
  /** The last rows read, null until the first reading ever. */
  rows = $state.raw<AccountQuota[] | null>(null);
  loading = $state(false);
  readonly #key: string;
  #latest = 0;

  constructor(key: string) {
    this.#key = key;
    this.rows = stored(key);
  }

  accept(rows: AccountQuota[]): void {
    this.rows = rows;
    remember(this.#key, rows);
  }

  /** Only the newest read writes, so a slow first read never lands over a refresh asked meanwhile. */
  async read(client: Client, refresh = false): Promise<void> {
    const request = ++this.#latest;
    this.loading = true;
    try {
      const rows = await client.call('quotas.list', { refresh });
      if (request === this.#latest) this.accept(rows);
    } catch (error) {
      if (request === this.#latest) {
        this.rows ??= [];
        throw error;
      }
    } finally {
      if (request === this.#latest) this.loading = false;
    }
  }

  async configure(client: Client, accountId: string, enabled: boolean): Promise<void> {
    this.accept(await client.call('quotas.configure', { accountId, enabled }));
    if (enabled) await this.read(client);
  }
}

const readers = new Map<string, QuotaReader>();

/** One reader per core, so a page opened again starts from what the last one saw. */
export function quotaReader(key: string): QuotaReader {
  let reader = readers.get(key);
  if (!reader) {
    reader = new QuotaReader(key);
    readers.set(key, reader);
  }
  return reader;
}
