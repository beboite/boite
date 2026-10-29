/**
 * The subscription limits of a signed-in Antigravity account, read over HTTP
 * from the sign-in the managed server keeps under its `GEMINI_HOME`. Nothing is
 * spawned: one launch of that server unpacks 1.2 GB before it answers.
 *
 * The file holds a Google refresh token with the OAuth client it was issued to.
 * It is traded for an access token, kept in memory until a minute before it
 * expires, and the quota summary is asked of the Cloud Code endpoints the
 * agent itself talks to. An account whose summary is empty falls back to the
 * per-model quotas older accounts report.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QuotaWindow } from '@boite/contracts';

/** Where the server writes its sign-in, under `GEMINI_HOME`. */
export const ANTIGRAVITY_TOKEN_FILE = join('antigravity-acp', 'acp_token.json');
const ENDPOINTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 10_000;
const FIVE_HOURS = '5 hours';

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function window(id: string, label: string, quota: Json): QuotaWindow[] {
  const remaining = quota['remainingFraction'];
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return [];
  const reset = typeof quota['resetTime'] === 'string' ? Date.parse(quota['resetTime']) : NaN;
  return [{ id, label, usedPercent: (1 - Math.max(0, Math.min(1, remaining))) * 100, resetsAt: Number.isFinite(reset) ? reset : null }];
}

/** `retrieveUserQuotaSummary`: one window per enabled bucket, named after its group and its period. */
export function antigravitySummaryWindows(raw: unknown): QuotaWindow[] {
  const root = obj(raw);
  const groups = Array.isArray(root['groups']) && root['groups'].some((group) => Array.isArray(obj(group)['buckets']) && (obj(group)['buckets'] as unknown[]).length > 0)
    ? root['groups'] as unknown[]
    : [{ buckets: root['buckets'] }];
  const windows = new Map<string, QuotaWindow>();
  for (const rawGroup of groups) {
    const group = obj(rawGroup);
    const buckets = Array.isArray(group['buckets']) ? group['buckets'] : [];
    for (const rawBucket of buckets) {
      const bucket = obj(rawBucket);
      const id = text(bucket['bucketId']);
      if (id === null || bucket['disabled'] === true) continue;
      const family = text(group['displayName'])
        ?? (id.startsWith('gemini-') ? 'Gemini' : id.startsWith('3p-') ? 'Claude and GPT' : id);
      const period = bucket['window'] === '5h' ? FIVE_HOURS : bucket['window'] === 'weekly' ? 'Weekly' : text(bucket['displayName']) ?? 'Quota';
      for (const row of window(id, `${family} · ${period}`, bucket)) windows.set(row.id, row);
    }
  }
  return [...windows.values()];
}

/** `fetchAvailableModels`: per-model quotas, the highest use of each family kept. No reset cadence is invented. */
export function antigravityModelWindows(raw: unknown): QuotaWindow[] {
  const windows = new Map<string, QuotaWindow>();
  for (const [modelId, rawModel] of Object.entries(obj(obj(raw)['models']))) {
    const model = obj(rawModel);
    const provider = model['modelProvider'];
    const family = provider === 'MODEL_PROVIDER_GOOGLE' || modelId.startsWith('gemini-') ? 'Gemini'
      : provider === 'MODEL_PROVIDER_ANTHROPIC' || modelId.startsWith('claude-') ? 'Claude'
        : provider === 'MODEL_PROVIDER_OPENAI' || modelId.startsWith('gpt-') ? 'GPT' : null;
    if (family === null) continue;
    for (const [suffix, label, quota] of [['quota', 'Quota', model['quotaInfo']], ['weekly', 'Weekly', model['weeklyQuotaInfo']]] as const) {
      for (const row of window(`${family.toLowerCase()}-${suffix}`, `${family} · ${label}`, obj(quota))) {
        const previous = windows.get(row.id);
        if (previous === undefined || row.usedPercent > previous.usedPercent) windows.set(row.id, row);
      }
    }
  }
  return [...windows.values()];
}

/** Access tokens by the sign-in they came from, so a new sign-in never reuses the previous one's. */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

/** Google refused the sign-in or the access token traded for it. */
class RejectedSignIn extends Error {
  constructor() { super('The Antigravity sign-in expired. Sign in again in Providers.'); }
}

