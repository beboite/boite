import type { AccountId, ProviderId, Timestamp } from './ids';
import type { RpcEvents } from './index';
import type { SubscriptionProxy } from './subscription-proxy';
import type { TerminalState } from './terminals';

// ---------------------------------------------------------------------------
// Accounts: a descriptor plus an isolation directory. One account per thread.
// ---------------------------------------------------------------------------

export type AccountStatus = 'unknown' | 'ok' | 'unauthenticated' | 'error';

export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: Timestamp | null;
  /** Douane's choice of the window shown first and largest. Missing means the weekly window leads. */
  primary?: true;
}

/**
 * The length of window an alert watches. Every window of that length counts:
 * the account-wide one and any per model or group (`Weekly · Opus`).
 */
export type QuotaAlertPeriod = 'fiveHour' | 'weekly';
export const QUOTA_ALERT_PERIODS: readonly QuotaAlertPeriod[] = ['fiveHour', 'weekly'];
/** The shares left Limits offers in one click; any other whole percentage is a custom one. */
export const QUOTA_ALERT_PRESETS: readonly number[] = [50, 25, 10];
/** How many thresholds one period may hold. */
export const QUOTA_ALERT_MAX = 6;
/**
 * Per period, the shares left (whole percentages, 0 to 99) that each notify
 * once, highest first; a period left out sends nothing.
 */
export type QuotaAlerts = Partial<Record<QuotaAlertPeriod, number[]>>;

/**
 * The thresholds of one period as the core keeps them: distinct, highest
 * first. Null when the list is not one: more than `QUOTA_ALERT_MAX` values, or
 * a value that is not a whole percentage from 0 to 99.
 */
export function quotaAlertThresholds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > QUOTA_ALERT_MAX) return null;
  if (!value.every((left) => Number.isInteger(left) && left >= 0 && left <= 99)) return null;
  return [...new Set(value as number[])].sort((a, b) => b - a);
}

/**
 * Which period a window covers, from the ids and labels every source sends:
 * Claude's `five_hour` and `seven_day`, Codex's `5 hours` and `Weekly`,
 * OpenCode's `rolling`, Antigravity's `Gemini · 5 hours`, Douane's
 * `five-hour`, `seven-day` and `window-18000s`. Null for a daily, monthly or
 * credit window, and for a name nothing here recognizes.
 */
export function quotaAlertPeriod(window: Pick<QuotaWindow, 'id' | 'label'>): QuotaAlertPeriod | null {
  const text = `${window.id} ${window.label}`.toLowerCase();
  if (/week|seven|\b7\s*-?d|604800s/.test(text)) return 'weekly';
  if (/five|\b5\s*-?h|rolling|18000s/.test(text)) return 'fiveHour';
  return null;
}

/** What `quotas.alerted` says: one window of one account fell to a share left set for its period. */
export interface QuotaAlert {
  accountId: AccountId;
  providerId: ProviderId;
  providerName: string;
  /** The account's name as Limits shows it. */
  label: string;
  period: QuotaAlertPeriod;
  /** The share left, in percent, that was reached: the lowest one when a reading passed several. */
  threshold: number;
  window: QuotaWindow;
  at: Timestamp;
}

/**
 * An alert's title, the same in a push and a toast: the account, then the
 * model or group a scoped window names (`Weekly · Opus` gives `Opus`).
 */
export function quotaAlertTitle(alert: Pick<QuotaAlert, 'label' | 'providerName' | 'window'>): string {
  const name = alert.label.includes(alert.providerName) ? alert.label : `${alert.providerName} · ${alert.label}`;
  const scope = alert.window.label.split(' · ').filter((part) => !/week|hour|seven|\b\d+\s*-?[hd]\b/i.test(part)).join(' · ');
  return scope ? `${name} · ${scope}` : name;
}

/** What the alerted window has left, in whole percent, never above what was used allows: 99.6 % used is 0 % left. */
export function quotaAlertLeft(alert: Pick<QuotaAlert, 'window'>): number {
  return Math.max(0, Math.floor(100 - alert.window.usedPercent));
}

