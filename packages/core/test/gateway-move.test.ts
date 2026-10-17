import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubscriptionProxy } from '@boite/contracts';
import { endpointRoute } from '../src/gateway-move.ts';
import { startTestCore, type TestCore } from './harness.ts';

let harness: TestCore | undefined;
let gateway: ReturnType<typeof Bun.serve> | undefined;
let cache: string;
const previousCache = process.env.XDG_CACHE_HOME;

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'boite-opencode-cache-'));
  process.env.XDG_CACHE_HOME = cache;
});
afterEach(async () => {
  gateway?.stop(true); gateway = undefined;
  await harness?.stop(); harness = undefined;
  if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
  rmSync(cache, { recursive: true, force: true });
});

const SECRETS = {
  claude: 'claude-refresh-secret-1111', codex: 'codex-refresh-secret-2222', grok: 'grok-refresh-secret-3333',
  copilot: 'gho_copilot-secret-4444', deepseek: 'sk-deepseek-secret-5555', groq: 'gsk-groq-secret-6666',
  zen: 'zen-key-secret-7777', go: 'go-key-secret-8888', management: 'management-token-9999',
};

function douane(baseUrl: string): SubscriptionProxy {
  return { enabled: false, kind: 'douane', baseUrl, dashboardUrl: `${baseUrl}/admin/#quotas` };
}

interface Received { path: string; key: string | null; body: unknown }

/** A loopback stand-in for Douane's management API that records what it receives. */
function fakeDouane(options: { token?: string; existing?: Record<string, unknown>[]; loginPage?: boolean } = {}) {
  const received: Received[] = [];
  const accounts = [...(options.existing ?? [])];
  let next = 1;
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    const key = request.headers.get('x-management-key');
    const body = request.method === 'POST' ? await request.json() : undefined;
    received.push({ path: url.pathname, key, body });
    if (options.loginPage) return new Response('<html><form>Sign in</form></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (options.token !== undefined && key !== options.token) return Response.json({ error: 'management authentication required' }, { status: 401 });
    if (url.pathname === '/admin/api/accounts') return Response.json({ accounts });
    if (url.pathname !== '/admin/api/accounts/import') return new Response('not found', { status: 404 });
    const content = (body as { files: { content: Record<string, unknown> }[] }).files[0]!.content;
    if (content.type === 'openai_compatible' && content.route === 'zen') {
      // A refusal that echoes the key back must not reach the client with it.
      return Response.json({ imported: 0, accounts: [], errors: [{ name: null, error: `upstream rejected ${String(content.api_key)}` }] }, { status: 400 });
    }
    const tokens = content.tokens as { account_id?: string } | undefined;
    const existing = tokens?.account_id ? accounts.find(account => account.account_id === tokens.account_id) : undefined;
    const provider = content.claudeAiOauth ? 'claude' : tokens ? 'codex' : 'github-copilot' in content ? 'copilot' : String(content.type ?? 'xai');
    const summary = existing ?? { id: `d${next++}`, provider, ...(content.route ? { route: content.route, base_url: content.base_url } : {}) };
    if (!existing) accounts.push(summary);
    return Response.json({ imported: 1, accounts: [summary], errors: [] });
  } });
  return { url: `http://127.0.0.1:${gateway.port}`, received };
}

