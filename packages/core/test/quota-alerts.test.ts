import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { createECDH, randomBytes } from 'node:crypto';
import { quotaAlertPeriod, type AccountQuota, type PushPayload, type QuotaAlert, type QuotaWindow, type SubscriptionProxy } from '@boite/contracts';
import { QuotaStore } from '../src/quotas.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore | undefined;
let gateway: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => { gateway?.stop(true); gateway = undefined; await harness?.stop(); harness = undefined; });

const HOUR = 3_600_000;
const heard = (core: TestCore['core']) => {
  const alerts: QuotaAlert[] = [];
  core.bus.onAny((name, payload) => { if (name === 'quotas.alerted') alerts.push(payload as QuotaAlert); });
  return alerts;
};

test('every source names its 5-hour and weekly windows the way alerts read them', () => {
  const period = (id: string, label: string) => quotaAlertPeriod({ id, label });
  // Claude, Codex, OpenCode Go, Antigravity, Douane's ids and its unnamed lengths.
  expect([period('five_hour', '5 hours'), period('seven_day', 'Weekly'), period('model:Opus', 'Weekly · Opus')]).toEqual(['fiveHour', 'weekly', 'weekly']);
  expect([period('primary', '5 hours'), period('secondary', 'Weekly'), period('primary', 'Monthly')]).toEqual(['fiveHour', 'weekly', null]);
  expect([period('rolling', '5 hours'), period('weekly', 'Weekly'), period('monthly', 'Monthly')]).toEqual(['fiveHour', 'weekly', null]);
  expect([period('0:gemini', 'Gemini · 5 hours'), period('1:claude', 'Claude · Weekly')]).toEqual(['fiveHour', 'weekly']);
  expect([period('five-hour', '5 hours'), period('seven-day', 'Weekly'), period('window-18000s', 'x'), period('daily', 'Daily')]).toEqual(['fiveHour', 'weekly', 'fiveHour', null]);
  // A 15-hour window is not a 5-hour one, and credits have no period.
  expect([period('w', '15 hours'), period('credits', 'Credits')]).toEqual([null, null]);
});

test('a window alerts once at its threshold, again after it fell back or reset, and a restart remembers', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'codex', label: 'Work' });
  const reset = Date.now() + 2 * HOUR;
  let windows: QuotaWindow[] = [
    { id: 'primary', label: '5 hours', usedPercent: 50, resetsAt: reset },
    { id: 'secondary', label: 'Weekly', usedPercent: 100, resetsAt: Date.now() + 90 * HOUR },
  ];
  const reader = async () => windows;
  const store = new QuotaStore(harness.core, reader);
  const alerts = heard(harness.core);
  const read = async () => { store.invalidate(); return (await store.list()).find((row) => row.accountId === account.id)!; };
  await read();

  const rows = store.alert(account.id, 'fiveHour', 90);
  expect(rows.find((row) => row.accountId === account.id)?.alerts).toEqual({ fiveHour: 90 });
  expect((await read()).alerts).toEqual({ fiveHour: 90 });
  expect(alerts).toEqual([]);

  windows = [{ ...windows[0]!, usedPercent: 92 }, windows[1]!];
  await read();
  // The weekly window is spent, but only the 5-hour one has an alert.
  expect(alerts.map((alert) => [alert.accountId, alert.period, alert.threshold, alert.window.id, alert.label, alert.providerName]))
    .toEqual([[account.id, 'fiveHour', 90, 'primary', 'Work', 'Codex']]);
  windows = [{ ...windows[0]!, usedPercent: 97 }, windows[1]!];
  await read();
  expect(alerts).toHaveLength(1);

  // The same journal after a restart knows that window already alerted.
  const restarted = new QuotaStore(harness.core, reader);
  restarted.invalidate();
  await restarted.list();
  expect(alerts).toHaveLength(1);

  // Usage that falls well under the threshold arms it again, as does a reset time that passed.
  windows = [{ ...windows[0]!, usedPercent: 75 }, windows[1]!];
  await read();
  windows = [{ ...windows[0]!, usedPercent: 91 }, windows[1]!];
  await read();
  expect(alerts).toHaveLength(2);
  store.alerts.check([{ ...(await read()), windows: [{ ...windows[0]!, resetsAt: reset + 5 * HOUR }] }], reset + HOUR);
  expect(alerts).toHaveLength(3);
  // A reading whose window already reset describes a period that is over: it says nothing.
  store.alerts.check([{ ...(await read()), windows: [{ ...windows[0]!, id: 'other', resetsAt: Date.now() - 1 }] }]);
  expect(alerts).toHaveLength(3);
});

test('a window already past the threshold chosen stays quiet, and a failed read never alerts', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'claude', label: 'Perso' });
  let fail = false;
  let used = 95;
  const store = new QuotaStore(harness.core, async () => {
    if (fail) throw new Error('fixture offline');
    return [{ id: 'seven_day', label: 'Weekly', usedPercent: used, resetsAt: Date.now() + 40 * HOUR }];
  });
  const alerts = heard(harness.core);
  await store.list();
  store.alert(account.id, 'weekly', 90);
  store.invalidate();
  await store.list();
  expect(alerts).toEqual([]);
  // Raising it past the reading arms it: 100 % is news.
  store.alert(account.id, 'weekly', 100);
  used = 100;
  fail = true;
  store.invalidate();
  const stale = (await store.list()).find((row) => row.accountId === account.id)!;
  expect([stale.status, stale.windows[0]?.usedPercent]).toEqual(['unavailable', 95]);
  expect(alerts).toEqual([]);
  fail = false;
  store.invalidate();
  await store.list();
  expect(alerts.map((alert) => [alert.period, alert.threshold, alert.window.usedPercent])).toEqual([['weekly', 100, 100]]);
  // Off clears the row's alerts, and a removed account takes them with it.
  expect(store.alert(account.id, 'weekly', null).find((row) => row.accountId === account.id)?.alerts).toBeUndefined();
  store.alert(account.id, 'weekly', 80);
  await harness.core.accounts.remove(account.id);
  expect(store.alerts.all()).toEqual({});
});

