import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, AccountQuota, QuotaWindow } from '@boite/contracts';
import type { Core } from './core.ts';
import { homePath } from './paths.ts';
import { invalidParams } from './errors.ts';
import { ANTIGRAVITY_QUOTA_ID, readExtraQuota } from './quota-readers.ts';

const cliAccount: Account = { id: ANTIGRAVITY_QUOTA_ID, providerId: 'antigravity', label: 'Antigravity CLI', isolationDir: null, status: 'unknown', identity: null, createdAt: 0 };

const CACHE_MS = 60_000;
const RETRY_MS = 300_000;
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

/** The token stays inside this function and is sent only to Anthropic. */
async function readClaude(core: Core, account: Account): Promise<QuotaWindow[]> {
  const provider = core.providers.require(account.providerId);
  const env = core.accounts.accountEnv(account, provider);
  const directory = env['CLAUDE_CONFIG_DIR'] ?? process.env['CLAUDE_CONFIG_DIR'] ?? join(homePath(), '.claude');
  let credentials: ObjectValue;
  try { credentials = object(JSON.parse(await readFile(join(directory, '.credentials.json'), 'utf8'))); }
  catch { throw new Error('Claude login could not be read. Connect an account in Providers.'); }
  const token = object(credentials['claudeAiOauth'])['accessToken'];
  if (typeof token !== 'string' || !token) throw new Error('This Claude account has no subscription login. Connect it in Providers.');
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
  } catch { throw new Error('Claude quota request failed. Check the connection and retry.'); }
  if (response.status === 401) throw new Error('Claude login expired. Reconnect the account in Providers.');
  if (response.status === 429) throw new Error('Claude quota requests are rate limited. Retrying in five minutes.');
  if (!response.ok) throw new Error(`Claude quota request returned HTTP ${response.status}.`);
  try { return claudeQuotaWindows(await response.json()); }
  catch { throw new Error('Claude returned an invalid quota response.'); }
}

async function readCodex(core: Core, account: Account): Promise<QuotaWindow[]> {
  const { readCodexQuota } = await import('./drivers/codex.ts');
  const provider = core.providers.require(account.providerId);
  const cwd = mkdtempSync(join(tmpdir(), 'boite-quota-'));
  const threadId = `quota:${account.id}`;
  const exits: Promise<void>[] = [];
  try {
    return codexQuotaWindows(await readCodexQuota({
      provider, accountId: account.id, cwd,
      accountEnv: core.accounts.accountEnv(account, provider),
      spawnChild: (cmd, args, opts) => {
        const child = core.procs.spawnChild(threadId, cmd, args, opts);
        exits.push(new Promise<void>((resolve) => { child.once('close', () => resolve()); child.once('error', () => resolve()); }));
        return child;
      },
      killTree: () => core.procs.killTree(threadId),
      log: () => undefined,
    }));
  } finally {
    core.procs.killTree(threadId);
    await Promise.all(exits);
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export type QuotaReader = (account: Account) => Promise<QuotaWindow[]>;

export class QuotaStore {
  private cache = new Map<string, { value: AccountQuota; retryAt: number }>();
  private pending = new Map<string, Promise<AccountQuota>>();
  private generation = 0;
  constructor(private core: Core, private read: QuotaReader = (account) => account.providerId === 'claude' ? readClaude(core, account) : account.providerId === 'codex' ? readCodex(core, account) : readExtraQuota(core, account)) {
    core.bus.onAny((name) => {
      if (name === 'accounts.updated' || name === 'accounts.removed' || name === 'providers.updated') this.invalidate();
    });
  }
  invalidate(): void { this.generation++; this.cache.clear(); }
  private base(account: Account): AccountQuota {
    const preferences = object(this.core.journal.getSetting('quota-accounts'));
    const supported = ['claude', 'codex', 'grok', 'opencode'].includes(account.providerId) || account.id === ANTIGRAVITY_QUOTA_ID;
    const enabled = account.id === ANTIGRAVITY_QUOTA_ID ? preferences[account.id] === true : preferences[account.id] !== false;
    return { accountId: account.id, providerId: account.providerId, providerName: account.providerId === 'opencode' ? 'OpenCode Go' : this.core.providers.get(account.providerId)?.name ?? account.providerId,
      label: account.label, enabled, status: !supported ? 'unsupported' : !enabled ? 'disabled' : 'unavailable', windows: [], checkedAt: null, error: null };
  }
  async list(refresh = false): Promise<AccountQuota[]> {
    // Two requests at a time, including across accounts. No background polling.
    const rows = [...this.core.accounts.list(), cliAccount];
    const result: AccountQuota[] = [];
    for (let i = 0; i < rows.length; i += 2) result.push(...await Promise.all(rows.slice(i, i + 2).map((account) => this.one(account, refresh))));
    return result;
  }
  private async one(account: Account, refresh: boolean): Promise<AccountQuota> {
    const base = this.base(account);
    if (base.status !== 'unavailable') return base;
    const cached = this.cache.get(account.id);
    // Refresh cannot bypass failure backoff or turn a hover into a request flood.
    if (cached && (Date.now() < cached.retryAt || (!refresh && Date.now() - (cached.value.checkedAt ?? 0) < CACHE_MS))) return cached.value;
    const existing = this.pending.get(account.id);
    if (existing) return existing;
    const generation = this.generation;
    const running = (async () => {
      let value: AccountQuota;
      try {
        const windows = await this.read(account);
        value = { ...base, windows, status: windows.length ? 'ready' : 'unavailable', checkedAt: Date.now(), error: windows.length ? null : 'No subscription quota was reported for this account.' };
      } catch (error) {
        value = { ...base, windows: cached?.value.windows ?? [], checkedAt: cached?.value.checkedAt ?? null,
          error: error instanceof Error ? error.message : 'Quota request failed.' };
      }
      if (generation === this.generation) this.cache.set(account.id, { value, retryAt: Date.now() + (value.status === 'ready' ? 10_000 : RETRY_MS) });
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
    this.invalidate();
    const result = [...this.core.accounts.list(), cliAccount].map((account) => this.base(account));
    this.core.bus.emit('quotas.updated', result);
    return result;
  }
}