async function account(client: Awaited<ReturnType<TestCore['connect']>>, providerId: string, files: Record<string, unknown>) {
  const added = await client.call('accounts.add', { providerId, label: `${providerId} test` });
  for (const [path, content] of Object.entries(files)) {
    const file = join(added.isolationDir!, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return added.id;
}

async function seed(client: Awaited<ReturnType<TestCore['connect']>>) {
  mkdirSync(join(cache, 'opencode'), { recursive: true });
  writeFileSync(join(cache, 'opencode', 'models.json'), JSON.stringify({
    deepseek: { id: 'deepseek', name: 'DeepSeek', api: 'https://api.deepseek.test/v1/', npm: '@ai-sdk/openai-compatible' },
    groq: { id: 'groq', name: 'Groq', npm: '@ai-sdk/groq' },
    opencode: { id: 'opencode', name: 'OpenCode Zen', api: 'https://zen.test/v1', npm: '@ai-sdk/openai-compatible' },
    minimax: { id: 'minimax', name: 'MiniMax', api: 'https://minimax.test/v1', npm: '@ai-sdk/anthropic' },
  }));
  return {
    claude: await account(client, 'claude', { '.credentials.json': { claudeAiOauth: { accessToken: 'claude-access', refreshToken: SECRETS.claude, expiresAt: Date.now() + 3_600_000 } } }),
    codex: await account(client, 'codex', { 'auth.json': { tokens: { access_token: 'codex-access', refresh_token: SECRETS.codex, account_id: 'codex-known' } } }),
    codexOut: await account(client, 'codex', {}),
    grok: await account(client, 'grok', { 'auth.json': { 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': { access_token: 'grok-access', refresh_token: SECRETS.grok } } }),
    opencode: await account(client, 'opencode', { [join('opencode', 'auth.json')]: {
      'github-copilot': { type: 'oauth', refresh: SECRETS.copilot, access: 'copilot-access', expires: 0 },
      deepseek: { type: 'api', key: SECRETS.deepseek },
      groq: { type: 'api', key: SECRETS.groq },
      opencode: { type: 'api', key: SECRETS.zen },
      'opencode-go': { type: 'api', key: SECRETS.go },
      minimax: { type: 'api', key: 'minimax-key-secret' },
      anthropic: { type: 'oauth', refresh: 'anthropic-oauth-secret', access: 'x', expires: 0 },
    } }),
  };
}

test('routes take the OpenCode id unless Douane keeps that name', () => {
  expect(endpointRoute('deepseek')).toBe('deepseek');
  expect(endpointRoute('opencode')).toBe('zen');
  expect(endpointRoute('openai')).toBe('openai-api');
  expect(endpointRoute('Moonshot.AI')).toBe('moonshot-ai');
  expect(endpointRoute('---')).toBeNull();
});

test('the plan lists every login and key Douane could take, with no value, and the move posts each one', async () => {
  const fake = fakeDouane({ existing: [{ id: 'd-codex', provider: 'codex', account_id: 'codex-known' }] });
  harness = await startTestCore({ settings: { subscriptionProxy: douane(fake.url) } });
  const client = await harness.connect();
  const ids = await seed(client);

  const plan = await client.call('subscriptionProxy.movePlan', {});
  expect(plan.origin).toBe(fake.url);
  expect(plan.managementToken).toBe(false);
  const by = (id: string) => plan.items.find(item => item.id === id);
  expect(by(`${ids.claude}:login`)).toMatchObject({ kind: 'login', providerId: 'claude', movable: true, reason: null });
  expect(by(`${ids.codexOut}:login`)).toMatchObject({ movable: false, reason: 'signedOut' });
  expect(by(`${ids.opencode}:copilot`)).toMatchObject({ kind: 'copilot', movable: true });
  expect(by(`${ids.opencode}:key:deepseek`)).toMatchObject({ kind: 'endpoint', route: 'deepseek', baseUrl: 'https://api.deepseek.test/v1', source: { name: 'DeepSeek' }, movable: true });
  expect(by(`${ids.opencode}:key:opencode`)).toMatchObject({ route: 'zen', movable: true });
  expect(by(`${ids.opencode}:key:opencode-go`)).toMatchObject({ kind: 'opencodeGo', movable: true });
  expect(by(`${ids.opencode}:key:groq`)).toMatchObject({ movable: false, reason: 'noAddress' });
  expect(by(`${ids.opencode}:key:minimax`)).toMatchObject({ movable: false, reason: 'otherApi' });
  expect(by(`${ids.opencode}:key:anthropic`)).toMatchObject({ movable: false, reason: 'otherSignIn' });
  for (const secret of Object.values(SECRETS)) expect(JSON.stringify(plan)).not.toContain(secret);

  const chosen = plan.items.map(item => item.id).concat('acc_gone:login');
  const { outcomes } = await client.call('subscriptionProxy.move', { ids: chosen });
  const outcome = (id: string) => outcomes.find(entry => entry.id === id);
  expect(outcome(`${ids.claude}:login`)).toMatchObject({ outcome: 'moved' });
  expect(outcome(`${ids.codex}:login`)).toMatchObject({ outcome: 'present' });
  expect(outcome(`${ids.grok}:login`)).toMatchObject({ outcome: 'moved' });
  expect(outcome(`${ids.opencode}:copilot`)).toMatchObject({ outcome: 'moved' });
  expect(outcome(`${ids.opencode}:key:deepseek`)).toMatchObject({ outcome: 'moved' });
  expect(outcome(`${ids.opencode}:key:opencode-go`)).toMatchObject({ outcome: 'moved' });
  expect(outcome(`${ids.opencode}:key:groq`)).toMatchObject({ outcome: 'refused', reason: 'noAddress' });
  expect(outcome(`${ids.codexOut}:login`)).toMatchObject({ outcome: 'refused', reason: 'signedOut' });
  expect(outcome('acc_gone:login')).toMatchObject({ outcome: 'missing' });
  const zen = outcome(`${ids.opencode}:key:opencode`)!;
  expect(zen).toMatchObject({ outcome: 'refused' });
  expect(zen.message).toBe('upstream rejected [hidden]');

  const imports = fake.received.filter(entry => entry.path === '/admin/api/accounts/import').map(entry => (entry.body as { files: { content: Record<string, unknown> }[] }).files[0]!.content);
  expect(imports).toContainEqual({ type: 'openai_compatible', name: 'DeepSeek', route: 'deepseek', base_url: 'https://api.deepseek.test/v1', api_key: SECRETS.deepseek, dialect: 'chat' });
  expect(imports).toContainEqual({ type: 'opencode_go', api_key: SECRETS.go });
  // Only OpenCode's Copilot entry leaves, never its other keys.
  const copilot = imports.find(content => 'github-copilot' in content)!;
  expect(Object.keys(copilot)).toEqual(['github-copilot']);
  expect(JSON.stringify(imports)).not.toContain(SECRETS.groq);
  expect(JSON.stringify(imports)).toContain(SECRETS.claude);
  expect(fake.received.every(entry => entry.key === null)).toBe(true);
  const logs = JSON.stringify(await client.call('core.logs', {}));
  for (const secret of Object.values(SECRETS)) expect(logs).not.toContain(secret);
  expect(JSON.stringify(outcomes)).not.toContain(SECRETS.zen);

  // A second move adds nothing twice: endpoints and subscriptions without an identity are compared by the core.
  fake.received.length = 0;
  const again = await client.call('subscriptionProxy.move', { ids: [`${ids.opencode}:key:deepseek`, `${ids.opencode}:copilot`, `${ids.opencode}:key:opencode-go`] });
  expect(again.outcomes.map(entry => entry.outcome)).toEqual(['present', 'present', 'present']);
  expect(fake.received.filter(entry => entry.path.endsWith('/import'))).toEqual([]);
});

test('a remote Douane that wants a management token says so, and the saved token is sent but never shown', async () => {
  const fake = fakeDouane({ token: SECRETS.management });
  harness = await startTestCore({ settings: { subscriptionProxy: douane(fake.url) } });
  const client = await harness.connect();
  const ids = await seed(client);
  const id = `${ids.claude}:login`;
  await expect(client.call('subscriptionProxy.move', { ids: [id] })).rejects.toMatchObject({ rpc: { message: expect.stringContaining('HTTP 401'), data: { field: 'managementToken' } } });
  expect(fake.received.filter(entry => entry.path.endsWith('/import'))).toEqual([]);
  const { outcomes } = await client.call('subscriptionProxy.move', { ids: [id], managementToken: SECRETS.management });
  expect(outcomes).toEqual([{ id, outcome: 'moved', reason: null, message: null }]);
  expect(fake.received.at(-1)!.key).toBe(SECRETS.management);
  const plan = await client.call('subscriptionProxy.movePlan', {});
  expect(plan.managementToken).toBe(true);
  const visible = JSON.stringify({ plan, settings: await client.call('settings.get', {}), logs: await client.call('core.logs', {}), events: harness.core.journal.db.query('SELECT payload FROM events').all() });
  expect(visible).not.toContain(SECRETS.management);
  // Removing the token takes effect at once: this move goes without one and is refused.
  await expect(client.call('subscriptionProxy.move', { ids: [id], managementToken: null })).rejects.toMatchObject({ rpc: { data: { field: 'managementToken' } } });
  expect((await client.call('subscriptionProxy.movePlan', {})).managementToken).toBe(false);
});

test('a gateway behind a login page, or no Douane at all, is refused in plain words', async () => {
  const fake = fakeDouane({ loginPage: true });
  harness = await startTestCore({ settings: { subscriptionProxy: douane(fake.url) } });
  const client = await harness.connect();
  const ids = await seed(client);
  await expect(client.call('subscriptionProxy.move', { ids: [`${ids.claude}:login`] })).rejects.toMatchObject({ rpc: { message: expect.stringContaining('sign-in page'), data: { field: 'managementToken' } } });
  await client.call('subscriptionProxy.configure', { subscriptionProxy: { ...douane(fake.url), kind: 'cliproxyapi' } });
  expect((await client.call('subscriptionProxy.movePlan', {})).origin).toBeNull();
  await expect(client.call('subscriptionProxy.move', { ids: [`${ids.claude}:login`] })).rejects.toMatchObject({ rpc: { data: { field: 'subscriptionProxy.kind' } } });
  await expect(client.call('subscriptionProxy.move', { ids: [] })).rejects.toMatchObject({ rpc: { data: { field: 'ids' } } });
});
