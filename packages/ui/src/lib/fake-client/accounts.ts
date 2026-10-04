/** Accounts, their quotas and the fake sign-in a login runs. */
import { RpcErrorCode, subscriptionProxyOf, type Account, type AccountQuota, type GatewayQuotaEntry, type QuotaWindow, type RpcEvents, type SubscriptionProxyQuotas } from '@boite/contracts';
import { RpcFailure } from '../client';
import { sessionStatus } from './checks';
import { DATA_DIR } from './shared';
import type { FakeContext, FakeMethods } from './context';

/** What OpenCode's menu looks like once the command is typed: the capture shows the real thing's shape. */
const FAKE_LOGIN_MENU = [
  '\x1b[90m┌\x1b[39m  Add credential',
  '\x1b[90m│\x1b[39m',
  '\x1b[36m◆\x1b[39m  Select provider',
  '\x1b[36m│\x1b[39m  \x1b[32m●\x1b[39m OpenCode Zen \x1b[90m(recommended)\x1b[39m',
  '\x1b[36m│\x1b[39m  ○ OpenAI',
  '\x1b[36m│\x1b[39m  ○ GitHub Copilot',
  '\x1b[36m│\x1b[39m  ○ Anthropic',
  '\x1b[36m│\x1b[39m  ○ Google',
  '\x1b[36m└\x1b[39m',
  ''
].join('\r\n');

/** What a Douane with the quotas route reports, as the core maps it. */
export function gatewayQuotas(ctx: FakeContext): SubscriptionProxyQuotas {
  const proxy = ctx.settings.subscriptionProxy;
  if (!proxy?.enabled) return { status: 'off', providers: [], updatedAt: null, checkedAt: null, error: null };
  if (proxy.kind !== 'douane') return { status: 'unsupported', providers: [], updatedAt: null, checkedAt: null, error: null };
  const now = Date.now();
  const window = (id: string, label: string, usedPercent: number, hours: number) => ({ id, label, usedPercent, resetsAt: now + hours * 3600_000 });
  const entry = (id: string, label: string, plan: string | null, windows: QuotaWindow[], more: Partial<GatewayQuotaEntry> = {}): GatewayQuotaEntry =>
    ({ id, label, plan, accounts: 1, status: 'ready', error: null, updatedAt: now, windows, credits: [], ...more });
  return { status: 'ready', updatedAt: now, checkedAt: now, error: null, providers: [
    { providerId: 'claude', name: 'Claude', display: 'accounts', entries: [
      entry('claude-1', 'Claude Max x20 · chris@…', 'Max 20x', [window('five-hour', '5 hours', 11, 2), window('seven-day', 'Weekly', 64, 70)]),
      entry('claude-2', 'Claude Pro · work@…', 'Pro', [window('five-hour', '5 hours', 100, 1), window('seven-day', 'Weekly', 82, 30)], { status: 'cooldown' }),
    ] },
    { providerId: 'codex', name: 'Codex', display: 'accounts', entries: [
      entry('codex-1', 'ChatGPT Plus · chris@…', 'Plus', [window('five-hour', '5 hours', 37, 3)],
        { credits: [{ id: 'codex-credits', label: 'Credits', unit: 'credits', remaining: 62500, limit: null, used: null }] }),
    ] },
    { providerId: 'antigravity', name: 'Antigravity', display: 'average', entries: [
      entry('antigravity', 'Antigravity · 10 comptes', null, [window('gemini-pro', 'Gemini Pro', 42, 4), window('claude', 'Claude', 18, 4)], { accounts: 10 }),
    ] },
  ] };
}

/** The entries as limit rows, the core's `GatewayQuotas.rows`. */
function gatewayRows(state: SubscriptionProxyQuotas): AccountQuota[] {
  const stale = state.status === 'unavailable';
  return state.providers.flatMap(provider => provider.entries.map((entry): AccountQuota => ({
    accountId: `proxy:${provider.providerId}:${entry.id}`, providerId: provider.providerId, providerName: provider.name, label: entry.label, enabled: true,
    status: stale || entry.status === 'error' ? 'unavailable' : 'ready', windows: entry.windows, checkedAt: entry.updatedAt ?? state.checkedAt,
    error: stale ? state.error : entry.error,
    gateway: { kind: 'douane', entryId: entry.id, display: provider.display, plan: entry.plan, accounts: entry.accounts, status: entry.status, credits: entry.credits },
  })));
}

function quotas(ctx: FakeContext): AccountQuota[] {
  return [...accountQuotas(ctx), ...gatewayRows(gatewayQuotas(ctx))];
}