/** No redeemable identifiers reach the client. The core selects the next credit. */
export interface QuotaResetCredits {
  availableCount: number;
  nextExpiresAt: Timestamp | null;
}

export interface QuotaCredits {
  /** A prepaid balance or a monthly spending budget, never interchangeable. */
  kind: 'balance' | 'budget';
  /** Null means the provider did not confirm automatic paid usage. */
  enabled: boolean | null;
  /** Provider units. Budgets are displayed as a percentage, not a wallet. */
  remaining: number | null;
  limit: number | null;
  unlimited: boolean;
}

export interface QuotaReading {
  windows: QuotaWindow[];
  resetCredits?: QuotaResetCredits;
  credits?: QuotaCredits;
}

/** A credit line a subscription gateway reports, in its own unit. Unknown numbers are null. */
export interface GatewayQuotaCredit {
  id: string;
  label: string;
  unit: string | null;
  remaining: number | null;
  limit: number | null;
  used: number | null;
}

/**
 * One account of the gateway, or one average over a provider's accounts, as
 * Douane's `GET /v1/quotas` reports it once the core bounded and checked it.
 */
export interface GatewayQuotaEntry {
  id: string;
  label: string;
  plan: string | null;
  /** 1 for one account, N for an average over N accounts. */
  accounts: number;
  status: 'ready' | 'cooldown' | 'error' | 'disabled';
  /** Short and sanitized by the gateway, bounded again by the core. */
  error: string | null;
  updatedAt: Timestamp | null;
  windows: QuotaWindow[];
  credits: GatewayQuotaCredit[];
}

export interface GatewayQuotaProvider {
  /** The gateway's provider id: `claude`, `codex`, `antigravity` or another of its own. */
  providerId: string;
  name: string;
  display: 'accounts' | 'average';
  entries: GatewayQuotaEntry[];
}

/** What the subscription gateway said about its own accounts' limits. */
export interface SubscriptionProxyQuotas {
  /**
   * `ready`: the gateway answered. `unsupported`: it has no quotas route (CLIProxyAPI,
   * or a Douane older than `GET /v1/quotas`), so clients embed its dashboard.
   * `unavailable`: the read failed; `providers` keeps the last good answer. `off`:
   * no proxy is enabled.
   */
  status: 'ready' | 'unsupported' | 'unavailable' | 'off';
  providers: GatewayQuotaProvider[];
  /** The core verified the native Muse catalog and Responses route without running inference. */
  nativeMuse?: boolean;
  /** The gateway's own `updated_at`. */
  updatedAt: Timestamp | null;
  /** When the core last had an answer. */
  checkedAt: Timestamp | null;
  error: string | null;
}

/** Provider-reported limits, never inferred from Boite's token ledger. */
export interface AccountQuota extends QuotaReading {
  /**
   * Account id, or `proxy:<provider>:<entry>` for an entry of the subscription
   * gateway.
   */
  accountId: AccountId;
  providerId: ProviderId;
  providerName: string;
  label: string;
  enabled: boolean;
  status: 'ready' | 'unavailable' | 'unsupported' | 'disabled';
  /** A host's last observation, rather than a fresh account snapshot. */
  source?: 'observation';
  checkedAt: Timestamp | null;
  error: string | null;
  /** Set on a subscription gateway's entry: it is not a Boite account and has no switch. */
  gateway?: AccountQuotaGateway;
  /** The alerts set on this row, missing when none is. */
  alerts?: QuotaAlerts;
}

export interface AccountQuotaGateway {
  kind: SubscriptionProxy['kind'];
  entryId: string;
  display: GatewayQuotaProvider['display'];
  plan: string | null;
  accounts: number;
  status: GatewayQuotaEntry['status'];
  credits: GatewayQuotaCredit[];
}

export type QuotaResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

export interface QuotaResetResult {
  outcome: QuotaResetOutcome;
  /** The account reading after the provider answered, possibly stale if refresh failed. */
  quota: AccountQuota;
}

