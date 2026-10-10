import type { AccountQuota, GatewayQuotaCredit, GatewayQuotaEntry, GatewayQuotaProvider, QuotaWindow, SubscriptionProxy, SubscriptionProxyQuotas } from '@boite/contracts';
import type { Core } from './core.ts';
import { proxyApiUrl, proxyKey } from './subscription-proxy.ts';

/** The native quota cadence: a list within a minute of the last read reuses it. */
const FRESH_MS = 60_000;
const MAX_BYTES = 1 << 20;
const MAX_PROVIDERS = 32;
const MAX_ENTRIES = 1024;
const MAX_LINES = 16;

const OFF: SubscriptionProxyQuotas = { status: 'off', providers: [], updatedAt: null, checkedAt: null, error: null };

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const percent = (value: unknown): number | null => { const n = number(value); return n === null ? null : Math.max(0, Math.min(100, n)); };
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}
function time(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function windowOf(raw: unknown): QuotaWindow | null {
  const row = object(raw);
  const id = row && text(row['id'], 80);
  if (!row || !id) return null;
  const remaining = percent(row['remaining_percent']);
  const used = percent(row['used_percent']) ?? (remaining === null ? null : 100 - remaining);
  if (used === null) return null;
  const window: QuotaWindow = { id, label: text(row['label'], 80) ?? id, usedPercent: used, resetsAt: time(row['reset_at']) };
  if (row['primary'] === true) window.primary = true;
  return window;
}

function creditOf(raw: unknown): GatewayQuotaCredit | null {
  const row = object(raw);
  const id = row && text(row['id'], 80);
  if (!row || !id) return null;
  return { id, label: text(row['label'], 80) ?? id, unit: text(row['unit'], 24),
    remaining: number(row['remaining']), limit: number(row['limit']), used: number(row['used']) };
}

function lines<T>(raw: unknown, read: (value: unknown) => T | null): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(raw) ? raw.slice(0, MAX_LINES * 4) : []) {
    const line = read(value) as (T & { id: string }) | null;
    if (!line || seen.has(line.id) || out.length >= MAX_LINES) continue;
    seen.add(line.id);
    out.push(line);
  }
  return out;
}

const STATUSES: GatewayQuotaEntry['status'][] = ['ready', 'cooldown', 'error', 'disabled'];

function entryOf(raw: unknown): GatewayQuotaEntry | null {
  const row = object(raw);
  const id = row && text(row['id'], 160);
  const label = row && text(row['label'], 200);
  if (!row || !id || !label) return null;
  const accounts = number(row['accounts']);
  const status = STATUSES.find((value) => value === row['status']) ?? 'ready';
  return {
    id, label, plan: text(row['plan'], 120),
    accounts: accounts !== null && Number.isInteger(accounts) && accounts >= 1 ? Math.min(accounts, 100_000) : 1,
    status, error: text(row['error'], 300), updatedAt: time(row['updated_at']),
    windows: lines(row['windows'], windowOf), credits: lines(row['credits'], creditOf),
  };
}

/**
 * Douane's `GET /v1/quotas` body, checked field by field. Strings are bounded
 * and stripped of control characters; a row that does not follow the contract
 * is dropped instead of shown half-read. Throws when the body is not the contract.
 */
export function parseGatewayQuotas(raw: unknown, names: (providerId: string) => string | null = () => null): Pick<SubscriptionProxyQuotas, 'providers' | 'updatedAt'> {
  const root = object(raw);
  if (!root || !Array.isArray(root['providers'])) throw new Error('Douane quotas expected an object with a providers array.');
  const providers: GatewayQuotaProvider[] = [];
  let total = 0;
  for (const value of root['providers'].slice(0, MAX_PROVIDERS * 2)) {
    const row = object(value);
    const providerId = row && typeof row['provider'] === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(row['provider']) ? row['provider'] : null;
    if (!row || !providerId || providers.some((entry) => entry.providerId === providerId) || providers.length >= MAX_PROVIDERS) continue;
    const entries: GatewayQuotaEntry[] = [];
    for (const item of Array.isArray(row['entries']) ? row['entries'] : []) {
      if (total >= MAX_ENTRIES) break;
      const entry = entryOf(item);
      if (!entry || entries.some((known) => known.id === entry.id)) continue;
      entries.push(entry);
      total++;
    }
    providers.push({ providerId, name: text(row['name'], 80) ?? names(providerId) ?? providerId,
      display: row['display'] === 'average' ? 'average' : 'accounts', entries });
  }
  return { providers, updatedAt: time(root['updated_at']) };
}

/** The body, refused past `max` bytes whatever the headers claimed. */
async function boundedJson(response: Response, max: number): Promise<unknown> {
  const tooLarge = `Douane quotas response exceeded ${max} bytes.`;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { await response.body?.cancel().catch(() => {}); throw new Error(tooLarge); }
  if (!response.body) throw new Error('Douane quotas returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new Error(tooLarge); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Douane quotas returned invalid JSON.'); }
}

