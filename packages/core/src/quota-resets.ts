import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Account, AccountQuota, QuotaResetOutcome, QuotaResetResult } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';
import { homePath } from './paths.ts';
import { claudeNextResetGrant, claudeUsageAgent } from './quota-details.ts';

const ATTEMPTS = 'quota-reset-attempts';
const OUTCOMES: QuotaResetOutcome[] = ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'];

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class QuotaResetError extends Error {
  constructor(message: string, readonly settled = false) { super(message); }
}

export function quotaResetOutcome(value: unknown): QuotaResetOutcome {
  if (OUTCOMES.includes(value as QuotaResetOutcome)) return value as QuotaResetOutcome;
  throw new QuotaResetError('The provider could not confirm the reset. Refresh the limits before trying again.');
}

/** A private credit selection persisted before consumption and reused after an uncertain reply. */
export interface QuotaResetSelection {
  creditId?: string;
  remember(creditId: string): void;
}
export type QuotaResetConsumer = (account: Account, requestId: string, selection: QuotaResetSelection) => Promise<QuotaResetOutcome>;

/** Uses the same directory selection as the account's quota reader. */
function loginDirectory(core: Core, account: Account): string {
  const env = core.accounts.accountEnv(account, core.providers.require(account.providerId));
  const variable = account.providerId === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  return env[variable] ?? process.env[variable] ?? join(homePath(), account.providerId === 'claude' ? '.claude' : '.codex');
}

function attemptKey(core: Core, account: Account): string {
  let directory = resolve(loginDirectory(core, account));
  try { directory = realpathSync(directory); } catch { /* A missing login will be reported by its provider. */ }
  if (process.platform === 'win32') directory = directory.toLowerCase();
  return JSON.stringify([account.providerId, directory]);
}

/** Also reads the plain request ids stored before attempts included the selected credit. */
function requestIdOf(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value : object(value)['requestId'];
  return typeof candidate === 'string' && /^[\w-]{1,64}$/.test(candidate) ? candidate : null;
}

/** One attempt per login, including aliases that point at the same directory. */
export class QuotaResetStore {
  private pending = new Map<string, Promise<QuotaResetResult>>();
  constructor(private core: Core, private consume: QuotaResetConsumer, private refresh: (account: Account) => Promise<AccountQuota>) {}

  async reset(accountId: string, confirmed: unknown): Promise<QuotaResetResult> {
    if (confirmed !== true) throw invalidParams('quotas.reset confirmed must be true after user confirmation', { field: 'confirmed', expected: true });
    const account = this.core.accounts.require(accountId);
    if (!['claude', 'codex'].includes(account.providerId)) throw refused(`Banked resets are not supported for ${account.providerId}.`);
    if (account.status === 'unauthenticated') throw refused('Sign in to this account before using a reset.');
    if (object(this.core.journal.getSetting('quota-accounts'))[account.id] === false) throw refused('Enable quota monitoring for this account before using a reset.');
    const key = attemptKey(this.core, account);
    const existing = this.pending.get(key);
    if (existing) {
      const result = await existing;
      return result.quota.accountId === account.id ? result : { ...result, quota: await this.refresh(account) };
    }
    const attempts = object(this.core.journal.getSetting(ATTEMPTS));
    const previous = attempts[key];
    const requestId = requestIdOf(previous) ?? randomUUID();
    this.core.journal.setSetting(ATTEMPTS, { ...attempts, [key]: { ...object(previous), requestId } });
    const creditId = object(previous)['creditId'];
    const selection: QuotaResetSelection = {
      ...(typeof creditId === 'string' ? { creditId } : {}),
      remember: (selected) => {
        const current = object(this.core.journal.getSetting(ATTEMPTS));
        if (requestIdOf(current[key]) !== requestId) throw new QuotaResetError('The reset attempt changed. Refresh the limits before trying again.', true);
        this.core.journal.setSetting(ATTEMPTS, { ...current, [key]: { requestId, creditId: selected } });
      },
    };
    const clearAttempt = () => {
      const current = object(this.core.journal.getSetting(ATTEMPTS));
      if (requestIdOf(current[key]) !== requestId) return;
      delete current[key];
      this.core.journal.setSetting(ATTEMPTS, current);
    };
    const running = (async () => {
      let outcome: QuotaResetOutcome;
      try { outcome = quotaResetOutcome(await this.consume(account, requestId, selection)); }
      catch (error) {
        if (error instanceof QuotaResetError && error.settled) clearAttempt();
        throw error;
      }
      // A failed refresh must never make a second attempt spend another credit.
      clearAttempt();
      return { outcome, quota: await this.refresh(account) };
    })();
    this.pending.set(key, running);
    try { return await running; } finally { this.pending.delete(key); }
  }
}

