import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { UsageHistory } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import UsagePage from './UsagePage.svelte';

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
