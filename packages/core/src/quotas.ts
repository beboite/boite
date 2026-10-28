import { isOpenCode, OPENCODE_V2 } from './providers/opencode.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Account, AccountQuota, QuotaAlertPeriod, QuotaReading, QuotaWindow } from '@boite/contracts';
import type { Core } from './core.ts';
import { homePath } from './paths.ts';
import { invalidParams } from './errors.ts';
import { claudeQuotaDetails, claudeUsageAgent, codexQuotaDetails, codexQuotaWindows, quotaWindow } from './quota-details.ts';
import { consumeClaudeReset, QuotaResetStore, type QuotaResetConsumer } from './quota-resets.ts';
import { readExtraQuota, readsAntigravitySignIn } from './quota-readers.ts';
import type { ProbeContext } from './drivers/types.ts';
import { activeSubscriptionProxy } from './subscription-proxy.ts';
import { GatewayQuotas } from './subscription-proxy-quotas.ts';
import { QuotaAlertStore } from './quota-alerts.ts';

export { claudeUsageAgent, codexQuotaWindows } from './quota-details.ts';

const CACHE_MS = 60_000;
const RETRY_MS = 300_000;
/** A session's readings stand in for reads only this long after a full read, which alone reports banked resets. */
const OBSERVED_MS = 300_000;
/** A disabled spending budget alone does not report subscription usage. */
function hasQuota(reading: QuotaReading): boolean {
  return reading.windows.length > 0 || reading.resetCredits !== undefined ||
    reading.credits?.kind === 'balance' || reading.credits?.enabled === true;
}
/** An identity not read yet names nobody else: only two known, different identities are two logins. */
const sameLogin = (a: string | null, b: string | null) => a === null || b === null || a === b;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : {};
}

export function claudeQuotaWindows(raw: unknown): QuotaWindow[] {
  const root = object(raw);
  const limits = object(root['rate_limits'] ?? root);
  const windows: QuotaWindow[] = [];
  for (const [id, value] of Object.entries(limits)) {
    if (!id.startsWith('five_hour') && !id.startsWith('seven_day')) continue;
    const entry = object(value);
    const label = id === 'five_hour' ? '5 hours' : id === 'seven_day' ? 'Weekly' : id.replaceAll('_', ' ');
    const mapped = quotaWindow(id, label, entry['utilization'], entry['resets_at']);
    if (mapped) windows.push(mapped);
  }
  for (const value of Array.isArray(limits['model_scoped']) ? limits['model_scoped'] : []) {
    const entry = object(value);
    if (typeof entry['display_name'] !== 'string') continue;
    const mapped = quotaWindow(`model:${entry['display_name']}`, `Weekly · ${entry['display_name']}`, entry['utilization'], entry['resets_at']);
    if (mapped) windows.push(mapped);
  }
  return windows;
}

/**
 * One HTTP request when the login is a file Boite can read. Otherwise the CLI
 * answers for itself: on macOS Claude keeps its login in the Keychain, and an
 * expired token is one only the CLI can refresh.
 */
async function readClaude(core: Core, account: Account): Promise<QuotaReading> {
  const provider = core.providers.require(account.providerId);
  const env = core.accounts.accountEnv(account, provider);
  const directory = env['CLAUDE_CONFIG_DIR'] ?? process.env['CLAUDE_CONFIG_DIR'] ?? join(homePath(), '.claude');
  let credentials: ObjectValue;
  try { credentials = object(JSON.parse(await readFile(join(directory, '.credentials.json'), 'utf8'))); }
  catch { return readClaudeFromCli(core, account); }
  const token = object(credentials['claudeAiOauth'])['accessToken'];
  if (typeof token !== 'string' || !token) throw new Error('This Claude account has no subscription login. Connect it in Providers.');
  const reading = await readClaudeWithToken(token, core.updates.current(account.providerId));
  return reading ?? readClaudeFromCli(core, account);
}

