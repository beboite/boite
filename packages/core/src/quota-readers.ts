import { OPENCODE_V2, openCode2Key } from './providers/opencode.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Account, ProviderDescriptor, QuotaWindow } from '@boite/contracts';
import { readAntigravityQuota } from './antigravity-quota.ts';
import type { Core } from './core.ts';
import { homePath } from './paths.ts';
import { grokQuotaToken } from './grok-quota-auth.ts';

const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function limit(id: string, label: string, percent: unknown, reset: unknown): QuotaWindow[] {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return [];
  const at = typeof reset === 'number' ? reset < 1e12 ? reset * 1000 : reset : typeof reset === 'string' ? Date.parse(reset) : NaN;
  return [{ id, label, usedPercent: Math.max(0, Math.min(100, percent)), resetsAt: Number.isFinite(at) ? at : null }];
}

export function grokQuotaWindows(raw: unknown): QuotaWindow[] {
  const config = obj(obj(raw)['config']);
  const periodEnd = obj(config['currentPeriod'])['end'];
  let percent = config['creditUsagePercent'];
  if (percent === undefined) {
    const budget = obj(config['monthlyLimit'])['val'];
    const used = config['used'];
    const amount = used !== null && typeof used === 'object' && !Array.isArray(used) ? obj(used)['val'] ?? 0 : undefined;
    if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0 && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) percent = amount / budget * 100;
    // The credits endpoint omits proto3 zero scalars, but reported legacy
    // amounts take precedence over that default when both field sets coexist.
    else if (typeof periodEnd === 'string' && Number.isFinite(Date.parse(periodEnd))) percent = 0;
  }
  return limit('credits', 'Credits', percent, periodEnd ?? config['billingPeriodEnd']);
}

export function openCodeQuotaWindows(raw: unknown, now = Date.now()): QuotaWindow[] {
  const usage = obj(obj(raw)['usage']);
  return Object.entries({ rolling: '5 hours', weekly: 'Weekly', monthly: 'Monthly' }).flatMap(([id, label]) => {
    const value = obj(usage[id]);
    const relative = value['resetInSec'];
    return limit(id, label, value['percent'], typeof relative === 'number' && relative >= 0 ? now + relative * 1000 : value['resetAt'] ?? value['resetsAt']);
  });
}

async function credentials(path: string, name: string): Promise<Record<string, unknown>> {
  try { return obj(JSON.parse(await readFile(path, 'utf8'))); }
  catch { throw new Error(`${name} login could not be read. Connect the account in Providers.`); }
}

class RejectedQuotaToken extends Error {}

async function request(url: string, token: string, name: string, headers: Record<string, string> = {}): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error(`${name} usage request failed. Check the connection and retry.`); }
  if (response.status === 401) throw new RejectedQuotaToken(`${name} login expired or has no subscription access. Reconnect in Providers.`);
  if (response.status === 403) throw new Error(`${name} login expired or has no subscription access. Reconnect in Providers.`);
  if (!response.ok) throw new Error(`${name} usage returned HTTP ${response.status}. Retry in five minutes.`);
  try { return await response.json(); } catch { throw new Error(`${name} returned an invalid usage response.`); }
}

/** An account of the managed Antigravity server, whose limits come from its own sign-in file. */
export function readsAntigravitySignIn(provider: ProviderDescriptor | undefined): boolean {
  return provider?.quirks?.includes('antigravity') === true;
}

export async function readExtraQuota(core: Core, account: Account): Promise<QuotaWindow[]> {
  const provider = core.providers.require(account.providerId);
  const env = core.accounts.accountEnv(account, provider);
  if (readsAntigravitySignIn(provider)) {
    const home = env['GEMINI_HOME'] ?? account.isolationDir;
    if (!home) throw new Error('Sign in to Antigravity in Providers to see its limits.');
    return readAntigravityQuota(home);
  }
  if (account.providerId === 'grok') {
    const root = env['GROK_HOME'] ?? process.env['GROK_HOME'] ?? join(homePath(), '.grok');
    const path = join(root, 'auth.json');
    const token = await grokQuotaToken(path);
    const read = (key: string) => request('https://cli-chat-proxy.grok.com/v1/billing?format=credits', key, 'Grok', { 'x-xai-token-auth': 'xai-grok-cli' });
    let report: unknown;
    try { report = await read(token.key); }
    catch (error) {
      if (!(error instanceof RejectedQuotaToken)) throw error;
      report = await read((await grokQuotaToken(path, token)).key);
    }
    return grokQuotaWindows(report);
  }
  const root = env['XDG_DATA_HOME'] ?? process.env['XDG_DATA_HOME'] ?? join(homePath(), '.local', 'share');
  // Isolated accounts never borrow an API key from the host environment.
  let token = account.isolationDir === null ? process.env['OPENCODE_API_KEY'] : undefined;
  if (!token && account.providerId === OPENCODE_V2) {
    // OpenCode 2 keeps its sign-ins in its database, never in auth.json.
    token = openCode2Key(root, 'opencode-go') ?? undefined;
  } else if (!token) {
    const auth = await credentials(join(root, 'opencode', 'auth.json'), 'OpenCode Go');
    const login = obj(auth['opencode-go']);
    if (login['type'] === 'api' && typeof login['key'] === 'string') token = login['key'];
  }
  if (!token) {
    throw new Error(account.providerId === OPENCODE_V2
      ? 'Connect OpenCode Go with opencode2 auth login --standalone, then refresh.'
      : 'Connect OpenCode Go with opencode auth login, then refresh.');
  }
  return openCodeQuotaWindows(await request('https://opencode.ai/zen/go/v1/usage', token, 'OpenCode Go'));
}