function accountQuotas(ctx: FakeContext): AccountQuota[] {
  const accounts = [...ctx.accounts, { id: 'quota:antigravity-cli', providerId: 'antigravity', label: 'Antigravity CLI' }];
  const proxied = (providerId: string) => subscriptionProxyOf(ctx.settings, ctx.providers.find(provider => provider.id === providerId)?.protocol) !== null;
  return accounts.map((account, index) => ({
    ...(ctx.quotaExtras && ctx.quotaEnabled[account.id] !== false && ['claude', 'codex'].includes(account.providerId) ? {
      resetCredits: { availableCount: Math.max(0, (account.providerId === 'claude' ? 1 : 2) - (ctx.quotaResetsUsed[account.id] ?? 0)), nextExpiresAt: Date.now() + 7 * 86400_000 },
      credits: account.providerId === 'claude'
        ? { kind: 'budget' as const, enabled: true, remaining: 75, limit: 100, unlimited: false }
        : { kind: 'balance' as const, enabled: null, remaining: 42, limit: null, unlimited: false },
    } : {}),
    accountId: account.id, providerId: account.providerId, providerName: account.providerId === 'opencode' ? 'OpenCode Go' : ctx.providers.find((p) => p.id === account.providerId)?.name ?? account.providerId,
    label: account.label, enabled: account.id === 'quota:antigravity-cli' ? ctx.quotaEnabled[account.id] === true : ctx.quotaEnabled[account.id] !== false,
    // The CLI's own account reports nothing: its limits come from the `quota:antigravity-cli` source.
    status: proxied(account.providerId) || account.providerId === 'echo' || account.providerId === 'pi' || account.providerId === 'antigravity-cli' || account.id === 'a-antigravity' ? 'unsupported' : ctx.quotaEnabled[account.id] === false || account.id === 'quota:antigravity-cli' && ctx.quotaEnabled[account.id] !== true ? 'disabled' : 'ready',
    checkedAt: Date.now(), error: null,
    windows: proxied(account.providerId) || ctx.quotaEnabled[account.id] === false || account.id === 'quota:antigravity-cli' && ctx.quotaEnabled[account.id] !== true ? [] : (ctx.quotaResetsUsed[account.id] ?? 0) > 0 ? [
      { id: 'primary', label: '5 hours', usedPercent: 0, resetsAt: null },
      { id: 'secondary', label: 'Weekly', usedPercent: 0, resetsAt: null },
    ] : [
      { id: 'primary', label: '5 hours', usedPercent: ctx.quotaExtras && ['claude', 'codex'].includes(account.providerId) ? 100 : [32, 87, 14, 48, 71, 6, 23, 40][index % 8]!, resetsAt: Date.now() + (1 + index % 4) * 3600_000 },
      { id: 'secondary', label: 'Weekly', usedPercent: [61, 94, 38, 27, 55, 12, 73, 66][index % 8]!, resetsAt: Date.now() + (1 + index % 6) * 86400_000 },
      // Claude also reports a weekly window per model, which the core names `Weekly · <model>`.
      ...(account.providerId === 'claude' ? [{ id: 'model:Opus', label: 'Weekly · Opus', usedPercent: 44, resetsAt: Date.now() + 3 * 86400_000 }] : []),
    ],
  }));
}

function loginEvent(ctx: FakeContext, event: RpcEvents['account.login']): void {
  if (event.state === 'running') {
    const existing = ctx.logins.get(event.accountId);
    ctx.logins.set(event.accountId, existing ? Object.assign(existing, event) : event);
  } else ctx.logins.delete(event.accountId);
  ctx.emit('account.login', structuredClone(event));
}

/**
 * As the core's `loginCancel`: the sign-in terminal closes without signing
 * anyone in, the killed login ends as failed, and the account is read again.
 */
function cancelLogin(ctx: FakeContext, accountId: string): void {
  const terminal = `login:${accountId}`;
  if (ctx.terminals.delete(terminal)) ctx.emit('terminal.exited', { id: terminal, exitCode: 1 });
  const running = ctx.logins.get(accountId);
  if (!running) return;
  loginEvent(ctx, { accountId, state: 'failed', output: running.output, url: running.url, exitCode: 1 });
  const account = ctx.accounts.find((a) => a.id === accountId);
  if (!account) return;
  account.status = sessionStatus(ctx.providers.find((p) => p.id === account.providerId), account, account.identity !== null);
  ctx.emit('accounts.updated', structuredClone(account));
}

