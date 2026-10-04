import { afterEach, expect, test } from 'bun:test';
import type { AccountQuota, RpcEvents, SubscriptionProxy } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { parseGatewayQuotas } from '../src/subscription-proxy-quotas.ts';
import { startTestCore, type TestCore } from './harness.ts';

let harness: TestCore | undefined;
let gateway: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => { gateway?.stop(true); gateway = undefined; await harness?.stop(); harness = undefined; });

function config(baseUrl: string, kind: SubscriptionProxy['kind'] = 'douane'): SubscriptionProxy {
  return { enabled: true, kind, baseUrl, dashboardUrl: `${baseUrl.replace(/\/v1\/?$/, '')}/admin/#quotas` };
}

/** Douane's answer exactly as the contract spells it: one provider per display mode. */
const DOUANE = {
  object: 'quotas',
  updated_at: '2026-10-04T12:00:00Z',
  providers: [
    { provider: 'claude', name: 'Claude', display: 'accounts', entries: [
      { id: '3b317ce1e503', label: 'Claude Max x20 · chris@…', plan: 'Claude Max x20', accounts: 1, status: 'ready', error: null,
        updated_at: '2026-10-04T11:59:00Z',
        windows: [{ id: 'five-hour', label: '5 hours', used_percent: 11.0, remaining_percent: 89.0, reset_at: '2026-10-04T13:49:59Z' }],
        credits: [{ id: 'codex-credits', label: 'Credits', unit: 'credits', remaining: 62500.0, limit: null, used: null }] },
      { id: 'c00l', label: 'Claude Pro · work@…', plan: 'Claude Pro', accounts: 1, status: 'cooldown', error: null, updated_at: null,
        windows: [{ id: 'weekly', label: 'Weekly', used_percent: 100, remaining_percent: 0, reset_at: null }], credits: [] },
    ] },
    { provider: 'antigravity', name: 'Antigravity', display: 'average', entries: [
      { id: 'antigravity', label: 'Antigravity · 10 comptes', plan: null, accounts: 10, status: 'ready', error: null,
        updated_at: '2026-10-04T11:58:00Z',
        windows: [{ id: 'gemini-pro', label: 'Gemini Pro', used_percent: 40.5, remaining_percent: 59.5, reset_at: '2026-10-04T17:00:00Z' }],
        credits: [] },
    ] },
  ],
};

test('quotas come from Douane through the core, in both display modes, with the key as Bearer and the native cadence', async () => {
  const seen: { path: string; auth: string | null }[] = [];
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    seen.push({ path, auth: request.headers.get('authorization') });
    return path === '/v1/quotas' ? Response.json(DOUANE) : new Response('not found', { status: 404 });
  } });
  harness = await startTestCore();
  const owner = await harness.connect();
  const key = 'douane-quota-test-token';
  await owner.call('subscriptionProxy.configure', { subscriptionProxy: config(`http://127.0.0.1:${gateway.port}/v1`), key });
  const events: RpcEvents['subscriptionProxy.quotasUpdated'][] = [];
  harness.core.bus.onAny((name, payload) => { if (name === 'subscriptionProxy.quotasUpdated') events.push(payload as RpcEvents['subscriptionProxy.quotasUpdated']); });

  const state = await owner.call('subscriptionProxy.quotas', {});
  expect(state).toMatchObject({ status: 'ready', error: null, updatedAt: Date.parse('2026-10-04T12:00:00Z') });
  expect(state.providers.map((provider) => [provider.providerId, provider.display, provider.entries.length])).toEqual([['claude', 'accounts', 2], ['antigravity', 'average', 1]]);
  expect(state.providers[0]!.entries[0]).toEqual({
    id: '3b317ce1e503', label: 'Claude Max x20 · chris@…', plan: 'Claude Max x20', accounts: 1, status: 'ready', error: null,
    updatedAt: Date.parse('2026-10-04T11:59:00Z'),
    windows: [{ id: 'five-hour', label: '5 hours', usedPercent: 11, resetsAt: Date.parse('2026-10-04T13:49:59Z') }],
    credits: [{ id: 'codex-credits', label: 'Credits', unit: 'credits', remaining: 62500, limit: null, used: null }],
  });
  expect(seen).toEqual([{ path: '/v1/quotas', auth: `Bearer ${key}` }]);

  // quotas.list carries the same entries, after the accounts, without asking again within a minute.
  const rows = await owner.call('quotas.list', {});
  expect(seen).toHaveLength(1);
  const proxied = rows.filter((row) => row.gateway);
  expect(proxied.map((row) => [row.accountId, row.providerName, row.status, row.gateway!.accounts])).toEqual([
    ['proxy:claude:3b317ce1e503', 'Claude', 'ready', 1],
    ['proxy:claude:c00l', 'Claude', 'ready', 1],
    ['proxy:antigravity:antigravity', 'Antigravity', 'ready', 10],
  ]);
  expect(proxied[1]!.gateway).toMatchObject({ kind: 'douane', display: 'accounts', status: 'cooldown', plan: 'Claude Pro' });
  expect(proxied[2]!.gateway).toMatchObject({ display: 'average', accounts: 10, entryId: 'antigravity' });
  // The machine's own Claude and Codex accounts are the gateway's now.
  expect(rows.filter((row) => !row.gateway && ['claude', 'codex'].includes(row.providerId)).every((row) => row.status === 'unsupported')).toBe(true);
  // A gateway entry is not an account: no switch, no reset.
  await expect(owner.call('quotas.configure', { accountId: 'proxy:claude:c00l', enabled: false })).rejects.toThrow();

  // Refresh asks again, and every client hears the answer.
  const progress: string[] = [];
  harness.core.bus.onAny((name, payload) => { if (name === 'quotas.progress') progress.push((payload as RpcEvents['quotas.progress']).quota.accountId); });
  await owner.call('quotas.list', { refresh: true, requestId: 'gateway-refresh' });
  expect(seen).toHaveLength(2);
  expect(progress).toEqual(expect.arrayContaining(['proxy:claude:3b317ce1e503', 'proxy:antigravity:antigravity']));
  expect(events.at(-1)?.status).toBe('ready');

  // Owner-only, like quotas.list: a paired phone gets nothing from the gateway.
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try { await expect(phone.call('subscriptionProxy.quotas', {})).rejects.toThrow('owner'); }
  finally { phone.close(); }

  // Turning the proxy off drops the entries at once, from the quota rows every reader keeps too.
  const updates: AccountQuota[][] = [];
  harness.core.bus.onAny((name, payload) => { if (name === 'quotas.updated') updates.push(payload as AccountQuota[]); });
  await owner.call('settings.set', { subscriptionProxy: { ...config(`http://127.0.0.1:${gateway.port}/v1`), enabled: false } });
  expect(events.at(-1)?.status).toBe('off');
  expect(updates).toHaveLength(1);
  expect(updates[0]!.some((row) => row.gateway)).toBe(false);
  expect((await owner.call('quotas.list', {})).some((row) => row.gateway)).toBe(false);
  expect(seen).toHaveLength(2);
});

