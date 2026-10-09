/** Accounts, their quotas and the fake sign-in a login runs. */
import { RpcErrorCode, type Account, type AccountQuota, type RpcEvents } from '@boite/contracts';
import { RpcFailure } from '../client';
import { sessionStatus } from './checks';
import { moveToAccount, otherAccounts } from './account-fallback';
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

function quotas(ctx: FakeContext): AccountQuota[] {
  const accounts = [...ctx.accounts, { id: 'quota:antigravity-cli', providerId: 'antigravity', label: 'Antigravity CLI' }];
  return accounts.map((account, index) => ({
    accountId: account.id, providerId: account.providerId, providerName: account.providerId === 'opencode' ? 'OpenCode Go' : ctx.providers.find((p) => p.id === account.providerId)?.name ?? account.providerId,
    label: account.label, enabled: account.id === 'quota:antigravity-cli' ? ctx.quotaEnabled[account.id] === true : ctx.quotaEnabled[account.id] !== false,
    // The CLI's own account reports nothing: its limits come from the `quota:antigravity-cli` source.
    status: account.providerId === 'echo' || account.providerId === 'pi' || account.providerId === 'antigravity-cli' || account.id === 'a-antigravity' ? 'unsupported' : ctx.quotaEnabled[account.id] === false || account.id === 'quota:antigravity-cli' && ctx.quotaEnabled[account.id] !== true ? 'disabled' : 'ready',
    checkedAt: Date.now(), error: null,
    windows: ctx.quotaEnabled[account.id] === false || account.id === 'quota:antigravity-cli' && ctx.quotaEnabled[account.id] !== true ? [] : [
      { id: 'primary', label: '5 hours', usedPercent: [32, 87, 14, 48, 71, 6, 23, 40][index % 8]!, resetsAt: Date.now() + (1 + index % 4) * 3600_000 },
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
      return rows;
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
    'accounts.remove': async (params) => {
      if (!ctx.accounts.some((a) => a.id === params.accountId)) throw ctx.notFound('account', params.accountId);
      const account = ctx.accounts.find((a) => a.id === params.accountId)!;
      const threads = [...ctx.threads.values()].filter((t) => t.accountId === params.accountId);
      if (threads.some((t) => ['queued', 'running', 'waiting'].includes(t.status) || ctx.inFlight.has(t.id))) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'a turn is running on this account; stop it before removing the account', data: { accountId: account.id } });
      }
      // As the core: its conversations move to another account of the agent, and the last account stays.
      const heir = otherAccounts(ctx, account.providerId, account.id)[0];
      if (threads.length > 0 && !heir) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${threads.length} conversation${threads.length === 1 ? ' uses' : 's use'} this account, the only one of its agent: sign in again, or add another account first and they move to it`, data: { accountId: account.id } });
      }
      cancelLogin(ctx, params.accountId);
      if (heir) for (const thread of threads) moveToAccount(ctx, thread, heir);
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
