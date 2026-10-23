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

test('each share left alerts once, again after the window climbed back or reset, and a restart remembers', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'codex', label: 'Work' });
  const reset = Date.now() + 2 * HOUR;
  let windows: QuotaWindow[] = [
    { id: 'primary', label: '5 hours', usedPercent: 40, resetsAt: reset },
    { id: 'secondary', label: 'Weekly', usedPercent: 100, resetsAt: Date.now() + 90 * HOUR },
  ];
  const used = (usedPercent: number) => { windows = [{ ...windows[0]!, usedPercent }, windows[1]!]; };
  const reader = async () => windows;
  const store = new QuotaStore(harness.core, reader);
  const alerts = heard(harness.core);
  const read = async () => { store.invalidate(); return (await store.list()).find((row) => row.accountId === account.id)!; };
  await read();

  // Kept distinct and highest first, whatever order they came in.
  const rows = store.alert(account.id, 'fiveHour', [10, 50, 25, 50]);
  expect(rows.find((row) => row.accountId === account.id)?.alerts).toEqual({ fiveHour: [50, 25, 10] });
  expect((await read()).alerts).toEqual({ fiveHour: [50, 25, 10] });
  expect(alerts).toEqual([]);

  used(55);
  await read();
  // The weekly window is spent, but only the 5-hour one has alerts.
  expect(alerts.map((alert) => [alert.accountId, alert.period, alert.threshold, alert.window.id, alert.label, alert.providerName]))
    .toEqual([[account.id, 'fiveHour', 50, 'primary', 'Work', 'Codex']]);
  used(60);
  await read();
  expect(alerts).toHaveLength(1);
  used(80);
  await read();
  expect(alerts.map((alert) => alert.threshold)).toEqual([50, 25]);

  // The same journal after a restart knows those thresholds already alerted.
  const restarted = new QuotaStore(harness.core, reader);
  restarted.invalidate();
  await restarted.list();
  expect(alerts).toHaveLength(2);

  // Climbing ten points back above a threshold arms it again, as does a reset time that passed.
  used(60);
  await read();
  used(76);
  await read();
  expect(alerts.map((alert) => alert.threshold)).toEqual([50, 25, 25]);
  store.alerts.check([{ ...(await read()), windows: [{ ...windows[0]!, resetsAt: reset + 5 * HOUR }] }], reset + HOUR);
  expect(alerts.map((alert) => alert.threshold)).toEqual([50, 25, 25, 25]);
  // A reading whose window already reset describes a period that is over: it says nothing.
  store.alerts.check([{ ...(await read()), windows: [{ ...windows[0]!, id: 'other', usedPercent: 99, resetsAt: Date.now() - 1 }] }]);
  expect(alerts).toHaveLength(4);
});

test('a reading past several shares at once says the lowest once, a share already passed when chosen stays quiet, and a failed read never alerts', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'claude', label: 'Perso' });
  let fail = false;
  let used = 30;
  const store = new QuotaStore(harness.core, async () => {
    if (fail) throw new Error('fixture offline');
    return [{ id: 'seven_day', label: 'Weekly', usedPercent: used, resetsAt: Date.now() + 40 * HOUR }];
  });
  const alerts = heard(harness.core);
  const read = async () => { store.invalidate(); return (await store.list()).find((row) => row.accountId === account.id)!; };
  await read();
  store.alert(account.id, 'weekly', [50, 25, 10]);
  used = 95;
  await read();
  expect(alerts.map((alert) => [alert.period, alert.threshold])).toEqual([['weekly', 10]]);
  await read();
  expect(alerts).toHaveLength(1);

  // A custom share the window already passed is not news; one it has not reached yet is.
  store.alert(account.id, 'weekly', [50, 25, 10, 7, 0]);
  await read();
  expect(alerts).toHaveLength(1);
  used = 100;
  fail = true;
  const stale = await read();
  expect([stale.status, stale.windows[0]?.usedPercent]).toEqual(['unavailable', 95]);
  expect(alerts).toHaveLength(1);
  fail = false;
  await read();
  expect(alerts.map((alert) => alert.threshold)).toEqual([10, 0]);
  // An empty list turns the period off, and a removed account takes its alerts with it.
  expect(store.alert(account.id, 'weekly', []).find((row) => row.accountId === account.id)?.alerts).toBeUndefined();
  store.alert(account.id, 'weekly', [20]);
  await harness.core.accounts.remove(account.id);
  expect(store.alerts.all()).toEqual({});
});