/** The token stays here and is sent only to Anthropic. Null when expired or no quota data was returned. */
async function readClaudeWithToken(token: string, version: string | null): Promise<QuotaReading | null> {
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/api/oauth/usage?cedar_ember=1', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', ...claudeUsageAgent(version) },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
  } catch { throw new Error('Claude quota request failed. Check the connection and retry.'); }
  if (response.status === 401) return null;
  if (response.status === 429) throw new Error('Claude quota requests are rate limited. Retrying in five minutes.');
  if (!response.ok) throw new Error(`Claude quota request returned HTTP ${response.status}.`);
  try {
    const raw: unknown = await response.json();
    const reading = { windows: claudeQuotaWindows(raw), ...claudeQuotaDetails(raw) };
    return hasQuota(reading) ? reading : null;
  }
  catch { throw new Error('Claude returned an invalid quota response.'); }
}

async function readClaudeFromCli(core: Core, account: Account): Promise<QuotaReading> {
  const { readClaudeQuota } = await import('./drivers/claude.ts');
  const raw = await withQuotaProbe(core, account, 'claude', (ctx) => readClaudeQuota(ctx));
  return { windows: claudeQuotaWindows(raw), ...claudeQuotaDetails(raw) };
}

async function readCodex(core: Core, account: Account): Promise<QuotaReading> {
  const { readCodexQuota } = await import('./drivers/codex.ts');
  const raw = await withQuotaProbe(core, account, 'codex', readCodexQuota);
  return { windows: codexQuotaWindows(raw), ...codexQuotaDetails(raw) };
}

/** A CLI started for one quota read or reset, in a scratch directory, traced and stopped whatever happens. Exported for tests. */
export async function withQuotaProbe<T>(core: Core, account: Account, name: string, read: (ctx: ProbeContext) => Promise<T>, reset = false): Promise<T> {
  const provider = core.providers.require(account.providerId);
  const label = `${name}${reset ? '' : ' quota'}`;
  const log = (message: string): void => core.log('warn', `${label}: ${message}`, { source: 'quotas', event: 'quota.read' });
  // The account owns the read: removing it stops this process and waits for it before deleting the directory.
  const operation = core.accounts.operations.open(account.id, provider.id, `${reset ? 'quota-reset' : 'quota'}:${account.id}`, log);
  const at = performance.now();
  try {
    return await read({
      provider, accountId: account.id, cwd: operation.scratch('boite-quota-'),
      accountEnv: core.accounts.accountEnv(account, provider),
      spawnChild: operation.spawnChild,
      killTree: operation.killTree,
      log: (level, message) => core.log(level, `${label}: ${message}`, { source: 'quotas', event: 'quota.read' }),
    });
  } catch (error) {
    core.logs.warn(`${reset ? `The ${name}` : `Reading the ${name} quota`} of account ${account.id} failed after ${Math.round(performance.now() - at)} ms: ${error instanceof Error ? error.message : String(error)}`, {
      source: 'quotas', event: 'quota.read-failed', durationMs: performance.now() - at, data: { accountId: account.id, providerId: account.providerId, reset },
    });
    throw error;
  } finally {
    // A descendant can hold the directory after the direct child closed. Neither
    // waiting for it nor removing the directory may replace the windows just read.
    await operation.close();
  }
}

export type QuotaReader = (account: Account) => Promise<QuotaWindow[] | QuotaReading>;