export interface Account {
  id: AccountId;
  providerId: ProviderId;
  label: string;
  /** Null means the provider's own default location (the user's real login). */
  isolationDir: string | null;
  status: AccountStatus;
  identity: string | null;
  createdAt: Timestamp;
}

export interface AccountsRpcMethods {
  'quotas.list': { params: { refresh?: boolean; requestId?: string }; result: AccountQuota[] };
  'quotas.configure': { params: { accountId: AccountId; enabled: boolean }; result: AccountQuota[] };
  /**
   * Every share left, in whole percent, at which a window of this period
   * notifies (`quotaAlertThresholds`); an empty list turns the period off.
   * Takes an account or a gateway entry (`proxy:<provider>:<entry>`) the list
   * holds now, or one that still has alerts, to turn them off.
   */
  'quotas.alert': { params: { accountId: AccountId; period: QuotaAlertPeriod; thresholds: number[] }; result: AccountQuota[] };
  /** Owner-only: consumes a banked reset after an explicit client confirmation. */
  'quotas.reset': { params: { accountId: AccountId; confirmed: true }; result: QuotaResetResult };

  'accounts.list': { params: Record<string, never>; result: Account[] };
  'accounts.add': {
    params: { providerId: ProviderId; label: string; useDefaultLocation?: boolean };
    result: Account;
  };
  /** How many top-level conversations still name the account, archived ones included: what a removal warns about. */
  'accounts.threads': { params: { accountId: AccountId }; result: { count: number } };
  /**
   * Removing a default CLI account prevents automatic adoption; an explicit add
   * can restore it. Refused while a turn runs on the account. Conversations that
   * name it stay, and refuse to send until another account is chosen in them.
   */
  'accounts.remove': { params: { accountId: AccountId }; result: { ok: true } };
  'accounts.rename': { params: { accountId: AccountId; label: string }; result: Account };
  /** Refresh the provider's login when requested; never uses a model catalogue as authentication. */
  'accounts.check': { params: { accountId: AccountId; refresh?: boolean }; result: Account };
  /**
   * Start the provider's login command for this account. Refused when the
   * provider has no `login` block, when the account uses the provider's own
   * location, or when a login is already running for it. Progress arrives as
   * `account.login`.
   */
  'accounts.login': { params: { accountId: AccountId }; result: { ok: true } };
  /** Current login state, used to rebuild cards after reconnecting. */
  'accounts.logins': { params: Record<string, never>; result: RpcEvents['account.login'][] };
  /** Stop the login process tree and wait for its exit. */
  'accounts.loginCancel': { params: { accountId: AccountId }; result: { ok: true } };
  /** One line into the running login's stdin, for a CLI that asks for a code. */
  'accounts.loginInput': { params: { accountId: AccountId; text: string }; result: { ok: true } };
  /**
   * Open a shell with this account's environment and type its login command
   * into it, or attach to the one already open. Only for a login whose
   * descriptor says `terminal`. The default account is allowed: the user drives
   * the shell, as in their own terminal. Closing the terminal rechecks the account.
   */
  'accounts.loginTerminal': { params: { accountId: AccountId; cols: number; rows: number }; result: TerminalState };
}

export interface AccountsRpcEvents {
  'quotas.updated': AccountQuota[];
  /** Owner-only partial result, correlated with the caller's quotas.list request. */
  'quotas.progress': { requestId: string; quota: AccountQuota };
  /** A window crossed its alert threshold: once per window, until it resets or falls back. */
  'quotas.alerted': QuotaAlert;
  'accounts.updated': Account;
  /** An account `accounts.remove` deleted. */
  'accounts.removed': { accountId: AccountId };
  /**
   * The login process starting, one line of its output, or its exit. `url`
   * carries the first `https://` link seen in the output, once there is one.
   * On exit the core rechecks the account and follows with `accounts.updated`.
   */
  'account.login': {
    accountId: AccountId;
    state: 'running' | 'done' | 'failed';
    output: string;
    url: string | null;
    exitCode: number | null;
  };
}
