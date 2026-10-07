import { OPENCODE_V2, openCode2Key } from './providers/opencode.ts';
import { readFile, mkdtemp } from 'node:fs/promises';
import { removeDir } from './fs-retry.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Account, QuotaWindow } from '@boite/contracts';
import type { Core } from './core.ts';
import { homePath } from './paths.ts';
import { hostAgentsEnabled } from './providers/resolve.ts';
import { grokQuotaToken } from './grok-quota-auth.ts';

export const ANTIGRAVITY_QUOTA_ID = 'quota:antigravity-cli';
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

export function antigravityQuotaWindows(raw: unknown): QuotaWindow[] {
  const root = obj(raw), command = obj(root['command']);
  if (root['status'] !== 'SUCCESS' || command['name'] !== 'usage') throw new Error('Antigravity did not return a successful usage report. Sign in with agy and retry.');
  const groups = obj(command['data'])['groups'];
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((rawGroup, groupIndex) => {
    const group = obj(rawGroup), buckets = group['buckets'];
    if (!Array.isArray(buckets)) return [];
    return buckets.flatMap((rawBucket) => {
      const bucket = obj(rawBucket), remaining = bucket['remaining_fraction'];
      if (bucket['disabled'] === true || typeof bucket['id'] !== 'string' || typeof remaining !== 'number' || remaining < 0 || remaining > 1) return [];
      const period = bucket['window'] === '5h' ? '5 hours' : bucket['window'] === 'weekly' ? 'Weekly' : String(bucket['name'] ?? bucket['id']);
      return limit(`${groupIndex}:${bucket['id']}`, `${String(group['name'] ?? 'Models')} · ${period}`, (1 - remaining) * 100, bucket['reset_time']);
    });
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

export async function readExtraQuota(core: Core, account: Account): Promise<QuotaWindow[]> {
  if (account.id === ANTIGRAVITY_QUOTA_ID) return readAntigravity(core);
  const env = core.accounts.accountEnv(account, core.providers.require(account.providerId));
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
  if (!token) throw new Error('Connect OpenCode Go with opencode auth login, then refresh.');
  return openCodeQuotaWindows(await request('https://opencode.ai/zen/go/v1/usage', token, 'OpenCode Go'));
}

export function supportsAntigravityUsage(version: string): boolean {
  const match = version.trim().match(/^(?:agy\s+)?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  return major > 1 || major === 1 && (minor > 1 || minor === 1 && patch >= 11);
}

async function readAntigravity(core: Core): Promise<QuotaWindow[]> {
  const installed = join(process.env['LOCALAPPDATA'] ?? join(homePath(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe');
  const executable = !hostAgentsEnabled() ? null : Bun.which('agy') ?? (process.platform === 'win32' && existsSync(installed) ? installed : null);
  if (!executable) throw new Error('Install Antigravity CLI 1.1.11 or later, run agy to sign in, then refresh.');
  const cwd = await mkdtemp(join(tmpdir(), 'boite-agy-quota-'));
  const threadId = ANTIGRAVITY_QUOTA_ID;
  const run = (args: string[], timeout: number) => new Promise<string>((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
    delete env['ANTIGRAVITY_OAUTH_CREDENTIALS_JSON'];
    const child = core.procs.spawnChild(threadId, executable, args, { cwd, env });
    let output = '', bytes = 0, failure = '';
    const timer = setTimeout(() => { failure = 'Antigravity usage timed out. Open agy to check its login, then retry.'; core.procs.killTree(threadId); }, timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { failure = 'Antigravity usage response exceeded 1 MiB.'; core.procs.killTree(threadId); }
      else output += chunk.toString();
    });
    child.stderr.resume();
    child.stdin.end();
    child.once('error', () => { clearTimeout(timer); reject(new Error('Antigravity CLI could not start. Check its installation.')); });
    child.once('close', (code) => { clearTimeout(timer); if (failure || code !== 0) reject(new Error(failure || 'Antigravity could not read usage. Run agy to sign in, then refresh.')); else resolve(output); });
  });
  try {
    if (!supportsAntigravityUsage(await run(['--version'], 10_000))) throw new Error('Update Antigravity CLI to 1.1.11 or later to read usage.');
    const output = await run(['-p', '/usage', '--output-format', 'json', '--print-timeout', '90s'], 95_000);
    let report: unknown;
    try { report = JSON.parse(output); } catch { throw new Error('Antigravity returned an invalid usage report.'); }
    return antigravityQuotaWindows(report);
  } finally {
    await core.procs.stopAndWait(threadId).catch((error: unknown) => core.log('warn', `antigravity quota: ${error instanceof Error ? error.message : String(error)}`));
    await removeDir(cwd, (message) => core.log('warn', `antigravity quota: ${message}`));
  }
}
