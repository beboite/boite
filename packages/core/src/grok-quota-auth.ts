import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';

type Login = Record<string, unknown>;
interface QuotaToken { scope: string; key: string }
const pending = new Map<string, Promise<QuotaToken>>();
const missingLogin = () => new Error('Grok login is missing or expired. Run grok login --device-auth, then refresh.');
const object = (value: unknown): Login => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Login : {};
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function readAuth(path: string): Login {
  try { return object(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw new Error('Grok login could not be read. Connect the account in Providers.'); }
}

function current(login: Login, rejected?: string): boolean {
  if (!text(login['key']) || login['key'] === rejected) return false;
  return login['expires_at'] == null || typeof login['expires_at'] === 'string' && Date.parse(login['expires_at']) > Date.now();
}

function renewable(login: Login): boolean {
  return text(login['key']) && text(login['refresh_token']) && login['oidc_issuer'] === 'https://auth.x.ai'
    && text(login['oidc_client_id']) && (login['expires_at'] == null || typeof login['expires_at'] === 'string' && Number.isFinite(Date.parse(login['expires_at'])));
}

async function renew(login: Login): Promise<Login> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: login['refresh_token'] as string, client_id: login['oidc_client_id'] as string });
  for (const field of ['principal_type', 'principal_id']) if (text(login[field])) body.set(field, login[field]);
  let response: Response;
  try {
    // Never send a refresh token to a URL taken from the credentials file.
    response = await fetch('https://auth.x.ai/oauth2/token', {
      method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error('Grok login renewal failed. Check the connection and retry.'); }
  if (!response.ok) throw new Error(`Grok login renewal returned HTTP ${response.status}. ${response.status === 400 || response.status === 401 ? 'Run grok login --device-auth, then refresh.' : 'Retry in five minutes.'}`);
  let tokens: Login;
  try { tokens = object(await response.json()); }
  catch { throw new Error('Grok login renewal returned an invalid response.'); }
  const seconds = tokens['expires_in'];
  const expiry = typeof seconds === 'number' ? Date.now() + seconds * 1000 : null;
  if (!text(tokens['access_token']) || tokens['refresh_token'] != null && !text(tokens['refresh_token'])
    || seconds != null && (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isFinite(expiry) || expiry! > 8.64e15)) {
    throw new Error('Grok login renewal returned an invalid response.');
  }
  return { ...login, key: tokens['access_token'], refresh_token: tokens['refresh_token'] ?? login['refresh_token'],
    expires_at: expiry === null ? null : new Date(expiry).toISOString(), create_time: new Date().toISOString() };
}

function persist(path: string, scope: string, original: Login, renewed: Login): string {
  const auth = readAuth(path), latest = object(auth[scope]);
  // A CLI may have signed in or renewed while the request was in flight.
  if (['key', 'refresh_token', 'expires_at', 'create_time'].some((field) => latest[field] !== original[field])) {
    if (current(latest)) return latest['key'] as string;
    throw new Error('Grok login changed during renewal. Refresh to read the current login.');
  }
  auth[scope] = { ...latest, key: renewed['key'], refresh_token: renewed['refresh_token'], expires_at: renewed['expires_at'], create_time: renewed['create_time'] };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(auth, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch { throw new Error('Grok login renewal could not save auth.json. Check its permissions and refresh.'); }
  finally { try { unlinkSync(temporary); } catch { /* The rename already removed it. */ } }
  return renewed['key'] as string;
}

async function tokenFromFile(path: string, rejected?: QuotaToken): Promise<QuotaToken> {
  const entries = Object.entries(readAuth(path))
    .filter(([scope]) => scope.startsWith('https://auth.x.ai::') || scope === 'https://accounts.x.ai/sign-in')
    .filter(([scope]) => rejected === undefined || scope === rejected.scope)
    .sort(([a], [b]) => Number(b.startsWith('https://auth.x.ai::')) - Number(a.startsWith('https://auth.x.ai::')))
    .map(([scope, value]) => ({ scope, login: object(value) }));
  const fresh = entries.find(({ login }) => current(login, rejected?.key));
  if (fresh) return { scope: fresh.scope, key: fresh.login['key'] as string };
  const stale = entries.find(({ login }) => renewable(login));
  if (!stale) throw missingLogin();
  return { scope: stale.scope, key: persist(path, stale.scope, stale.login, await renew(stale.login)) };
}

/** Share renewal by the actual auth file, including linked GROK_HOME directories. */
export async function grokQuotaToken(authPath: string, rejected?: QuotaToken): Promise<QuotaToken> {
  let path: string;
  try { path = await realpath(authPath); }
  catch { throw new Error('Grok login could not be read. Connect the account in Providers.'); }
  const existing = pending.get(path);
  if (existing) {
    const token = await existing;
    if (rejected === undefined || token.scope === rejected.scope && token.key !== rejected.key) return token;
    return grokQuotaToken(path, rejected);
  }
  const reading = tokenFromFile(path, rejected);
  pending.set(path, reading);
  try { return await reading; }
  finally { if (pending.get(path) === reading) pending.delete(path); }
}