/** What a provider CLI prints first: a link to open, then a question. */
async function fakeLoginPrompt(ctx: FakeContext, accountId: string): Promise<void> {
  const active = ctx.logins.get(accountId);
  await ctx.pause();
  if (!active || ctx.logins.get(accountId) !== active) return;
  const account = ctx.accounts.find(a => a.id === accountId);
  const provider = ctx.providers.find(p => p.id === account?.providerId);
  loginEvent(ctx, {
    accountId,
    state: 'running',
    output: provider?.login && provider.login.kind === 'device' ? 'https://example.invalid/login?code=fake\nTEST-CODE' : 'Open https://example.invalid/login?code=fake to continue',
    url: 'https://example.invalid/login?code=fake',
    exitCode: null
  });
}

async function finishFakeLogin(ctx: FakeContext, account: Account): Promise<void> {
  const active = ctx.logins.get(account.id);
  await ctx.pause();
  if (!active || ctx.logins.get(account.id) !== active) return;
  loginEvent(ctx, {
    accountId: account.id,
    state: 'done',
    output: 'logged in',
    url: 'https://example.invalid/login?code=fake',
    exitCode: 0
  });
  account.status = 'ok';
  account.identity = 'you@example.com';
  ctx.emit('accounts.updated', structuredClone(account));
}

