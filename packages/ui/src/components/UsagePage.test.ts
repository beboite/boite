import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { UsageHistory } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import UsagePage from './UsagePage.svelte';
import { workspace } from '../lib/workspace.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
const history = (edges: number[], providerId: string): UsageHistory => ({ edges, threads: [], rows: [{
  bucket: 0, providerId, model: null, turns: 2, reported: 0, priced: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: null }
}] });
const store = (call: unknown) => ({ client: { call, on: () => () => {} }, providers: [], threads: [] }) as unknown as Store;

test('a failed initial read stops loading, can be retried and distinguishes missing reports from zero', async () => {
  const call = vi.fn(async (_method: string, params: { edges: number[] }) => history(params.edges, 'removed-provider'));
  call.mockRejectedValueOnce(new Error('History unavailable'));
  mounted = mount(UsagePage, { target: document.body, props: { store: store(call) } });
  await settle();
  expect(document.querySelector('[role=alert]')?.textContent).toContain('History unavailable');
  expect(document.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('false');
  expect(document.body.textContent).not.toContain('Reading usage');
  click('[data-testid=usage-refresh]');
  await settle();
  expect(document.querySelector('[role=alert]')).toBeNull();
  expect(document.querySelector('[data-testid=usage-total]')?.textContent).toBe('Not reported');
  expect(document.querySelector('[data-provider=removed-provider]')?.textContent).toContain('Not reported');
  click('[data-testid=usage-metric-cost]');
  await settle();
  expect(document.querySelector('[data-testid=usage-total]')?.textContent).toBe('No cost reported');
});

test('changing the range invalidates an older read before it can overwrite the latest history', async () => {
  const pending: { edges: number[]; resolve: (result: UsageHistory) => void }[] = [];
  const call = vi.fn(async (_method: string, params: { edges: number[] }) => new Promise<UsageHistory>((resolve) => pending.push({ edges: params.edges, resolve })));
  mounted = mount(UsagePage, { target: document.body, props: { store: store(call) } });
  await settle();
  click('[data-testid=usage-range-7]');
  await settle();
  expect(pending).toHaveLength(2);
  pending[1]!.resolve(history(pending[1]!.edges, 'fresh'));
  await settle();
  pending[0]!.resolve(history(pending[0]!.edges, 'stale'));
  await settle();
  expect(document.querySelector('[data-provider=fresh]')).not.toBeNull();
  expect(document.querySelector('[data-provider=stale]')).toBeNull();
  expect(document.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('false');
});

test('switching machines drops the old provider list and ignores a late refresh from the previous client', async () => {
  let answer: ((result: UsageHistory) => void) | undefined;
  let oldEdges: number[] = [];
  const oldCall = vi.fn(async (_method: string, params: { edges: number[] }) => {
    oldEdges = params.edges;
    return history(params.edges, 'old-only');
  });
  const owners = new SvelteMap([['current', store(oldCall)]]);
  mounted = mount(UsagePage, { target: document.body, props: { get store() { return owners.get('current')!; } } });
  await settle();
  expect(document.querySelector('[data-provider=old-only]')).not.toBeNull();
  oldCall.mockImplementationOnce(async () => new Promise<UsageHistory>((resolve) => { answer = resolve; }));
  click('[data-testid=usage-refresh]');
  await settle();
  owners.set('current', store(vi.fn(async (_method: string, params: { edges: number[] }) => history(params.edges, 'new-only'))));
  await settle();
  answer!(history(oldEdges, 'late-old'));
  await settle();
  expect(document.querySelector('[data-provider=new-only]')).not.toBeNull();
  expect(document.querySelector('[data-provider=old-only]')).toBeNull();
  expect(document.querySelector('[data-provider=late-old]')).toBeNull();
});

test('legacy turns without a provider keep their totals without duplicating the all-providers menu option', async () => {
  mounted = mount(UsagePage, { target: document.body, props: { store: store(vi.fn(async (_method: string, params: { edges: number[] }) => history(params.edges, ''))) } });
  await settle();
  expect(document.querySelector('[data-testid=usage-overview]')?.textContent).toContain('Unknown provider');
  click('[data-testid=usage-provider-filter]');
  await settle();
  expect(document.querySelectorAll('[data-testid=usage-provider-filter-menu] [data-row]')).toHaveLength(1);
});

test('an older core with unfiltered rows or thread identities is reported instead of displaying them as filtered', async () => {
  const call = vi.fn(async (_method: string, params: { edges: number[] }) => history(params.edges, 'selected-provider'));
  mounted = mount(UsagePage, { target: document.body, props: { store: store(call) } });
  await settle();
  call.mockImplementationOnce(async (_method, params) => history(params.edges, 'another-provider'));
  click('[data-testid=usage-provider-filter]');
  await settle();
  click('[data-testid=usage-provider-filter-menu] [data-value=selected-provider]');
  await settle();
  expect(document.querySelector('[role=alert]')?.textContent).toContain('did not filter usage');
  expect(document.querySelector('[data-testid=usage-total]')).toBeNull();

  // Even with one execution provider in the range, an old core labels a switched
  // conversation with its current provider instead of the selected execution.
  call.mockImplementationOnce(async (_method, params) => {
    const result = history(params.edges, 'selected-provider');
    result.threads = [{ threadId: 'switched-thread', projectId: 'test-project', title: 'Switched provider', providerId: 'another-provider', archived: false, turns: 2, usage: result.rows[0]!.usage }];
    return result;
  });
  click('[data-testid=usage-refresh]');
  await settle();
  expect(document.querySelector('[role=alert]')?.textContent).toContain('did not filter usage');
  expect(document.querySelector('[data-testid=usage-total]')).toBeNull();
});

test('the machine menu reads one machine or adds every connected one, and names the machines it could not count', async () => {
  const spent = (edges: number[], providerId: string, threadId: string): UsageHistory => {
    const result = history(edges, providerId);
    result.threads = [{ threadId, projectId: 'project', title: `${threadId} title`, providerId, archived: false, turns: 2, usage: result.rows[0]!.usage }];
    return result;
  };
  const machine = (id: string, label: string, call: unknown, connection = 'ready') => {
    // A Store is a class instance, which `$state` keeps as it is rather than proxying.
    const owner = Object.assign(Object.create({}), store(call), { connection, threads: [] }) as Store;
    return { id, label, store: owner };
  };
  const here = machine('http://here', 'Here', vi.fn(async (_method: string, params: { edges: number[] }) => spent(params.edges, 'claude', 'same-id')));
  const builderCall = vi.fn(async (_method: string, params: { edges: number[] }) => spent(params.edges, 'codex', 'same-id'));
  const builder = machine('http://builder', 'Builder', builderCall);
  const asleep = machine('http://asleep', 'Asleep', vi.fn(), 'connecting');
  const gone = machine('http://gone', 'Gone', vi.fn(), 'closed');
  Object.assign(gone.store, { client: null });
  workspace.machines = [here, builder, asleep, gone];
  try {
    mounted = mount(UsagePage, { target: document.body, props: { store: here.store } });
    await settle();
    expect(document.querySelector('[data-testid=usage-machine-filter]')?.textContent).toContain('Here');
    expect(document.querySelector('[data-testid=usage-total]')?.textContent).toBe('Not reported');
    expect(document.querySelector('[data-provider=claude]')).not.toBeNull();
    expect(document.querySelector('[data-provider=codex]')).toBeNull();
    expect(builderCall).not.toHaveBeenCalled();

    click('[data-testid=usage-machine-filter]');
    await settle();
    click('[data-testid=usage-machine-filter-menu] [data-value="http://builder"]');
    await settle();
    expect(document.querySelector('[data-provider=codex]')).not.toBeNull();
    expect(document.querySelector('[data-provider=claude]')).toBeNull();

    click('[data-testid=usage-machine-filter]');
    await settle();
    document.querySelectorAll<HTMLElement>('[data-testid=usage-machine-filter-menu] [data-row]')[0]!.click();
    await settle();
    expect(document.querySelector('[data-testid=usage-machine-filter]')?.textContent).toContain('All machines');
    expect(document.querySelector('[data-provider=claude]')).not.toBeNull();
    expect(document.querySelector('[data-provider=codex]')).not.toBeNull();
    click('[data-testid=usage-metric-turns]');
    await settle();
    expect(document.querySelector('[data-testid=usage-total]')?.textContent).toBe('4');
    // The same thread id on two machines is two threads, each named with its machine.
    const rows = [...document.querySelectorAll('[data-testid=usage-threads] li')].map((row) => row.textContent);
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row?.includes('Here'))).toBe(true);
    expect(rows.some((row) => row?.includes('Builder'))).toBe(true);
    expect(document.querySelector('[data-testid=usage-offline]')?.textContent).toContain('Asleep');

    // A machine that fails is named; the others still count.
    builderCall.mockRejectedValueOnce(new Error('History unavailable'));
    click('[data-testid=usage-refresh]');
    await settle();
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Builder: History unavailable');
    expect(document.querySelector('[data-testid=usage-total]')?.textContent).toBe('2');

    // When no machine answers, the earlier totals go rather than standing for machines nobody counted.
    builderCall.mockRejectedValueOnce(new Error('History unavailable'));
    (here.store.client!.call as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Core stopped'));
    click('[data-testid=usage-refresh]');
    await settle();
    const alerts = [...document.querySelectorAll('[role=alert]')].map((alert) => alert.textContent);
    expect(alerts.some((alert) => alert?.includes('Here: Core stopped'))).toBe(true);
    expect(alerts.some((alert) => alert?.includes('Builder: History unavailable'))).toBe(true);
    expect(document.querySelector('[data-testid=usage-total]')).toBeNull();

    // A machine with no client is named, not read forever, and shows none of the previous totals.
    click('[data-testid=usage-machine-filter]');
    await settle();
    click('[data-testid=usage-machine-filter-menu] [data-value="http://gone"]');
    await settle();
    expect(document.querySelector('[data-testid=usage-offline]')?.textContent).toContain('Gone');
    expect(document.querySelector('[data-testid=usage-total]')).toBeNull();
    expect(document.body.textContent).not.toContain('Reading usage');
  } finally {
    workspace.machines = [];
  }
});
