import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { RpcErrorCode } from '@boite/contracts';
import HooksCard from './HooksCard.svelte';
import { RpcFailure } from '../lib/client';
import { FakeClient } from '../lib/fake-client';
import type { Store } from '../lib/store.svelte';

let mounted: Record<string, unknown> | null = null;
const clients: FakeClient[] = [];
afterEach(() => {
  if (mounted) unmount(mounted, { outro: false });
  mounted = null;
  for (const client of clients.splice(0)) client.close();
  document.body.innerHTML = '';
});

async function onFake(): Promise<FakeClient> {
  const client = new FakeClient({ delayMs: 0 });
  clients.push(client);
  await client.connect();
  const store = { client, owner: true, connection: 'ready', providerOf: () => undefined } as unknown as Store;
  mounted = mount(HooksCard, { target: document.body, props: { store } });
  await vi.waitFor(() => { flushSync(); expect(document.querySelector('[data-testid="hooks-recent"]')).not.toBeNull(); });
  return client;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-testid="hooks-provider"][data-provider="${id}"]`)!;
const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
/** The counters one by one: the dots between them are drawn, not read. */
const counters = (id: string) => [...row(id).querySelectorAll('[data-testid="hooks-counters"] > span:not(.dot)')].map(text);

test('each agent shows what it found, its counters and what a separate account misses', async () => {
  await onFake();
  expect(text(row('claude').querySelector('summary'))).toContain('13 hooks');
  expect(counters('claude')).toEqual(['412 runs', '2 blocked', '1 failed']);
  expect(counters('codex')).toEqual(['58 runs', '1 blocked', '1 skipped']);
  // Only a problem shows open; Claude's second seat gets everything, so nothing under its row.
  expect(row('claude').querySelector('[data-testid="hooks-issue"]')).toBeNull();
  expect(text(row('codex').querySelector('[data-testid="hooks-issue"]'))).toContain('Work does not get config.toml');
  // Agents Boite does not see run: no counters, and the fold says why.
  expect(row('grok').querySelector('[data-testid="hooks-counters"]')).toBeNull();
  expect(text(row('grok').querySelector('.detail'))).toContain('does not see each run');
  expect(text(row('pi').querySelector('summary'))).toContain('Nothing found');
  expect(text(row('opencode').querySelector('summary'))).toContain('2 modules');
  expect(row('echo')).toBeNull();
  expect(text(document.querySelector('[data-testid="hooks-without"]'))).toBe('Antigravity and Echo do not run hooks.');
  const runs = [...document.querySelectorAll<HTMLElement>('[data-testid="hooks-run"]')];
  expect(runs.map(run => run.dataset.outcome)).toEqual(['blocked', 'skipped', 'blocked', 'failed', 'blocked']);
  expect(text(runs[3]!)).toContain('Claude · Stop');
  expect(text(runs[4]!)).toContain('Claude · PreToolUse:Bash');
  expect(text(runs[1]!)).toContain('Codex · PreToolUse · check-branch.sh');
});

test('a run announced by hooks.changed reaches the card without a reload', async () => {
  const client = await onFake();
  client.recordHookRun({ at: Date.now(), providerId: 'claude', accountId: null, threadId: null, event: 'Stop', name: 'Stop', outcome: 'failed', message: 'the hook timed out' });
  await vi.waitFor(() => {
    flushSync();
    expect(document.querySelectorAll('[data-testid="hooks-recent"] [data-testid="hooks-run"]')).toHaveLength(5);
    expect(text(document.querySelector('[data-testid="hooks-run"]'))).toContain('the hook timed out');
  });
  expect(counters('claude')).toEqual(['413 runs', '2 blocked', '2 failed']);
  // The sixth is folded under the five newest.
  expect(text(document.querySelector('.more > summary'))).toBe('Show 1 more');
});

test('a core without hooks.status says to update it', async () => {
  const call = vi.fn(async () => { throw new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'unknown method hooks.status' }); });
  const store = { client: { call, on: () => () => {} }, owner: true, connection: 'ready' } as unknown as Store;
  mounted = mount(HooksCard, { target: document.body, props: { store } });
  await vi.waitFor(() => { flushSync(); expect(text(document.querySelector('[data-testid="hooks-missing"]'))).toBe('Update Boite on this machine to see your hooks.'); });
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
