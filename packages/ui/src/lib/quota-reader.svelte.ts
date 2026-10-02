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
  return namedQuotas(rows, accounts).filter((row) => {
    if (row.status === 'unsupported' || row.status === 'disabled' || !row.enabled) return false;
    return accounts?.find((account) => account.id === row.accountId)?.status !== 'unauthenticated';
  });
}

/** Account labels are current metadata, independent of the cached usage reading. */
export function namedQuotas(rows: AccountQuota[], accounts?: Account[]): AccountQuota[] {
  return rows.map((row) => {
    const account = accounts?.find((entry) => entry.id === row.accountId);
    return account && typeof account.label === 'string' && account.label !== row.label ? { ...row, label: account.label } : row;
  });
}

/** Older default CLI accounts predate provider-named account labels. */
export function quotaAccountName(row: AccountQuota): string {
  return row.label === 'Default' || !row.label.trim() ? row.providerName : row.label;
}

export class QuotaReader {
  /** The last rows read, null until the first reading ever. */
  rows = $state.raw<AccountQuota[] | null>(null);
  loading = $state(false);
  completed = $state.raw<string[]>([]);
  /** Why the newest read failed, null once one lands. */
  error = $state<string | null>(null);
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

  /** A mutation's fresh account wins over any list that began before it. */
  acceptReset(quota: AccountQuota): void {
    ++this.#latest;
    this.loading = false;
    const rows = this.rows ?? [];
    this.accept(rows.some(row => row.accountId === quota.accountId)
      ? rows.map(row => row.accountId === quota.accountId ? quota : row)
      : [...rows, quota]);
  }

  /** Only the newest read writes, so a slow first read never lands over a refresh asked meanwhile. */
  async read(client: Client, refresh = false): Promise<void> {
    const request = ++this.#latest;
    // getRandomValues also works on a plain HTTP connection to a LAN core.
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    this.completed = [];
    this.loading = true;
    const off = client.on('quotas.progress', (event) => {
      if (request !== this.#latest || event.requestId !== requestId) return;
      const rows = this.rows ?? [];
      const quota = event.quota;
      this.accept(rows.some((row) => row.accountId === quota.accountId)
        ? rows.map((row) => row.accountId === quota.accountId ? quota : row)
        : [...rows, quota]);
      this.completed = [...this.completed, quota.accountId];
    });
    try {
      const rows = await client.call('quotas.list', { refresh, requestId });
      if (request === this.#latest) {
        this.accept(rows);
        this.error = null;
      }
    } catch (error) {
      if (request === this.#latest) {
        this.rows ??= [];
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    } finally {
      off();
      if (request === this.#latest) this.loading = false;
    }
  }

  /** Saves the switch, then reads either way: its failure stays on `error`, not on the switch. */
  async configure(client: Client, accountId: string, enabled: boolean): Promise<void> {
    ++this.#latest;
    this.loading = false;
    this.accept(await client.call('quotas.configure', { accountId, enabled }));
    await this.read(client).catch(() => {});
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