/** `null` means the route does not exist: an older Douane answers 404. */
export async function fetchGatewayQuotas(proxy: SubscriptionProxy, key: string, names?: (providerId: string) => string | null, max = MAX_BYTES): Promise<Pick<SubscriptionProxyQuotas, 'providers' | 'updatedAt'> | null> {
  let response: Response;
  try {
    response = await fetch(`${proxyApiUrl(proxy)}/quotas`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
  } catch { throw new Error('Douane quotas could not reach the configured API URL.'); }
  // Never the raw body: a gateway's error page can echo a credential.
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`Douane quotas returned HTTP ${response.status}.`); }
  return parseGatewayQuotas(await boundedJson(response, max), names);
}

/**
 * The gateway's quotas as the core last read them. Every client, a phone or
 * another machine, gets them from here: the gateway is reached from the core
 * only, with the key that never leaves it.
 */
export class GatewayQuotas {
  private last: SubscriptionProxyQuotas = { ...OFF, status: 'unavailable' };
  private readAt = 0;
  private pending: Promise<SubscriptionProxyQuotas> | null = null;
  /** The proxy configuration `last` belongs to; another one starts over. */
  private config: string;
  private epoch = 0;

  /** `onReset` tells the quota store, whose `quotas.updated` still carries the dropped rows. */
  constructor(private core: Core, private max = MAX_BYTES, private onReset: () => void = () => {}) {
    this.config = JSON.stringify(core.settings.get().subscriptionProxy ?? null);
    core.bus.onAny((name) => { if (name === 'settings.updated') this.reconfigure(); });
  }

  private proxy(): SubscriptionProxy | null {
    const proxy = this.core.settings.get().subscriptionProxy;
    return proxy?.enabled ? proxy : null;
  }

  private reconfigure(): void {
    const config = JSON.stringify(this.core.settings.get().subscriptionProxy ?? null);
    if (config === this.config) return;
    this.config = config;
    this.reset();
  }

  /**
   * Forgets the answer and any read in flight: the proxy changed, or its key,
   * which lives outside settings. Clients drop the old rows at once.
   */
  reset(): void {
    this.epoch++;
    this.pending = null;
    this.readAt = 0;
    this.last = { ...OFF, status: 'unavailable' };
    this.core.bus.emit('subscriptionProxy.quotasUpdated', this.state());
    this.onReset();
  }

  /** What is known without asking the gateway. */
  state(): SubscriptionProxyQuotas {
    const proxy = this.proxy();
    if (!proxy) return OFF;
    if (proxy.kind !== 'douane') return { ...OFF, status: 'unsupported' };
    return this.last;
  }

  async read(refresh = false): Promise<SubscriptionProxyQuotas> {
    const proxy = this.proxy();
    if (!proxy || proxy.kind !== 'douane') return this.state();
    if (this.pending) return this.pending;
    if (!refresh && this.readAt && Date.now() - this.readAt < FRESH_MS) return this.last;
    const epoch = this.epoch;
    const running = (async () => {
      let next: SubscriptionProxyQuotas;
      try {
        const names = (id: string) => this.core.providers.get(id)?.name ?? null;
        const answer = await fetchGatewayQuotas(proxy, proxyKey(this.core), names, this.max);
        next = answer ? { status: 'ready', ...answer, checkedAt: Date.now(), error: null } : { ...OFF, status: 'unsupported' };
      } catch (error) {
        const good = this.last.checkedAt !== null ? this.last : null;
        next = { status: 'unavailable', providers: good?.providers ?? [], updatedAt: good?.updatedAt ?? null, checkedAt: good?.checkedAt ?? null,
          error: error instanceof Error ? error.message : 'Douane quotas request failed.' };
      }
      if (epoch !== this.epoch) return this.state();
      this.last = next;
      this.readAt = Date.now();
      this.core.bus.emit('subscriptionProxy.quotasUpdated', next);
      return next;
    })();
    this.pending = running;
    try { return await running; } finally { if (this.pending === running) this.pending = null; }
  }

  /** The entries as limit rows, beside every account's own. */
  rows(state = this.state()): AccountQuota[] {
    const stale = state.status === 'unavailable';
    return state.providers.flatMap((provider) => provider.entries.map((entry): AccountQuota => ({
      accountId: `proxy:${provider.providerId}:${entry.id}`,
      providerId: provider.providerId, providerName: provider.name, label: entry.label, enabled: true,
      status: stale || entry.status === 'error' ? 'unavailable' : 'ready',
      windows: entry.windows, checkedAt: entry.updatedAt ?? state.checkedAt,
      error: stale ? state.error : entry.error,
      gateway: { kind: 'douane', entryId: entry.id, display: provider.display, plan: entry.plan, accounts: entry.accounts, status: entry.status, credits: entry.credits },
    })));
  }
}