async function json(fetchImpl: Fetch, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch { throw new Error('Antigravity usage request failed. Check the connection and retry.'); }
  if (response.status === 400 || response.status === 401) throw new RejectedSignIn();
  if (!response.ok) throw new Error(`Antigravity usage returned HTTP ${response.status}. Retry in five minutes.`);
  try { return await response.json(); } catch { throw new Error('Antigravity returned an invalid usage response.'); }
}

/**
 * The limits of the account whose server home is `home`. Throws a sentence the
 * Limits page can show: no sign-in, an expired one, or no usable answer.
 */
export async function readAntigravityQuota(home: string, fetchImpl: Fetch = fetch, now = Date.now()): Promise<QuotaWindow[]> {
  let file: Json;
  try { file = obj(JSON.parse(await readFile(join(home, ANTIGRAVITY_TOKEN_FILE), 'utf8'))); }
  catch { throw new Error('Sign in to Antigravity in Providers to see its limits.'); }
  const clientId = text(file['client_id']), clientSecret = text(file['client_secret']), refreshToken = text(file['refresh_token']);
  if (clientId === null || clientSecret === null || refreshToken === null) {
    throw new Error('The Antigravity sign-in file has no refresh token. Sign in again in Providers.');
  }
  const project = text(file['project_id']);
  const key = createHash('sha256').update(`${clientId}\0${refreshToken}\0${project ?? ''}`).digest('hex');

  const renew = async (): Promise<string> => {
    const answer = obj(await json(fetchImpl, TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
    }));
    const token = text(answer['access_token']);
    const expiresIn = answer['expires_in'];
    if (token === null || typeof expiresIn !== 'number' || expiresIn <= 0) throw new Error('Google did not renew the Antigravity sign-in. Sign in again in Providers.');
    accessTokens.set(key, { token, expiresAt: now + expiresIn * 1000 });
    return token;
  };

  /** The windows, or none and whether an endpoint refused the access token. */
  const readWith = async (token: string): Promise<{ windows: QuotaWindow[]; rejected: boolean }> => {
    let rejected = false;
    // Every endpoint, merged: the daily one has answered with the Claude and
    // GPT group and no Gemini one. A bucket both report keeps its higher use.
    const ask = async (operation: string, parse: (raw: unknown) => QuotaWindow[]): Promise<QuotaWindow[]> => {
      const answers = await Promise.all(ENDPOINTS.map(async (endpoint): Promise<QuotaWindow[]> => {
        try {
          return parse(await json(fetchImpl, `${endpoint}/v1internal:${operation}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': `antigravity/hub/1.0.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)`,
            },
            body: JSON.stringify(project === null ? {} : { project }),
          }));
        } catch (error) {
          // The other endpoint, then the other operation, may answer.
          if (error instanceof RejectedSignIn) rejected = true;
          return [];
        }
      }));
      const windows = new Map<string, QuotaWindow>();
      for (const row of answers.flat()) {
        const previous = windows.get(row.id);
        if (previous === undefined || row.usedPercent > previous.usedPercent) windows.set(row.id, row);
      }
      return [...windows.values()];
    };
    const summary = await ask('retrieveUserQuotaSummary', antigravitySummaryWindows);
    if (summary.length > 0) return { windows: summary, rejected };
    return { windows: await ask('fetchAvailableModels', antigravityModelWindows), rejected };
  };

  const held = accessTokens.get(key);
  const cached = held !== undefined && held.expiresAt > now + 60_000;
  let read = await readWith(cached ? held.token : await renew());
  // An access token Google stopped taking before its expiry is renewed once;
  // a fresh one refused too means the sign-in itself is gone.
  if (read.windows.length === 0 && read.rejected && cached) read = await readWith(await renew());
  if (read.windows.length > 0) return read.windows;
  if (read.rejected) {
    accessTokens.delete(key);
    throw new RejectedSignIn();
  }
  throw new Error('Antigravity did not return usable quota information. Retry in five minutes.');
}

/** Forget the access tokens, for tests and a removed account's sign-in. */
export function forgetAntigravityTokens(): void {
  accessTokens.clear();
}
