import { secureId } from './secure-id';
import { errorText } from './errors';
import { RpcErrorCode, providerEnabled, type Account, type AccountQuota, type CoreInfo, type QuotaAlertPeriod, type ProviderSummary, type SubscriptionProxyQuotas } from '@boite/contracts';
import { RpcFailure, type Client } from './client';
import { fill, strings } from './strings';

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
 * connected has nothing to say.
 */
export function shownQuotas(rows: AccountQuota[], accounts?: Account[], providers?: readonly Pick<ProviderSummary, 'id' | 'enabled'>[]): AccountQuota[] {
  return namedQuotas(rows, accounts).filter((row) => {
    if (row.status === 'unsupported' || row.status === 'disabled' || !row.enabled) return false;
    if (quotaProviderOff(row, providers)) return false;
    return accounts?.find((account) => account.id === row.accountId)?.status !== 'unauthenticated';
  });
}

/** A provider turned off is not read any more: a row kept from before says nothing current. */
export function quotaProviderOff(row: AccountQuota, providers?: readonly Pick<ProviderSummary, 'id' | 'enabled'>[]): boolean {
  return providers?.some((provider) => provider.id === row.providerId && !providerEnabled(provider)) === true;
}

/** Account labels are current metadata, independent of the cached usage reading. */
export function namedQuotas(rows: AccountQuota[], accounts?: Account[]): AccountQuota[] {
  return rows.map((row) => {
    const account = accounts?.find((entry) => entry.id === row.accountId);
    return account && typeof account.label === 'string' && account.label !== row.label ? { ...row, label: account.label } : row;
  });
}

/**
 * Keep the associated profile's chosen name, including a profile named Default.
 * A gateway's average stands for its accounts: the provider and how many.
 */
export function quotaAccountName(row: AccountQuota): string {
  if (row.gateway?.display === 'average') {
    const count = row.gateway.accounts;
    return fill(count === 1 ? strings.subscriptionProxy.averageOne : strings.subscriptionProxy.average, { name: row.providerName, count: String(count) });
  }
  return row.label.trim() ? row.label : row.providerName;
}

/** What a window has left, clamped and to the tenth: the one rounding every quota view shows. */
export function remainingPercent(used: number): number {
  return Math.max(0, Math.min(100, Math.round((100 - used) * 10) / 10));
}

/** How a window reads from what it used: running low from 80 %, spent at 100 %. */
export function quotaTone(used: number): 'ok' | 'low' | 'out' {
  return used >= 100 ? 'out' : used >= 80 ? 'low' : 'ok';
}

/** A reported wallet, or an enabled budget after this subscription ran out. */
export function quotaCredits(row: AccountQuota) {
  const credits = row.credits;
  if (!row.enabled || row.status !== 'ready' || !credits || credits.remaining === null ||
    !Number.isFinite(credits.remaining) || credits.remaining <= 0) return null;
  if (credits.kind === 'balance') return credits.enabled === false ? null : credits;
  return row.windows.some((window) => quotaTone(window.usedPercent) === 'out') && credits.enabled === true &&
    credits.limit !== null && Number.isFinite(credits.limit) && credits.limit > 0 ? credits : null;
}

/**
 * How long a refresh asked by hand looks busy at least: one turn of the
 * refresh icon. A gateway can answer from its own cache in a few milliseconds
 * (an older Douane does), which would otherwise show no sign of a read.
 */
export const REFRESH_SHOWN_MS = 900;

export class QuotaReader {
  /** The last rows read, null until the first reading ever. */
  rows = $state.raw<AccountQuota[] | null>(null);
  loading = $state(false);
  completed = $state.raw<string[]>([]);
  /** Why the newest read failed, null once one lands. */
  error = $state<string | null>(null);
  /** The core refused a paired device the read: it predates devices reading limits. */
  outdated = $state(false);
  /** A refresh asked by hand, still inside its shown minimum. */
  #held = $state(false);
  #hold: ReturnType<typeof setTimeout> | undefined;
  readonly #key: string;
  #latest = 0;

  /** What a view shows as reading: `loading`, or a refresh still inside its minimum. */
  get busy(): boolean {
    return this.loading || this.#held;
  }

  /** The accounts a view shows as landed: none until a refresh's minimum is over. */
  get landed(): string[] {
    return this.#held ? [] : this.completed;
  }

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
    const requestId = secureId();
    this.completed = [];
    this.loading = true;
    if (refresh) {
      clearTimeout(this.#hold);
      this.#held = true;
      this.#hold = setTimeout(() => { this.#held = false; }, REFRESH_SHOWN_MS);
    }
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
        this.outdated = false;
      }
    } catch (error) {
      if (request === this.#latest) {
        this.rows ??= [];
        this.outdated = error instanceof RpcFailure && error.code === RpcErrorCode.Refused;
        this.error = this.outdated ? null : errorText(error);
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

  /** One period's alert thresholds, shares left; the core answers every row, as for a switch. */
  async alert(client: Client, accountId: string, period: QuotaAlertPeriod, thresholds: number[]): Promise<void> {
    ++this.#latest;
    this.loading = false;
    this.accept(await client.call('quotas.alert', { accountId, period, thresholds }));
  }
}

/**
 * Where the subscription gateway's own limits stand, as the core read them:
 * whether it serves them at all decides between native bars and its dashboard.
 * The bars themselves come with `quotas.list`.
 */
export class GatewayReader {
  /** Null until the core first answered. */
  state = $state.raw<SubscriptionProxyQuotas | null>(null);

  accept(state: SubscriptionProxyQuotas): void {
    this.state = state;
  }

  private pending: Promise<void> | null = null;

  /**
   * An older core, which does not know the method or refuses it to a paired
   * device, leaves the gateway its dashboard.
   * A transport failure says nothing about the gateway: the state stays as it was,
   * so the next `known()` asks again.
   */
  read(client: Client, refresh = false): Promise<void> {
    if (this.pending && !refresh) return this.pending;
    const running = (async () => {
      try { this.accept(await client.call('subscriptionProxy.quotas', { refresh })); }
      catch (error) {
        if (error instanceof RpcFailure && (error.code === RpcErrorCode.MethodNotFound || error.code === RpcErrorCode.Refused))
          this.accept({ status: 'unsupported', providers: [], updatedAt: null, checkedAt: null, error: null });
      }
    })();
    this.pending = running;
    void running.finally(() => { if (this.pending === running) this.pending = null; });
    return running;
  }

  /** Settles once the state is known: the read in flight, or a first one. */
  known(client: Client): Promise<void> {
    return this.pending ?? (this.state ? Promise.resolve() : this.read(client));
  }
}

const gateways = new Map<string, GatewayReader>();

export function gatewayReader(key: string): GatewayReader {
  let reader = gateways.get(key);
  if (!reader) {
    reader = new GatewayReader();
    gateways.set(key, reader);
  }
  return reader;
}

const readers = new Map<string, QuotaReader>();

/** One reader per core, so a page opened again starts from what the last one saw. */
export function quotaReader(endpointUrl: string, core?: Pick<CoreInfo, 'dataDir' | 'coreId'> | null): QuotaReader {
  // An address can belong to a different installation after reconnecting.
  // URL-only rows from older clients have no core identity, so leave them unread.
  const key = JSON.stringify([endpointUrl, core?.dataDir, core?.coreId]);
  let reader = readers.get(key);
  if (!reader) {
    reader = new QuotaReader(key);
    readers.set(key, reader);
  }
  return reader;
}