test('quotas.alert refuses an unknown period, threshold or row, and a phone may set one', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'claude', label: 'Perso' });
  const owner = await harness.connect();
  expect(await thrown(owner.call('quotas.alert', { accountId: account.id, period: 'daily' as 'weekly', threshold: 90 }))).toThrow('period must be one of fiveHour, weekly');
  expect(await thrown(owner.call('quotas.alert', { accountId: account.id, period: 'weekly', threshold: 85 }))).toThrow('threshold must be null or one of 80, 90, 100');
  expect(await thrown(owner.call('quotas.alert', { accountId: 'acc_missing', period: 'weekly', threshold: 90 }))).toThrow();
  expect(await thrown(owner.call('quotas.alert', { accountId: 'proxy:claude:gone', period: 'weekly', threshold: 90 }))).toThrow('not an entry the gateway reports now');
  const { connect } = await import('../src/client.ts');
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    const rows = await phone.call('quotas.alert', { accountId: account.id, period: 'fiveHour', threshold: 80 });
    expect(rows.find((row) => row.accountId === account.id)?.alerts).toEqual({ fiveHour: 80 });
  } finally { phone.close(); }
});

test('a Douane entry alerts from the gateway reading, and the poll reads only what an alert watches', async () => {
  let used = 40;
  let asked = 0;
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname !== '/v1/quotas') return new Response('not found', { status: 404 });
    asked++;
    return Response.json({ object: 'quotas', updated_at: new Date().toISOString(), providers: [
      { provider: 'claude', name: 'Claude', display: 'accounts', entries: [
        { id: 'max', label: 'Claude Max · chris@…', plan: 'Max', accounts: 1, status: 'ready', error: null, updated_at: null,
          windows: [{ id: 'five-hour', label: '5 hours', used_percent: used, remaining_percent: 100 - used, reset_at: new Date(Date.now() + HOUR).toISOString() }], credits: [] },
      ] },
    ] });
  } });
  harness = await startTestCore();
  const owner = await harness.connect();
  const proxy: SubscriptionProxy = { enabled: true, kind: 'douane', baseUrl: `http://127.0.0.1:${gateway.port}/v1`, dashboardUrl: `http://127.0.0.1:${gateway.port}/admin/` };
  await owner.call('subscriptionProxy.configure', { subscriptionProxy: proxy, key: 'douane-alert-test-token' });
  const alerts = heard(harness.core);
  await owner.call('quotas.list', {});
  const id = 'proxy:claude:max';
  const rows: AccountQuota[] = await owner.call('quotas.alert', { accountId: id, period: 'fiveHour', threshold: 80 });
  expect(rows.find((row) => row.accountId === id)?.alerts).toEqual({ fiveHour: 80 });
  used = 85;
  const before = asked;
  // What the five-minute timer runs, once the gateway's minute of cache is over: asked once, with no client listing.
  setSystemTime(new Date(Date.now() + 2 * 60_000));
  try {
    await (harness.core.quotas as unknown as { watch(): Promise<void> }).watch();
    await waitFor(() => alerts.length === 1);
  } finally { setSystemTime(); }
  expect(asked).toBe(before + 1);
  expect(alerts[0]).toMatchObject({ accountId: id, providerName: 'Claude', label: 'Claude Max · chris@…', period: 'fiveHour', threshold: 80 });
});

test('a phone gets the alert as a limits push its words translate, and not when it turned limits off', async () => {
  harness = await startTestCore();
  const grant = harness.core.sessions.grant();
  const paired = harness.core.sessions.exchange(grant.grant, { name: 'pwa', version: 'test' });
  const ecdh = createECDH('prime256v1');
  harness.core.push.subscribe(paired.id, { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`, keys: {
    p256dh: ecdh.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
  const deliveries: PushPayload[] = [];
  harness.core.push.send = async (_target, payload) => { deliveries.push(JSON.parse(payload)); };
  const alert: QuotaAlert = { accountId: 'acc_1', providerId: 'claude', providerName: 'Claude', label: 'Perso', period: 'weekly', threshold: 90,
    window: { id: 'model:Opus', label: 'Weekly · Opus', usedPercent: 91.6, resetsAt: null }, at: Date.now() };
  harness.core.bus.emit('quotas.alerted', alert);
  await waitFor(() => deliveries.length === 1);
  expect(deliveries[0]).toMatchObject({ title: 'Claude · Perso · Opus', body: 'Weekly limit: 92% used', label: 'limitWeekly', values: { percent: '92' },
    kind: 'limits', threadId: null, tag: 'limit-acc_1-model:Opus' });
  harness.core.push.setKinds(paired.id, { kinds: ['approvals', 'questions', 'finished', 'errors'] });
  harness.core.bus.emit('quotas.alerted', { ...alert, window: { ...alert.window, id: 'seven_day', label: 'Weekly' } });
  await Bun.sleep(50);
  expect(deliveries).toHaveLength(1);
});
