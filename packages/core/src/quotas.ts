import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { removeDir } from './fs-retry.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, AccountQuota, QuotaReading, QuotaWindow } from '@boite/contracts';
import type { Core } from './core.ts';
import { homePath } from './paths.ts';
import { invalidParams } from './errors.ts';
import { claudeQuotaDetails, claudeUsageAgent, codexQuotaDetails } from './quota-details.ts';
import { consumeClaudeReset, QuotaResetStore, type QuotaResetConsumer } from './quota-resets.ts';
import { ANTIGRAVITY_QUOTA_ID, readExtraQuota } from './quota-readers.ts';
import type { ProbeContext } from './drivers/types.ts';
import { activeSubscriptionProxy } from './subscription-proxy.ts';
import { GatewayQuotas } from './subscription-proxy-quotas.ts';

export { claudeUsageAgent } from './quota-details.ts';

const cliAccount: Account = { id: ANTIGRAVITY_QUOTA_ID, providerId: 'antigravity', label: 'Antigravity CLI', isolationDir: null, status: 'unknown', identity: null, createdAt: 0 };

const CACHE_MS = 60_000;
const RETRY_MS = 300_000;
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

function window(id: string, label: string, percent: unknown, reset: unknown): QuotaWindow | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  const at = typeof reset === 'number' ? reset * 1000 : typeof reset === 'string' ? Date.parse(reset) : NaN;
  return { id, label, usedPercent: Math.max(0, Math.min(100, percent)), resetsAt: Number.isFinite(at) ? at : null };
}

export function claudeQuotaWindows(raw: unknown): QuotaWindow[] {
  const root = object(raw);
  const limits = object(root['rate_limits'] ?? root);
  const windows: QuotaWindow[] = [];
  for (const [id, value] of Object.entries(limits)) {
    if (!id.startsWith('five_hour') && !id.startsWith('seven_day')) continue;
    const entry = object(value);
    const label = id === 'five_hour' ? '5 hours' : id === 'seven_day' ? 'Weekly' : id.replaceAll('_', ' ');
    const mapped = window(id, label, entry['utilization'], entry['resets_at']);
    if (mapped) windows.push(mapped);
  }
  for (const value of Array.isArray(limits['model_scoped']) ? limits['model_scoped'] : []) {
    const entry = object(value);
    if (typeof entry['display_name'] !== 'string') continue;
    const mapped = window(`model:${entry['display_name']}`, `Weekly · ${entry['display_name']}`, entry['utilization'], entry['resets_at']);
    if (mapped) windows.push(mapped);
  }
  return windows;
}

