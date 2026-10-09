/*
 * The companion's HUD: which threads it lists and how it words their step, the
 * gauges it draws from the proxy's quotas, and how it follows them against the
 * fake core.
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { GatewayQuotaEntry, SubscriptionProxyQuotas } from '@boite/contracts';
import { FakeClient } from '../fake-client';
import { GatewayReader } from '../quota-reader.svelte';
import { followQuotas, hudGauges, hudThreads, quotaLevel, QUOTAS_EVERY, shownGauges } from './hud';
import { parseCompanionPrefs } from './prefs';

afterEach(() => {
  vi.useRealTimers();
});

async function connected(options: ConstructorParameters<typeof FakeClient>[0] = {}): Promise<FakeClient> {
  const client = new FakeClient({ delayMs: 0, ...options });
  await client.connect();
  return client;
}

type Source = Parameters<typeof hudThreads>[0][number];

const thread = (id: string, more: Partial<Source> = {}): Source => ({
  id,
  title: id,
  projectId: 'p-1',
  status: 'running',
  runningSince: null,
  requestSince: null,
  progress: null,
  updatedAt: 0,
  ...more
});

const projects = new Map([['p-1', 'boite']]);

test('lists the threads at work but its own, the latest request first', () => {
  const rows = hudThreads(
    [
      thread('old', { requestSince: 1_000, runningSince: 2_000 }),
      thread('idle', { status: 'idle', requestSince: 9_000 }),
      thread('own', { requestSince: 8_000 }),
      thread('new', { status: 'queued', requestSince: 5_000, projectId: null, title: '' }),
      thread('waiting', { status: 'waiting', runningSince: 3_000 })
    ],
    projects,
    'own'
  );
  expect(rows.map((row) => row.id)).toEqual(['new', 'waiting', 'old']);
  expect(rows[0]).toMatchObject({ title: 'Untitled thread', project: '', step: 'Queued', since: 5_000 });
  expect(rows[1]).toMatchObject({ step: 'Waiting for you', since: 3_000 });
  // From the user's request, as the sidebar counts.
  expect(rows[2]).toMatchObject({ project: 'boite', step: 'At work', since: 1_000 });
});

test('words the step from the progress the core reports', () => {
  const progress = (phase: 'tool' | 'thinking', detail: string | null) => ({ turnId: 'turn-1', phase, detail, at: 0 });
  const [tool] = hudThreads([thread('a', { progress: progress('tool', 'bun run test') })], projects, null);
  const [thinking] = hudThreads([thread('b', { progress: progress('thinking', null) })], projects, null);
  expect(tool?.step).toBe('Running tool: bun run test');
  expect(thinking?.step).toBe('Thinking');
});

test('warns past 80 % used and alarms past 95 %', () => {
  expect([null, 0, 80, 80.5, 95, 95.1, 100].map(quotaLevel)).toEqual(['unknown', 'ok', 'ok', 'warning', 'warning', 'danger', 'danger']);
});

const entry = (id: string, usedPercents: number[], more: Partial<GatewayQuotaEntry> = {}): GatewayQuotaEntry => ({
  id,
  label: id,
  plan: null,
  accounts: 1,
  status: 'ready',
  error: null,
  updatedAt: 0,
  windows: usedPercents.map((usedPercent, index) => ({ id: `w${index}`, label: `Window ${index}`, usedPercent, resetsAt: null })),
  credits: [],
  ...more
});

const quotas = (entries: GatewayQuotaEntry[], status: SubscriptionProxyQuotas['status'] = 'ready'): SubscriptionProxyQuotas => ({
  status,
  updatedAt: 0,
  checkedAt: 0,
  error: null,
  providers: [{ providerId: 'claude', name: 'Claude', display: 'accounts', entries }]
});

test('draws one gauge per subscription, on its window nearest the limit', () => {
  const gauges = hudGauges(quotas([entry('a', [11, 64]), entry('b', [100, 82]), entry('off', [5], { status: 'disabled' }), entry('broken', [5], { status: 'error' })]));
  expect(gauges.map((gauge) => [gauge.name, gauge.used, gauge.level])).toEqual([
    ['a', 64, 'ok'],
    ['b', 100, 'danger'],
    ['broken', null, 'unknown']
  ]);
  expect(gauges[0]?.label).toBe('a, Window 1, 36% left');
  expect(gauges[1]?.label).toBe('b, Window 0, 0% left, nearly out');
  expect(gauges[2]?.label).toBe('broken, Window 0, unknown');
});

test('draws no gauge without a Douane, and unknown ones while it is out of reach', () => {
  expect(hudGauges(null)).toEqual([]);
  expect(hudGauges(quotas([entry('a', [10])], 'off'))).toEqual([]);
  expect(hudGauges(quotas([entry('a', [10])], 'unsupported'))).toEqual([]);
  expect(hudGauges(quotas([entry('a', [10])], 'unavailable')).map((gauge) => gauge.level)).toEqual(['unknown']);
});

test('keeps the quotas on unless told otherwise', () => {
  expect(parseCompanionPrefs({}).quotas).toBe(true);
  expect(parseCompanionPrefs({ quotas: false }).quotas).toBe(false);
  expect(parseCompanionPrefs({ quotas: 'no' }).quotas).toBe(true);
});

test('shows every gauge but the ones hidden in Settings, each with its provider for the logo', () => {
  const gauges = hudGauges(quotas([entry('a', [10]), entry('b', [20]), entry('c', [30])]));
  expect(gauges.map((gauge) => [gauge.id, gauge.providerId])).toEqual([['claude:a', 'claude'], ['claude:b', 'claude'], ['claude:c', 'claude']]);
  expect(shownGauges(gauges, [])).toBe(gauges);
  // A hidden id the gateway no longer reports changes nothing; a new subscription shows.
  expect(shownGauges(gauges, ['claude:b', 'codex:gone']).map((gauge) => gauge.id)).toEqual(['claude:a', 'claude:c']);
  expect(parseCompanionPrefs({}).hiddenQuotas).toEqual([]);
  expect(parseCompanionPrefs({ hiddenQuotas: ['claude:b', 'claude:b', '', 4, 'codex:x'] }).hiddenQuotas).toEqual(['claude:b', 'codex:x']);
  expect(parseCompanionPrefs({ hiddenQuotas: 'claude:b' }).hiddenQuotas).toEqual([]);
});

test('the HUD demo of the fake core has threads at work and a Douane', async () => {
  const client = await connected({ hudDemo: true });
  const now = Date.now();
  const rows = hudThreads(await client.call('threads.list', {}), new Map([['p-boite', 'boite'], ['p-notes', 'notes']]), null);
  expect(rows.map((row) => row.id)).toEqual(['t-hud-tests', 't-bench', 't-scheduler']);
  expect(rows[0]).toMatchObject({ project: 'notes', step: 'Running tool: bun run test' });
  expect(now - (rows[0]?.since ?? 0)).toBeLessThan(5 * 60_000);

  const reader = new GatewayReader();
  const stop = followQuotas(client, reader);
  await vi.waitFor(() => expect(reader.state?.status).toBe('ready'));
  const gauges = hudGauges(reader.state);
  expect(gauges.map((gauge) => gauge.level)).toEqual(['ok', 'danger', 'ok', 'ok']);
  expect(gauges[3]?.name).toBe('Antigravity · 10 accounts');

  // Switching the proxy off reaches the HUD through `quotasUpdated`.
  await client.call('subscriptionProxy.configure', {
    subscriptionProxy: { enabled: false, kind: 'douane', baseUrl: 'http://douane.lan:8787/v1', dashboardUrl: 'http://douane.lan:8787/admin/#quotas' }
  });
  expect(hudGauges(reader.state)).toEqual([]);
  stop();
});

test('reads the quotas again every minute until stopped', async () => {
  vi.useFakeTimers();
  const client = await connected();
  const call = vi.spyOn(client, 'call');
  const reader = new GatewayReader();
  const stop = followQuotas(client, reader);
  const reads = () => call.mock.calls.filter(([method]) => method === 'subscriptionProxy.quotas').length;
  expect(reads()).toBe(1);
  await vi.advanceTimersByTimeAsync(QUOTAS_EVERY);
  expect(reads()).toBe(2);
  // The seeded core has no proxy: nothing to draw.
  expect(hudGauges(reader.state)).toEqual([]);
  stop();
  await vi.advanceTimersByTimeAsync(QUOTAS_EVERY * 2);
  expect(reads()).toBe(2);
});