test('an older Douane answering 404 and CLIProxyAPI fall back to the dashboard', async () => {
  let hits = 0;
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { hits++; return new Response('<html>no route</html>', { status: 404 }); } });
  harness = await startTestCore({ settings: { subscriptionProxy: config(`http://127.0.0.1:${gateway.port}`) } });
  const owner = await harness.connect();
  expect(await owner.call('subscriptionProxy.quotas', { refresh: true })).toEqual({ status: 'unsupported', providers: [], updatedAt: null, checkedAt: null, error: null });
  expect((await owner.call('quotas.list', {})).some((row) => row.gateway)).toBe(false);
  expect(hits).toBe(1);

  await owner.call('settings.set', { subscriptionProxy: config(`http://127.0.0.1:${gateway.port}`, 'cliproxyapi') });
  expect((await owner.call('subscriptionProxy.quotas', { refresh: true })).status).toBe('unsupported');
  expect(hits).toBe(1);
});

test('an oversized, invalid or failing answer is refused without its body and keeps the last good reading stale', async () => {
  let mode: 'good' | 'declared' | 'chunked' | 'invalid' | 'error' = 'good';
  const secret = 'raw-gateway-secret-in-body';
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    if (mode === 'good') return Response.json(DOUANE);
    if (mode === 'declared') return new Response(`{"providers":[],"pad":"${secret}${'x'.repeat(4096)}"}`);
    if (mode === 'chunked') return new Response(new ReadableStream({ start(controller) {
      for (let index = 0; index < 8; index++) controller.enqueue(new TextEncoder().encode(`${secret}${'y'.repeat(1024)}`));
      controller.close();
    } }));
    if (mode === 'invalid') return new Response(`not json ${secret}`, { headers: { 'content-type': 'application/json' } });
    return new Response(secret, { status: 500 });
  } });
  harness = await startTestCore({ settings: { subscriptionProxy: config(`http://127.0.0.1:${gateway.port}`) } });
  // A small cap keeps the oversized bodies small in the test.
  const { GatewayQuotas } = await import('../src/subscription-proxy-quotas.ts');
  const quotas = new GatewayQuotas(harness.core, 2048);
  const good = await quotas.read(true);
  expect(good.status).toBe('ready');

  for (const [next, message] of [['declared', 'exceeded 2048 bytes'], ['chunked', 'exceeded 2048 bytes'], ['invalid', 'invalid JSON'], ['error', 'HTTP 500']] as const) {
    mode = next;
    const state = await quotas.read(true);
    expect(state.status).toBe('unavailable');
    expect(state.error).toContain(message);
    expect(JSON.stringify(state)).not.toContain(secret);
    // The last good answer stays, marked stale on every row.
    expect(state.providers).toEqual(good.providers);
    expect(state.checkedAt).toBe(good.checkedAt);
    expect(quotas.rows(state).every((row) => row.status === 'unavailable' && row.error === state.error)).toBe(true);
  }
  expect(JSON.stringify(await (await harness.connect()).call('core.logs', {}))).not.toContain(secret);
});