export class QuotaStore {
  readonly resets: QuotaResetStore;
  /** The subscription gateway's own accounts, listed after this machine's. */
  readonly gateway: GatewayQuotas;
  /** What notifies when a window crosses its threshold, and the poll that reads for it. */
  readonly alerts: QuotaAlertStore;
  /**
   * Backoff and freshness: when the next read may go out. Cleared by every invalidation.
   * `readAt` is the time of the full read a session's readings were merged into.
   */
  private cache = new Map<string, { value: AccountQuota; retryAt: number; readAt?: number }>();
  /**
   * The last successful reading of each account, kept through invalidations so
   * a failed read shows it as stale instead of nothing. Forgotten only when it
   * stops belonging to the account: removed, disabled or signed in as someone else.
   */
  private lastGood = new Map<string, { value: AccountQuota; identity: string | null }>();
  private pending = new Map<string, Promise<AccountQuota>>();
  /** Bumped by an invalidation of every account; `accountGenerations` by one of a single account. */
  private generation = 0;
  private accountGenerations = new Map<string, number>();
  private observations = new Map<string, AccountQuota>();
  /** Bumped when one account's reading is dropped, so a read already in flight cannot restore it. */
  private epochs = new Map<string, number>();
  constructor(private core: Core, private read: QuotaReader = (account) => account.providerId === 'claude' ? readClaude(core, account) : account.providerId === 'codex' ? readCodex(core, account) : readExtraQuota(core, account), consume?: QuotaResetConsumer) {
    this.gateway = new GatewayQuotas(core, undefined, () => this.core.bus.emit('quotas.updated', this.known()));
    this.alerts = new QuotaAlertStore(core, () => this.watch());
    this.resets = new QuotaResetStore(core, consume ?? (async (account, requestId, selection) => {
      if (account.providerId === 'claude') return consumeClaudeReset(core, account, requestId, selection);
      const { consumeCodexReset } = await import('./drivers/codex/models.ts');
      return withQuotaProbe(core, account, 'codex reset', (ctx) => consumeCodexReset(ctx, requestId, selection), true);
    }), async (account) => {
      // A pre-reset read must settle before the new reading can replace it.
      await this.pending.get(account.id);
      this.cache.delete(account.id);
      const quota = await this.one(account, true);
      this.core.bus.emit('quotas.updated', this.known());
      return quota;
    });
    core.bus.onAny((name, payload) => {
      if (name === 'accounts.removed') {
        this.forget((id) => id === (payload as { accountId: string }).accountId);
        this.alerts.forget((payload as { accountId: string }).accountId);
      }
      // Every answer of the gateway, whoever asked for it, is a reading its alerts look at.
      if (name === 'subscriptionProxy.quotasUpdated') this.alerts.check(this.gateway.rows(payload as ReturnType<GatewayQuotas['state']>));
      if (name === 'accounts.updated') {
        const account = payload as Account;
        const kept = this.lastGood.get(account.id);
        if (kept && !sameLogin(kept.identity, account.identity)) {
          this.forget((id) => id === account.id);
          this.alerts.rearm(account.id);
        }
        else if (kept && kept.identity === null) kept.identity = account.identity;
      }
      if (name === 'accounts.updated' || name === 'accounts.removed') this.invalidate(String(object(payload)['id'] ?? object(payload)['accountId'] ?? ''));
      else if (name === 'providers.updated') this.invalidate();
    });
  }
  /** The next list reads again; the last good readings stay as the fallback. */
  invalidate(accountId?: string): void {
    if (!accountId) { this.generation++; this.cache.clear(); this.observations.clear(); return; }
    // One account changed: the others keep their readings and their reads in flight.
    this.accountGenerations.set(accountId, (this.accountGenerations.get(accountId) ?? 0) + 1);
    this.cache.delete(accountId);
    this.observations.delete(accountId);
  }
  /** Drops the readings of these accounts, for a login that now belongs to someone else. */
  forget(matches: (accountId: string) => boolean): void {
    // A read still in flight is dropped too: its account may be switched off before it lands.
    for (const id of new Set([...this.cache.keys(), ...this.lastGood.keys(), ...this.observations.keys(), ...this.pending.keys()])) {
      if (!matches(id)) continue;
      this.cache.delete(id);
      this.lastGood.delete(id);
      this.observations.delete(id);
      this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    }
  }
  private base(account: Account): AccountQuota {
    const preferences = object(this.core.journal.getSetting('quota-accounts'));
    const provider = this.core.providers.get(account.providerId);
    const proxied = provider && activeSubscriptionProxy(this.core, provider);
    // A provider turned off is never read: its accounts stand as they would with no reader.
    const summary = this.core.providers.summary(account.providerId);
    const supported = !proxied && summary?.enabled !== false && (this.isMuse(account) || ['claude', 'codex', 'grok', 'opencode', OPENCODE_V2].includes(account.providerId) || readsAntigravitySignIn(provider));
    const stored = preferences[account.id];
    const enabled = typeof stored === 'boolean' ? stored : true;
    // The admin policy stops every read that sends the account's token: the row says why.
    const blocked = supported && enabled && this.core.policy.quotaReadsOff();
    return { accountId: account.id, providerId: account.providerId, providerName: isOpenCode(account.providerId) ? 'OpenCode Go' : this.core.providers.get(account.providerId)?.name ?? account.providerId,
      label: account.label, enabled, status: !supported ? 'unsupported' : !enabled || blocked ? 'disabled' : 'unavailable', windows: [], checkedAt: null,
      error: blocked ? this.core.policy.refusal('quotaReads').message : null };
  }
  private isMuse(account: Account): boolean { return this.core.providers.get(account.providerId)?.protocol === 'muse'; }
  /**
   * Only running hosts contribute observations; listing never starts a Muse turn.
   * A running Codex session reports the limits a read would spawn an app-server
   * for, in a sparse update: it is merged into the last full read, and the
   * merged row stands as a fresh read until it is `CACHE_MS` old. With no full
   * read held, or one `OBSERVED_MS` old, the update is dropped and the next
   * list reads again.
   */
  observe(accountId: string, reading: QuotaReading, observedAt: number): void {
    const account = this.core.accounts.list().find((row) => row.id === accountId);
    if (!account) return;
    if (account.providerId === 'codex' && !this.isMuse(account)) { this.observeRead(account, reading, observedAt); return; }
    if (!this.isMuse(account) || this.base(account).status !== 'unavailable' || !reading.windows.length) return;
    const previous = this.observations.get(accountId);
    if (previous && (previous.checkedAt ?? 0) > observedAt) return;
    const value: AccountQuota = { ...this.base(account), ...reading, status: 'ready', source: 'observation', checkedAt: observedAt };
    this.observations.set(accountId, value);
    this.alerts.check([value]);
    this.core.bus.emit('quotas.updated', this.known());
  }
  private observeRead(account: Account, reading: QuotaReading, observedAt: number): void {
    const base = this.base(account);
    if (base.status !== 'unavailable' || !reading.windows.length) return;
    // Alerts hear every observed window, even one that cannot stand in for a full read below.
    this.alerts.check([{ ...base, windows: reading.windows, status: 'ready', checkedAt: observedAt }]);
    const held = this.cache.get(account.id);
    const previous = held?.value;
    if (!previous || previous.status !== 'ready' || held.readAt === undefined || observedAt - held.readAt > OBSERVED_MS) return;
    if (previous.checkedAt != null && previous.checkedAt > observedAt) return;
    // A window the update leaves out keeps its last value; banked resets come only from a full read.
    const windows = [...previous.windows.map((old) => reading.windows.find((row) => row.id === old.id) ?? old), ...reading.windows.filter((row) => !previous.windows.some((old) => old.id === row.id))];
    const value: AccountQuota = { ...previous, label: base.label, providerName: base.providerName, windows, ...(reading.credits ? { credits: reading.credits } : {}),
      status: 'ready', source: 'observation', checkedAt: observedAt, error: null };
    this.cache.set(account.id, { value, retryAt: Date.now() + 10_000, readAt: held.readAt });
    this.lastGood.set(account.id, { value, identity: account.identity });
    const same = previous?.status === 'ready' && JSON.stringify([previous.windows, previous.resetCredits, previous.credits]) === JSON.stringify([value.windows, value.resetCredits, value.credits]);
    if (!same) this.core.bus.emit('quotas.updated', this.known());
  }
  private kept(account: Account): AccountQuota | undefined {
    const kept = this.lastGood.get(account.id);
    return kept && sameLogin(kept.identity, account.identity) ? kept.value : undefined;
  }
  /** Every row as known now, the gateway's last answer included, for an update event. */
  private known(): AccountQuota[] {
    if (this.gatewayOwnsLimits()) return this.decorate(this.gateway.rows());
    return this.decorate([...this.core.accounts.list().map((row) => this.snapshot(row)), ...this.gateway.rows()]);
  }
  private decorate(rows: AccountQuota[]): AccountQuota[] { return rows.map((row) => this.alerts.decorate(row)); }
  /**
   * A Douane in use answers for the accounts that serve this machine's agents.
   * The machine's own logins would only be noise beside them, and reading them
   * would start their agents for nothing.
   */
  private gatewayOwnsLimits(): boolean {
    const proxy = this.core.settings.get().subscriptionProxy;
    return proxy?.enabled === true && proxy.kind === 'douane';
  }
  /** What is known without reading: the cached row, else the last good reading, else nothing yet. */
  private snapshot(account: Account): AccountQuota {
    const base = this.base(account);
    if (base.status !== 'unavailable') return base;
    const known = this.observations.get(account.id) ?? this.cache.get(account.id)?.value ?? this.kept(account);
    return known ? { ...known, label: base.label, providerName: base.providerName } : base;
  }
  /** `progress` hears each row as it lands, for the caller that passed `requestId` alone. */
  async list(refresh = false, requestId?: string, progress?: (quota: AccountQuota) => void): Promise<AccountQuota[]> {
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId || requestId.length > 128)) {
      throw invalidParams('quotas.list requestId must be a non-empty string of at most 128 characters');
    }
    // Providers run independently; at most two accounts per provider per list.
    // Concurrent lists still share the account's pending read and cache.
    if (this.gatewayOwnsLimits()) {
      const rows = this.decorate(this.gateway.rows(await this.gateway.read(refresh)));
      if (requestId && progress) for (const quota of rows) progress(quota);
      return rows;
    }
    const rows = this.core.accounts.list();
    const result = new Array<AccountQuota>(rows.length);
    const groups = new Map<string, { account: Account; index: number }[]>();
    rows.forEach((account, index) => {
      const group = groups.get(account.providerId) ?? [];
      group.push({ account, index });
      groups.set(account.providerId, group);
    });
    // The gateway answers for its own accounts, alongside the providers.
    const gateway = this.gateway.read(refresh).then((state) => {
      const rows = this.decorate(this.gateway.rows(state));
      if (requestId && progress) for (const quota of rows) progress(quota);
      return rows;
    });
    await Promise.all([...groups.values()].map(async (group) => {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, group.length) }, async () => {
        while (next < group.length) {
          const { account, index } = group[next++]!;
          const quota = this.alerts.decorate(await this.one(account, refresh));
          result[index] = quota;
          if (requestId && progress) progress(quota);
        }
      }));
    }));
    // An observation kept from before the row was turned off, by the user or the policy, does not stand in for it.
    return [...result.map((row) => { const seen = row.status === 'disabled' || row.status === 'unsupported' ? undefined : this.observations.get(row.accountId); return seen ? this.alerts.decorate(seen) : row; }), ...await gateway];
  }
  /**
   * One account's reading, through the same cache, backoff and shared read as
   * the list. Null for an account that is gone; a failed read answers its last
   * good reading, marked unavailable.
   */
  async readAccount(accountId: string, refresh = false): Promise<AccountQuota | null> {
    const account = this.core.accounts.list().find((row) => row.id === accountId);
    if (account === undefined) return null;
    // `one` answers a Muse observation itself, and only while the row is on.
    return this.alerts.decorate(await this.one(account, refresh));
  }
  private async one(account: Account, refresh: boolean): Promise<AccountQuota> {
    const base = this.base(account);
    if (base.status !== 'unavailable') return base;
    if (this.isMuse(account)) return this.observations.get(account.id) ?? base;
    const cached = this.cache.get(account.id);
    // Refresh cannot bypass failure backoff or turn a hover into a request flood.
    if (cached && (Date.now() < cached.retryAt || (!refresh && Date.now() - (cached.value.checkedAt ?? 0) < CACHE_MS))) return cached.value;
    const existing = this.pending.get(account.id);
    if (existing) return this.settled(account, existing);
    const generation = this.generation;
    const accountGeneration = this.accountGenerations.get(account.id) ?? 0;
    const epoch = this.epochs.get(account.id) ?? 0;
    const running = (async () => {
      let value: AccountQuota;
      const startedAt = Date.now();
      try {
        const raw = await this.read(account);
        const reading = Array.isArray(raw) ? { windows: raw } : raw;
        if (!hasQuota(reading)) throw new Error('No subscription usage limits were returned. Retrying in five minutes.');
        value = { ...base, ...reading, status: 'ready', checkedAt: Date.now(), error: null };
        if (epoch === (this.epochs.get(account.id) ?? 0)) {
          this.lastGood.set(account.id, { value, identity: account.identity });
          // Still switched on and still this login: the reading is the account's, taken when the read began.
          if (generation === this.generation && accountGeneration === (this.accountGenerations.get(account.id) ?? 0) && this.base(account).status === 'unavailable') {
            this.alerts.check([value], Date.now(), startedAt);
          }
        }
      } catch (error) {
        const kept = epoch === (this.epochs.get(account.id) ?? 0) ? this.kept(account) : undefined;
        value = { ...(kept ?? base), label: base.label, providerName: base.providerName, status: 'unavailable', checkedAt: kept?.checkedAt ?? null,
          error: error instanceof Error ? error.message : 'Quota request failed.' };
      }
      if (generation === this.generation && accountGeneration === (this.accountGenerations.get(account.id) ?? 0) && epoch === (this.epochs.get(account.id) ?? 0)) this.cache.set(account.id, value.status === 'ready' ? { value, retryAt: Date.now() + 10_000, readAt: value.checkedAt! } : { value, retryAt: Date.now() + RETRY_MS });
      return value;
    })();
    this.pending.set(account.id, running);
    try { return await this.settled(account, running); } finally { this.pending.delete(account.id); }
  }
  /** A read still running when its row was turned off, by the user or the policy, answers the row as it is now. */
  private async settled(account: Account, read: Promise<AccountQuota>): Promise<AccountQuota> {
    const value = await read;
    const now = this.base(account);
    return now.status === 'unavailable' ? value : now;
  }
  async configure(accountId: string, enabled: boolean): Promise<AccountQuota[]> {
    this.core.accounts.require(accountId);
    if (typeof enabled !== 'boolean') throw invalidParams('quotas.configure enabled must be a boolean');
    const next = { ...object(this.core.journal.getSetting('quota-accounts')), [accountId]: enabled };
    this.core.journal.append({ type: 'quotas.configured', threadId: null, version: 1, payload: { accountId, enabled } }, () => this.core.journal.setSetting('quota-accounts', next));
    // Only this account changes: every other one keeps the reading it had.
    if (enabled) { this.cache.delete(accountId); this.observations.delete(accountId); }
    else this.forget((id) => id === accountId);
    const result = this.known();
    this.core.bus.emit('quotas.updated', result);
    return result;
  }
  /** Sets when one period of an account, or of a gateway entry, notifies. */
  alert(accountId: string, period: QuotaAlertPeriod, thresholds: unknown): AccountQuota[] {
    if (typeof accountId !== 'string' || !accountId) throw invalidParams('quotas.alert accountId must be a non-empty string', { field: 'accountId' });
    const row = this.known().find((quota) => quota.accountId === accountId);
    // Turning one off always goes through: a row that left the list must not keep its alert, and the poll, alive.
    if (!row && !(Array.isArray(thresholds) && thresholds.length === 0 && this.alerts.all()[accountId])) {
      if (accountId.startsWith('proxy:')) throw invalidParams(`quotas.alert accountId ${accountId} is not an entry the gateway reports now`, { field: 'accountId', expected: 'an accountId quotas.list returns' });
      this.core.accounts.require(accountId);
      // A Douane in use lists only its own entries: this machine's logins have no limits row to alert on.
      throw invalidParams(`quotas.alert accountId ${accountId} has no row in quotas.list now`, { field: 'accountId', expected: 'an accountId quotas.list returns' });
    }
    this.alerts.set(accountId, period, thresholds, row);
    const result = this.known();
    this.core.bus.emit('quotas.updated', result);
    return result;
  }
  /**
   * What the alert poll reads: the gateway when one of its entries has an
   * alert, and each watched account of this machine through the usual cache.
   * Every reading lands in `alerts.check` on the way.
   */
  private async watch(): Promise<void> {
    const watched = this.alerts.watched();
    if (watched.some((id) => id.startsWith('proxy:'))) await this.gateway.read(false);
    if (this.gatewayOwnsLimits()) return;
    const own = new Set(this.core.accounts.list().map((account) => account.id));
    for (const id of watched) if (own.has(id)) await this.readAccount(id);
  }
}