export function accountMethods(ctx: FakeContext) {
  return {
    'quotas.reset': async (params) => {
      if (params.confirmed !== true) throw new RpcFailure({ code: RpcErrorCode.InvalidParams,
        message: 'quotas.reset confirmed must be true after user confirmation', data: { field: 'confirmed', expected: true } });
      const account = ctx.accounts.find(account => account.id === params.accountId);
      if (!account) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `unknown account ${params.accountId}`, data: { accountId: params.accountId } });
      if (!['claude', 'codex'].includes(account.providerId)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `Banked resets are not supported for ${account.providerId}.` });
      if (account.status === 'unauthenticated') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Sign in to this account before using a reset.' });
      if (ctx.quotaEnabled[account.id] === false) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Enable quota monitoring for this account before using a reset.' });
      const before = quotas(ctx).find(row => row.accountId === account.id)!;
      const outcome = !before.resetCredits?.availableCount ? 'noCredit' : before.windows.every(window => window.usedPercent < 100) ? 'nothingToReset' : 'reset';
      if (outcome === 'reset') ctx.quotaResetsUsed[account.id] = (ctx.quotaResetsUsed[account.id] ?? 0) + 1;
      const rows = quotas(ctx);
      ctx.emit('quotas.updated', rows);
      return { outcome, quota: rows.find(row => row.accountId === account.id)! };
    },
    'quotas.configure': async (params) => {
      ctx.quotaEnabled[params.accountId] = params.enabled;
      const rows = quotas(ctx); ctx.emit('quotas.updated', rows); return rows;
    },
    'quotas.list': async (params) => {
      if (params.requestId !== undefined && (typeof params.requestId !== 'string' || !params.requestId || params.requestId.length > 128)) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'quotas.list requestId must be a non-empty string of at most 128 characters' });
      }
      const rows = quotas(ctx);
      for (const quota of rows) {
        if (params.requestId) ctx.emit('quotas.progress', { requestId: params.requestId, quota });
      }
      if (ctx.settings.subscriptionProxy?.enabled && ctx.settings.subscriptionProxy.kind === 'douane') ctx.emit('subscriptionProxy.quotasUpdated', gatewayQuotas(ctx));
      return rows;
    },
    'subscriptionProxy.quotas': async (params) => {
      if (params.refresh !== undefined && typeof params.refresh !== 'boolean') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'subscriptionProxy.quotas refresh must be a boolean' });
      return gatewayQuotas(ctx);
    },
    'accounts.list': async (params) => {
      return structuredClone(ctx.accounts);
    },
    'accounts.add': async (params) => {
      const provider = ctx.providers.find((p) => p.id === params.providerId);
      if (!provider) throw ctx.notFound('provider', params.providerId);
      const id = `a-${++ctx.seq}`;
      const account: Account = {
        id,
        providerId: params.providerId,
        label: params.label.length > 0 ? params.label : 'Account',
        isolationDir: params.useDefaultLocation && !provider.alwaysIsolated ? null : `${DATA_DIR}\\accounts\\${id}`,
        status: 'unknown',
        identity: null,
        createdAt: ctx.now()
      };
      // As the core's `check`: a fresh isolated account is signed out until a login runs in it.
      account.status = sessionStatus(provider, account, false);
      account.identity = account.status === 'ok' ? 'you@example.com' : null;
      ctx.accounts.push(account);
      if (account.isolationDir === null) ctx.removedDefaultProviders.delete(account.providerId);
      ctx.emit('accounts.updated', structuredClone(account));
      return structuredClone(account);
    },
    'accounts.rename': async (params) => {
      const account = ctx.accounts.find(a => a.id === params.accountId);
      if (!account) throw ctx.notFound('account', params.accountId);
      if (typeof params.label !== 'string' || !params.label.trim() || params.label.trim().length > 100) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'label must contain 1 to 100 characters', data: { field: 'label', expected: '1 to 100 characters' } });
      }
      account.label = params.label.trim();
      ctx.emit('accounts.updated', structuredClone(account));
      return structuredClone(account);
    },
    'accounts.threads': async (params) => {
      if (!ctx.accounts.some(a => a.id === params.accountId)) throw ctx.notFound('account', params.accountId);
      return { count: [...ctx.threads.values()].filter((t) => t.accountId === params.accountId && !t.parentThreadId).length };
    },
    'accounts.remove': async (params) => {
      const account = ctx.accounts.find(a => a.id === params.accountId);
      if (!account) throw ctx.notFound('account', params.accountId);
      // As the core: only a turn in flight keeps the account, a conversation that names it does not.
      const busy = [...ctx.threads.values()].some((t) => t.accountId === params.accountId && (['queued', 'running', 'waiting'].includes(t.status) || ctx.inFlight.has(t.id)));
      if (busy) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this account is running a turn; stop it or wait for it before removing the account', data: { accountId: params.accountId } });
      }
      cancelLogin(ctx, params.accountId);
      if (account.isolationDir === null) ctx.removedDefaultProviders.add(account.providerId);
      ctx.accounts = ctx.accounts.filter((a) => a.id !== params.accountId);
      ctx.emit('accounts.removed', { accountId: params.accountId });
      return { ok: true };
    },
    'accounts.check': async (params) => {
      const account = ctx.accounts.find((a) => a.id === params.accountId);
      if (!account) throw ctx.notFound('account', params.accountId);
      // A finished login left an identity behind: the session it wrote is still there.
      const status = sessionStatus(ctx.providers.find((p) => p.id === account.providerId), account, account.identity !== null);
      // As the core: an unchanged status writes nothing and tells nobody.
      if (status === account.status) return structuredClone(account);
      account.status = status;
      account.identity = status === 'ok' ? 'you@example.com' : null;
      ctx.emit('accounts.updated', structuredClone(account));
      return structuredClone(account);
    },
    'accounts.login': async (params) => {
      const account = ctx.accounts.find((a) => a.id === params.accountId);
      if (!account) throw ctx.notFound('account', params.accountId);
      const provider = ctx.providers.find((p) => p.id === account.providerId);
      if (!provider?.available || !provider.login) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: `login is not available for ${account.providerId}` });
      }
      if (account.isolationDir === null) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: `${account.label} uses the provider's own location: log it in with your own CLI, outside Boite`
        });
      }
      if (ctx.logins.has(account.id) || ctx.terminals.has(`login:${account.id}`)) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: `a login is already running for ${account.label}`
        });
      }
      loginEvent(ctx, {
        accountId: account.id,
        state: 'running',
        output: '',
        url: null,
        exitCode: null
      });
      void fakeLoginPrompt(ctx, account.id).then(async () => {
        if (provider.login && provider.login.kind === 'device') await finishFakeLogin(ctx, account);
      });
      return { ok: true };
    },
    'accounts.logins': async (params) => {
      return structuredClone([...ctx.logins.values()]);
    },
    'accounts.loginCancel': async (params) => {
      if (!ctx.accounts.some((a) => a.id === params.accountId)) throw ctx.notFound('account', params.accountId);
      cancelLogin(ctx, params.accountId);
      return { ok: true };
    },
    'accounts.loginInput': async (params) => {
      const account = ctx.accounts.find((a) => a.id === params.accountId);
      if (!account) throw ctx.notFound('account', params.accountId);
      if (!ctx.logins.has(account.id)) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: `no login is running for ${account.id}`
        });
      }
      void finishFakeLogin(ctx, account);
      return { ok: true };
    },
    'accounts.loginTerminal': async (params) => {
      const account = ctx.accounts.find((a) => a.id === params.accountId);
      if (!account) throw ctx.notFound('account', params.accountId);
      const provider = ctx.providers.find((p) => p.id === account.providerId);
      if (!provider?.login || provider.login.kind !== 'terminal') {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${provider?.name ?? account.providerId} does not sign in from a terminal` });
      }
      const id = `login:${account.id}`;
      const cwd = account.isolationDir ?? 'C:\\Users\\you';
      if (!ctx.terminals.has(id)) {
        ctx.terminals.set(id, { cwd, output: `PS ${cwd}> & ${provider.id} auth login\r\n${FAKE_LOGIN_MENU}`, line: '' });
      }
      const shell = ctx.terminals.get(id)!;
      return { id, cwd: shell.cwd, output: shell.output };
    },
  } satisfies Partial<FakeMethods>;
}