test('rows that break the contract are dropped and strings are bounded', () => {
  expect(() => parseGatewayQuotas({ data: [] })).toThrow('providers array');
  const parsed = parseGatewayQuotas({ providers: [
    { provider: 'bad provider id', entries: [{ id: 'a', label: 'A' }] },
    { provider: 'codex', display: 'sideways', entries: [
      { id: 'no-label' },
      { id: 'x', label: `Codex\u0000 ${'n'.repeat(400)}`, accounts: -3, status: 'exploded', error: 'e'.repeat(900),
        windows: [{ id: 'primary', label: 'Weekly', used_percent: 180, reset_at: 'not a date' }, { id: 'missing' }, { id: 'left', remaining_percent: 25 }],
        credits: [{ id: 'c', remaining: '12' }] },
      { id: 'x', label: 'duplicate' },
    ] },
    { provider: 'codex', entries: [] },
  ] }, (id) => id === 'codex' ? 'Codex CLI' : null);
  expect(parsed.providers).toHaveLength(1);
  const [codex] = parsed.providers;
  expect(codex).toMatchObject({ providerId: 'codex', name: 'Codex CLI', display: 'accounts' });
  expect(codex!.entries).toHaveLength(1);
  const entry = codex!.entries[0]!;
  expect(entry.label.length).toBe(200);
  expect(entry.label).not.toContain('\u0000');
  expect(entry.error!.length).toBe(300);
  expect(entry).toMatchObject({ accounts: 1, status: 'ready' });
  expect(entry.windows).toEqual([
    { id: 'primary', label: 'Weekly', usedPercent: 100, resetsAt: null },
    { id: 'left', label: 'left', usedPercent: 75, resetsAt: null },
  ]);
  expect(entry.credits).toEqual([{ id: 'c', label: 'c', unit: null, remaining: null, limit: null, used: null }]);
});

test('local accounts stay stored and come back unchanged when the proxy goes off', async () => {
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return Response.json(DOUANE); } });
  harness = await startTestCore();
  const owner = await harness.connect();
  const work = await owner.call('accounts.add', { providerId: 'claude', label: 'Work' });
  const before = await owner.call('accounts.list', {});
  const proxy = config(`http://127.0.0.1:${gateway.port}`);
  await owner.call('subscriptionProxy.configure', { subscriptionProxy: proxy });
  const during = await owner.call('accounts.list', {});
  // Nothing synthetic is stored or listed: clients draw the gateway account from settings.
  expect(during.map((account) => account.id)).toEqual(before.map((account) => account.id));
  expect(during.find((account) => account.id === work.id)?.label).toBe('Work');
  await owner.call('settings.set', { subscriptionProxy: { ...proxy, enabled: false } });
  const after = await owner.call('accounts.list', {});
  expect(after.map(({ id, label, isolationDir }) => ({ id, label, isolationDir }))).toEqual(before.map(({ id, label, isolationDir }) => ({ id, label, isolationDir })));
});

test('a new key is asked again at once, whether saved alone or with the configuration', async () => {
  const seen: string[] = [];
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const auth = request.headers.get('authorization') ?? '';
    seen.push(auth);
    return auth === 'Bearer good-key' ? Response.json(DOUANE) : Response.json({ error: 'bad key' }, { status: 401 });
  } });
  harness = await startTestCore();
  const owner = await harness.connect();
  const proxy = config(`http://127.0.0.1:${gateway.port}/v1`);
  await owner.call('subscriptionProxy.configure', { subscriptionProxy: proxy, key: 'wrong-key' });
  expect((await owner.call('subscriptionProxy.quotas', {})).status).toBe('unavailable');

  // The corrected key alone: the next plain read asks the gateway with it.
  await owner.call('subscriptionProxy.key', { key: 'good-key' });
  expect((await owner.call('subscriptionProxy.quotas', {})).status).toBe('ready');
  expect(seen).toEqual(['Bearer wrong-key', 'Bearer good-key']);

  // The same settings with another key: no settings change, still a new answer.
  await owner.call('subscriptionProxy.configure', { subscriptionProxy: proxy, key: 'wrong-key' });
  expect((await owner.call('subscriptionProxy.quotas', {})).status).toBe('unavailable');
  expect(seen).toEqual(['Bearer wrong-key', 'Bearer good-key', 'Bearer wrong-key']);
});