<script lang="ts">
  import { onMount } from 'svelte';
  import type { Account, Settings } from '@boite/contracts';
  import { WsClient, type Client } from './lib/client';
  import { resolveEndpoint } from './lib/endpoint';
  import { startTheme } from './lib/theme';
  import { strings } from './lib/strings';
  import { quotaReader, shownQuotas, type QuotaReader } from './lib/quota-reader.svelte';
  import QuotaPopup from './components/QuotaPopup.svelte';
  // The last reading this computer saw draws the first frame; the fresh one replaces it.
  let reader = $state<QuotaReader>(quotaReader('here'));
  let accounts = $state.raw<Account[] | undefined>(undefined);
  let rows = $derived(shownQuotas(reader.rows ?? [], accounts));
  let error = $state('');
  let settings = $state<Settings | null>(null);
  let client: Client | null = null;
  // Windows 11 rounds the popup and draws its border: the shell says so in the URL.
  const frame = new URLSearchParams(location.search).get('frame') === 'native' ? 'native' : undefined;
  let visible = true;
  let disposed = false;
  let pendingAccounts: Map<string, Account | null> | null = null;
  let settingsRevision = 0;
  async function readSettings() {
    if (!client) return;
    const revision = settingsRevision;
    const value = await client.call('settings.get', {});
    if (!disposed && revision === settingsRevision) settings = value;
  }
  async function refresh(force = false) {
    if (reader.loading || pendingAccounts || !client || disposed) return;
    const updates = new Map<string, Account | null>();
    pendingAccounts = updates;
    try {
      await Promise.all([reader.read(client, force), readSettings(), client.call('accounts.list', {}).then((list) => {
        // Events arriving after this request win over the older snapshot.
        for (const [id, account] of updates) {
          list = list.filter((entry) => entry.id !== id);
          if (account) list.push(account);
        }
        accounts = list;
      }).finally(() => { if (pendingAccounts === updates) pendingAccounts = null; })]);
      error = '';
    }
    catch (cause) { error = String(cause); }
  }
  async function reorder(quotaOrder: string[]): Promise<boolean> {
    if (!client) return false;
    try { settings = await client.call('settings.set', { quotaOrder }); error = ''; return true; }
    catch (cause) { error = String(cause); return false; }
  }
  async function action(action: string) {
    if (!window.__TAURI_INTERNALS__) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('quota_window', { action });
    } catch (cause) { error = String(cause); }
  }
  onMount(() => {
    const off = [startTheme()];
    const initialize = async () => {
      // Same gate as `Store.boot`: the constant folds, so the fake core is in
      // the dev bundle and in vitest, never in what ships.
      if (import.meta.env.DEV && new URLSearchParams(location.search).get('fake') === '1') {
        const { FakeClient } = await import('./lib/fake-client'); client = new FakeClient();
      } else {
        const endpoint = await resolveEndpoint();
        if (!endpoint) throw new Error(strings.errors.noEndpoint);
        reader = quotaReader(endpoint.url);
        const ws = new WsClient({ ...endpoint, clientName: 'shell' }); client = ws;
        off.push(ws.onState((state) => { if (state === 'ready' && visible) void refresh(); }));
      }
      if (disposed) { client.close(); return; }
      await client.connect();
      if (disposed) { client.close(); return; }
      off.push(client.on('settings.updated', (value) => { settingsRevision++; settings = value; }));
      off.push(client.on('quotas.updated', (value) => reader.accept(value)));
      off.push(client.on('accounts.updated', (account) => {
        pendingAccounts?.set(account.id, account);
        accounts = accounts?.some((entry) => entry.id === account.id)
          ? accounts.map((entry) => entry.id === account.id ? account : entry)
          : [...(accounts ?? []), account];
      }));
      off.push(client.on('accounts.removed', ({ accountId }) => {
        pendingAccounts?.set(accountId, null);
        accounts = accounts?.filter((entry) => entry.id !== accountId);
      }));
      if (window.__TAURI_INTERNALS__) {
        const { listen } = await import('@tauri-apps/api/event');
        const opened = await listen('tray://open', () => { visible = true; void refresh(); });
        const closed = await listen('tray://closed', () => { visible = false; });
        if (disposed) { opened(); closed(); return; }
        off.push(opened, closed);
      }
      await refresh();
    };
    void initialize().catch((cause) => { error = String(cause); });
    const timer = setInterval(() => { if (visible) void refresh(); }, 60_000);
    return () => { disposed = true; clearInterval(timer); off.forEach((stop) => stop()); client?.close(); };
  });
</script>
<svelte:window onkeydown={(event) => { if (event.key === 'Escape') void action('hide'); }} />
<main data-testid="quota-popup" data-frame={frame}>
  <QuotaPopup rows={reader.rows === null ? null : rows} loading={reader.loading} completed={reader.completed} {error}
    order={settings?.quotaOrder ?? []} {reorder} refresh={() => void refresh(true)}
    connect={() => void action('providers')} settings={() => void action('limits')} close={() => void action('hide')} />
</main>
<style>
  /* Windows 11 draws the native frame; other hosts use the same edge as the in-app popup. */
  main { height: 100dvh; display: flex; flex-direction: column; background: var(--color-surface-2); border: 1px solid var(--color-edge); overflow: hidden; }
  main[data-frame='native'] { border: none; }
  main :global(.quota-popup) { flex: 1; }
</style>