/** Tokens remain in the core and are sent only to Anthropic, with redirects refused. */
export async function consumeClaudeReset(core: Core, account: Account, requestId: string, selection: QuotaResetSelection): Promise<QuotaResetOutcome> {
  if (!/^[\w-]{1,64}$/.test(requestId)) throw new QuotaResetError('Claude reset request_id must contain 1 to 64 letters, digits, underscores or hyphens.', true);
  const directory = loginDirectory(core, account);
  const version = core.updates.current(account.providerId);
  const agent = claudeUsageAgent(version);
  if (!agent['User-Agent']) throw new QuotaResetError('Check the installed Claude version in Providers before using a reset.', true);
  let credentials: Record<string, unknown>;
  let config: Record<string, unknown>;
  try {
    credentials = object(JSON.parse(await readFile(join(directory, '.credentials.json'), 'utf8')));
    const configured = core.accounts.accountEnv(account, core.providers.require(account.providerId))['CLAUDE_CONFIG_DIR'] ?? process.env['CLAUDE_CONFIG_DIR'];
    config = object(JSON.parse(await readFile(configured ? join(directory, '.claude.json') : join(homePath(), '.claude.json'), 'utf8')));
  } catch { throw new QuotaResetError('Claude .credentials.json and .claude.json must be readable JSON files for this account. Check its connection in Providers.', true); }
  const token = object(credentials['claudeAiOauth'])['accessToken'];
  const organization = object(config['oauthAccount'])['organizationUuid'];
  if (typeof token !== 'string' || !token.trim()) throw new QuotaResetError('Claude .credentials.json: claudeAiOauth.accessToken must be a non-empty string. Connect this account in Providers.', true);
  if (typeof organization !== 'string' || !organization.trim()) throw new QuotaResetError('Claude .claude.json: oauthAccount.organizationUuid must be a non-empty string. Connect this account in Providers.', true);
  const headers = { Authorization: `Bearer ${token.trim()}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', ...agent };
  const request = async (url: string, init: RequestInit = {}) => {
    let response: Response;
    try { response = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, redirect: 'error', signal: AbortSignal.timeout(25_000) }); }
    catch { throw new QuotaResetError('Claude could not confirm the reset request. Refresh the limits before trying again.'); }
    if (response.status === 401 || response.status === 403) throw new QuotaResetError('Sign in to this Claude account again before using a reset.', true);
    if (response.status === 429) throw new QuotaResetError('Claude is rate limiting resets. Try again later.', true);
    if (!response.ok) throw new QuotaResetError(`Claude could not confirm the reset request (HTTP ${response.status}).`);
    try { return object(await response.json()); }
    catch { throw new QuotaResetError('Claude could not confirm the reset response. Refresh the limits before trying again.'); }
  };
  let grantId = selection.creditId;
  // Retries keep the original claim even if that grant disappeared after a lost response.
  if (grantId === undefined) {
    const usage = await request('https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1');
    const grant = claudeNextResetGrant(usage);
    if (!grant) return 'noCredit';
    grantId = grant.id;
  }
  if (typeof grantId !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(grantId)) throw new QuotaResetError('Claude returned an invalid reset grant.', true);
  // Persist before the POST; grant identifiers never enter the client contract.
  selection.remember(grantId);
  const answer = await request(`https://api.anthropic.com/api/organizations/${encodeURIComponent(organization.trim())}/reset_rate_limits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ program: 'cedar_ember', grant_id: grantId, request_id: requestId }),
  });
  if (answer['result'] === 'cooldown') throw new QuotaResetError('Claude resets are cooling down. Try again later.', true);
  const outcomes: Record<string, QuotaResetOutcome> = { reset: 'reset', not_limited: 'nothingToReset', already_used: 'alreadyRedeemed', ineligible: 'noCredit' };
  return quotaResetOutcome(typeof answer['result'] === 'string' ? outcomes[answer['result']] : undefined);
}