export function codexQuotaWindows(raw: unknown): QuotaWindow[] {
  const root = object(raw);
  const byId = object(root['rateLimitsByLimitId']);
  const snapshot = object(byId['codex'] ?? root['rateLimits']);
  if (snapshot['limitId'] && snapshot['limitId'] !== 'codex') return [];
  const windows: QuotaWindow[] = [];
  for (const id of ['primary', 'secondary']) {
    const value = object(snapshot[id]);
    const fallback = id === 'secondary' ? 10080 : ['free', 'go'].includes(String(snapshot['planType'])) ? 43200 : 300;
    const minutes = typeof value['windowDurationMins'] === 'number' ? value['windowDurationMins'] : fallback;
    const label = minutes >= 43200 ? 'Monthly' : minutes >= 10080 ? 'Weekly' : `${minutes / 60} hours`;
    const mapped = window(id, label, value['usedPercent'], value['resetsAt']);
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

/** A CLI started for one quota read, in a scratch directory, traced and stopped whatever happens. */
async function withQuotaProbe<T>(core: Core, account: Account, name: string, read: (ctx: ProbeContext) => Promise<T>, reset = false): Promise<T> {
  const provider = core.providers.require(account.providerId);
  const cwd = mkdtempSync(join(tmpdir(), 'boite-quota-'));
  const threadId = `${reset ? 'quota-reset' : 'quota'}:${account.id}`;
  const exits: Promise<void>[] = [];
  try {
    return await read({
      provider, accountId: account.id, cwd,
      accountEnv: core.accounts.accountEnv(account, provider),
      spawnChild: (cmd, args, opts) => {
        const child = core.procs.spawnChild(threadId, cmd, args, opts);
        exits.push(new Promise<void>((resolve) => { child.once('close', () => resolve()); child.once('error', () => resolve()); }));
        return child;
      },
      killTree: () => core.procs.killTree(threadId),
      log: (level, message) => core.log(level, `${name} quota: ${message}`),
    });
  } finally {
    core.procs.killTree(threadId);
    await Promise.all(exits);
    // A descendant can hold the directory after the direct child closed. Neither
    // waiting for it nor removing the directory may replace the windows just read.
    await core.procs.stopAndWait(threadId).catch((error: unknown) => core.log('warn', `${name} quota: ${error instanceof Error ? error.message : String(error)}`));
    await removeDir(cwd, (message) => core.log('warn', `${name} quota: ${message}`));
  }
}

export type QuotaReader = (account: Account) => Promise<QuotaWindow[] | QuotaReading>;

export class QuotaStore {
  readonly resets: QuotaResetStore;
  /** The subscription gateway's own accounts, listed after this machine's. */
  readonly gateway: GatewayQuotas;
  /** Backoff and freshness: when the next read may go out. Cleared by every invalidation. */
  private cache = new Map<string, { value: AccountQuota; retryAt: number }>();
  /**
   * The last successful reading of each account, kept through invalidations so
   * a failed read shows it as stale instead of nothing. Forgotten only when it
   * stops belonging to the account: removed, disabled or signed in as someone else.
   */
  private lastGood = new Map<string, { value: AccountQuota; identity: string | null }>();
  private pending = new Map<string, Promise<AccountQuota>>();
  private generation = 0;
  private observations = new Map<string, AccountQuota>();
  /** Bumped when one account's reading is dropped, so a read already in flight cannot restore it. */
  private epochs = new Map<string, number>();
  constructor(private core: Core, private read: QuotaReader = (account) => account.providerId === 'claude' ? readClaude(core, account) : account.providerId === 'codex' ? readCodex(core, account) : readExtraQuota(core, account), consume?: QuotaResetConsumer) {
    this.gateway = new GatewayQuotas(core);
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
      if (name === 'accounts.removed') this.forget((id) => id === (payload as { accountId: string }).accountId);
      if (name === 'accounts.updated') {
        const account = payload as Account;
        const kept = this.lastGood.get(account.id);
        if (kept && !sameLogin(kept.identity, account.identity)) this.forget((id) => id === account.id);
        else if (kept && kept.identity === null) kept.identity = account.identity;
      }
      if (name === 'accounts.updated' || name === 'accounts.removed') this.invalidate(String(object(payload)['id'] ?? object(payload)['accountId'] ?? ''));
      else if (name === 'providers.updated') this.invalidate();
    });
  }
  /** The next list reads again; the last good readings stay as the fallback. */
  invalidate(accountId?: string): void {
    this.generation++; this.cache.clear();
    if (accountId) this.observations.delete(accountId); else this.observations.clear();
  }
  /** Drops the readings of these accounts, for a login that now belongs to someone else. */
  forget(matches: (accountId: string) => boolean): void {
    for (const id of new Set([...this.cache.keys(), ...this.lastGood.keys(), ...this.observations.keys()])) {
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
    const supported = !proxied && (this.isMuse(account) || ['claude', 'codex', 'grok', 'opencode'].includes(account.providerId) || account.id === ANTIGRAVITY_QUOTA_ID);
    const enabled = account.id === ANTIGRAVITY_QUOTA_ID ? preferences[account.id] === true : preferences[account.id] !== false;
    return { accountId: account.id, providerId: account.providerId, providerName: account.providerId === 'opencode' ? 'OpenCode Go' : this.core.providers.get(account.providerId)?.name ?? account.providerId,
      label: account.label, enabled, status: !supported ? 'unsupported' : !enabled ? 'disabled' : 'unavailable', windows: [], checkedAt: null, error: null };
  }
  private isMuse(account: Account): boolean { return this.core.providers.get(account.providerId)?.protocol === 'muse'; }
  /** Only running hosts contribute observations; listing never starts a Muse turn. */
  observe(accountId: string, reading: QuotaReading, observedAt: number): void {
    const account = this.core.accounts.list().find((row) => row.id === accountId);
    if (!account || !this.isMuse(account) || !this.base(account).enabled || !reading.windows.length) return;
    const previous = this.observations.get(accountId);
    if (previous && (previous.checkedAt ?? 0) > observedAt) return;
    const value: AccountQuota = { ...this.base(account), ...reading, status: 'ready', source: 'observation', checkedAt: observedAt };
    this.observations.set(accountId, value);
    this.core.bus.emit('quotas.updated', this.known());
  }
  private kept(account: Account): AccountQuota | undefined {
    const kept = this.lastGood.get(account.id);
    return kept && sameLogin(kept.identity, account.identity) ? kept.value : undefined;
  }
  /** Every row as known now, the gateway's last answer included, for an update event. */
  private known(): AccountQuota[] {
    return [...[...this.core.accounts.list(), cliAccount].map((row) => this.snapshot(row)), ...this.gateway.rows()];
  }
  /** What is known without reading: the cached row, else the last good reading, else nothing yet. */
  private snapshot(account: Account): AccountQuota {
    const base = this.base(account);
    if (base.status !== 'unavailable') return base;
    const known = this.observations.get(account.id) ?? this.cache.get(account.id)?.value ?? this.kept(account);
    return known ? { ...known, label: base.label, providerName: base.providerName } : base;
  }
  async list(refresh = false, requestId?: string): Promise<AccountQuota[]> {
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId || requestId.length > 128)) {
      throw invalidParams('quotas.list requestId must be a non-empty string of at most 128 characters');
    }
    // Providers run independently; at most two accounts per provider per list.
    // Concurrent lists still share the account's pending read and cache.
    const rows = [...this.core.accounts.list(), cliAccount];
    const result = new Array<AccountQuota>(rows.length);
    const groups = new Map<string, { account: Account; index: number }[]>();
    rows.forEach((account, index) => {
      const group = groups.get(account.providerId) ?? [];
      group.push({ account, index });
      groups.set(account.providerId, group);
    });
    // The gateway answers for its own accounts, alongside the providers.
    const gateway = this.gateway.read(refresh).then((state) => {
      const rows = this.gateway.rows(state);
      if (requestId) for (const quota of rows) this.core.bus.emit('quotas.progress', { requestId, quota });
      return rows;
    });
    await Promise.all([...groups.values()].map(async (group) => {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, group.length) }, async () => {
        while (next < group.length) {
          const { account, index } = group[next++]!;
          const quota = await this.one(account, refresh);
          result[index] = quota;
          if (requestId) this.core.bus.emit('quotas.progress', { requestId, quota });
        }
      }));
    }));
    return [...result.map((row) => this.observations.get(row.accountId) ?? row), ...await gateway];
  }
  private async one(account: Account, refresh: boolean): Promise<AccountQuota> {
    const base = this.base(account);
    if (base.status !== 'unavailable') return base;
    if (this.isMuse(account)) return this.observations.get(account.id) ?? base;
    const cached = this.cache.get(account.id);
    // Refresh cannot bypass failure backoff or turn a hover into a request flood.
    if (cached && (Date.now() < cached.retryAt || (!refresh && Date.now() - (cached.value.checkedAt ?? 0) < CACHE_MS))) return cached.value;
    const existing = this.pending.get(account.id);
    if (existing) return existing;
    const generation = this.generation;
    const epoch = this.epochs.get(account.id) ?? 0;
    const running = (async () => {
      let value: AccountQuota;
      try {
        const raw = await this.read(account);
        const reading = Array.isArray(raw) ? { windows: raw } : raw;
        if (!hasQuota(reading)) throw new Error('No subscription usage limits were returned. Retrying in five minutes.');
        value = { ...base, ...reading, status: 'ready', checkedAt: Date.now(), error: null };
        if (epoch === (this.epochs.get(account.id) ?? 0)) this.lastGood.set(account.id, { value, identity: account.identity });
      } catch (error) {
        const kept = epoch === (this.epochs.get(account.id) ?? 0) ? this.kept(account) : undefined;
        value = { ...(kept ?? base), label: base.label, providerName: base.providerName, status: 'unavailable', checkedAt: kept?.checkedAt ?? null,
          error: error instanceof Error ? error.message : 'Quota request failed.' };
      }
      if (generation === this.generation && epoch === (this.epochs.get(account.id) ?? 0)) this.cache.set(account.id, { value, retryAt: Date.now() + (value.status === 'ready' ? 10_000 : RETRY_MS) });
      return value;
    })();
    this.pending.set(account.id, running);
    try { return await running; } finally { this.pending.delete(account.id); }
  }
  async configure(accountId: string, enabled: boolean): Promise<AccountQuota[]> {
    if (accountId !== ANTIGRAVITY_QUOTA_ID) this.core.accounts.require(accountId);
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
}