test('quotas.alert refuses an unknown period, a bad list or row, and a phone may set one', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'claude', label: 'Perso' });
  const owner = await harness.connect();
  expect(await thrown(owner.call('quotas.alert', { accountId: account.id, period: 'daily' as 'weekly', thresholds: [10] }))).toThrow('period must be one of fiveHour, weekly');
  for (const thresholds of [[100], [-1], [12.5], [1, 2, 3, 4, 5, 6, 7], 'ten' as unknown as number[]]) {
    expect(await thrown(owner.call('quotas.alert', { accountId: account.id, period: 'weekly', thresholds }))).toThrow('thresholds must be a list of at most 6 whole percentages left, from 0 to 99');
  }
  expect(await thrown(owner.call('quotas.alert', { accountId: 'acc_missing', period: 'weekly', thresholds: [10] }))).toThrow();
  expect(await thrown(owner.call('quotas.alert', { accountId: 'proxy:claude:gone', period: 'weekly', thresholds: [10] }))).toThrow('not an entry the gateway reports now');
  // An alert whose entry left the gateway's answer can still be turned off, which stops the poll for it.
  harness.core.quotas.alerts.set('proxy:claude:gone', 'weekly', [10], undefined);
  await owner.call('quotas.alert', { accountId: 'proxy:claude:gone', period: 'weekly', thresholds: [] });
  expect(harness.core.quotas.alerts.watched()).toEqual([]);
  const { connect } = await import('../src/client.ts');
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    const rows = await phone.call('quotas.alert', { accountId: account.id, period: 'fiveHour', thresholds: [20] });
    expect(rows.find((row) => row.accountId === account.id)?.alerts).toEqual({ fiveHour: [20] });
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
  const rows: AccountQuota[] = await owner.call('quotas.alert', { accountId: id, period: 'fiveHour', thresholds: [20] });
  expect(rows.find((row) => row.accountId === id)?.alerts).toEqual({ fiveHour: [20] });
  // The gateway lists only its entries: a login of this machine has no row to alert on.
  const own = harness.core.accounts.add({ providerId: 'claude', label: 'Hidden' });
  expect(await thrown(owner.call('quotas.alert', { accountId: own.id, period: 'weekly', thresholds: [10] }))).toThrow('has no row in quotas.list now');
  used = 85;
  const before = asked;
  // What the five-minute timer runs, once the gateway's minute of cache is over: asked once, with no client listing.
  setSystemTime(new Date(Date.now() + 2 * 60_000));
  try {
    await (harness.core.quotas as unknown as { watch(): Promise<void> }).watch();
    await waitFor(() => alerts.length === 1);
  } finally { setSystemTime(); }
  expect(asked).toBe(before + 1);
  expect(alerts[0]).toMatchObject({ accountId: id, providerName: 'Claude', label: 'Claude Max · chris@…', period: 'fiveHour', threshold: 20 });
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
  const alert: QuotaAlert = { accountId: 'acc_1', providerId: 'claude', providerName: 'Claude', label: 'Perso', period: 'weekly', threshold: 10,
    window: { id: 'model:Opus', label: 'Weekly · Opus', usedPercent: 91.6, resetsAt: null }, at: Date.now() };
  harness.core.bus.emit('quotas.alerted', alert);
  await waitFor(() => deliveries.length === 1);
  expect(deliveries[0]).toMatchObject({ title: 'Claude · Perso · Opus', body: 'Weekly limit: 8% left', label: 'limitWeekly', values: { percent: '8' },
    kind: 'limits', threadId: null, tag: 'limit-acc_1-model:Opus' });
  harness.core.push.setKinds(paired.id, { kinds: ['approvals', 'questions', 'finished', 'errors'] });
  harness.core.bus.emit('quotas.alerted', { ...alert, window: { ...alert.window, id: 'seven_day', label: 'Weekly' } });
  await Bun.sleep(50);
  expect(deliveries).toHaveLength(1);
});

test('a full read begun before an observation alerted neither re-arms nor repeats it, and an observation alerts with no full read held', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'codex', label: 'Work' });
  const reset = Date.now() + 2 * HOUR;
  const window = (usedPercent: number): QuotaWindow => ({ id: 'primary', label: '5 hours', usedPercent, resetsAt: reset });
  let answer: ((windows: QuotaWindow[]) => void) | undefined;
  const store = new QuotaStore(harness.core, () => new Promise<QuotaWindow[]>((resolve) => { answer = resolve; }));
  const alerts = heard(harness.core);
  const first = store.list();
  answer!([window(70)]);
  await first;
  store.alert(account.id, 'fiveHour', [10]);
  // After a restart or an invalidation there is no full read to merge into: the observation alerts all the same.
  store.invalidate();
  const slow = store.list();
  await Bun.sleep(5);
  store.observe(account.id, { windows: [window(95)] }, Date.now());
  expect(alerts).toHaveLength(1);
  // The read that began before it lands with its older 70 %: the next observation is the same crossing.
  answer!([window(70)]);
  await slow;
  await Bun.sleep(2);
  store.observe(account.id, { windows: [window(96)] }, Date.now());
  expect(alerts).toHaveLength(1);
});

test('another login on the account alerts on its own, and a read in flight when monitoring goes off says nothing', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'claude', label: 'Perso' });
  let answer: ((windows: QuotaWindow[]) => void) | undefined;
  const store = new QuotaStore(harness.core, () => new Promise<QuotaWindow[]>((resolve) => { answer = resolve; }));
  const alerts = heard(harness.core);
  const weekly = [{ id: 'seven_day', label: 'Weekly', usedPercent: 95, resetsAt: Date.now() + 40 * HOUR }];
  store.alert(account.id, 'weekly', [10]);
  const first = store.list();
  answer!(weekly);
  await first;
  expect(alerts).toHaveLength(1);
  harness.core.bus.emit('accounts.updated', { ...account, identity: 'first@example.com' });
  harness.core.bus.emit('accounts.updated', { ...account, identity: 'second@example.com' });
  const second = store.list();
  answer!(weekly);
  await second;
  expect(alerts).toHaveLength(2);

  harness.core.bus.emit('accounts.updated', { ...account, identity: 'third@example.com' });
  const pending = store.list();
  await store.configure(account.id, false);
  answer!(weekly);
  await pending;
  expect(alerts).toHaveLength(2);
});
