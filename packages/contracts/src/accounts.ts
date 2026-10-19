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
  /** The gateway's own `updated_at`. */
  updatedAt: Timestamp | null;
  /** When the core last had an answer. */
  checkedAt: Timestamp | null;
  error: string | null;
}

/** Provider-reported limits, never inferred from Boite's token ledger. */
export interface AccountQuota extends QuotaReading {
  /**
   * Account id, `quota:antigravity-cli` for the agy login's quota source (on by
   * default once agy is found), or
   * `proxy:<provider>:<entry>` for an entry of the subscription gateway.
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
