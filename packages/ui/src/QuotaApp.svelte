<script lang="ts">
  import { onMount } from 'svelte';
  import { RefreshCw, Settings2, X, Power } from '@lucide/svelte';
  import type { Account } from '@boite/contracts';
  import { WsClient, type Client } from './lib/client';
  import { resolveEndpoint } from './lib/endpoint';
  import { startTheme } from './lib/theme';
  import { strings } from './lib/strings';
  import { quotaReader, shownQuotas, type QuotaReader } from './lib/quota-reader.svelte';
  import QuotaOverview from './components/QuotaOverview.svelte';
  // The last reading this computer saw draws the first frame; the fresh one replaces it.
  let reader = $state<QuotaReader>(quotaReader('here'));
  let accounts = $state.raw<Account[] | undefined>(undefined);
  let rows = $derived(shownQuotas(reader.rows ?? [], accounts));
  let error = $state('');
  let client: Client | null = null;
  // Windows 11 rounds the popup and draws its border: the shell says so in the URL.
  const frame = new URLSearchParams(location.search).get('frame') === 'native' ? 'native' : undefined;
  let visible = true;
  let disposed = false;
  async function refresh(force = false) {
    if (reader.loading || !client || disposed) return;
    try {
      const [, list] = await Promise.all([reader.read(client, force), client.call('accounts.list', {})]);
      accounts = list;
      error = '';
    }
    catch (cause) { error = String(cause); }
  }
  async function action(action: string) {
    if (!window.__TAURI_INTERNALS__) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (action === 'quit') await invoke('quit_shell');
      else await invoke('quota_window', { action });
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
      off.push(client.on('quotas.updated', (value) => reader.accept(value)));
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
  <header><h1>{strings.quotas.trayHeading}</h1><div class="actions">
    <button class="ghost icon" aria-label={strings.quotas.refresh} aria-busy={reader.loading} data-testid="quota-refresh" onclick={() => void refresh(true)}><RefreshCw size={15} class={reader.loading ? 'spinning' : ''} /></button>
    <button class="ghost icon" aria-label={strings.common.close} onclick={() => void action('hide')}><X size={15} /></button>
  </div></header>
  <section>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if reader.rows === null}<p class="muted" role="status">{strings.quotas.loading}</p>
    {:else}<QuotaOverview {rows} loading={reader.loading} connect={() => void action('providers')} />{/if}
  </section>
  <footer><button class="ghost" onclick={() => void action('providers')}><Settings2 size={15} />{strings.quotas.providers}</button><button class="ghost icon" aria-label={strings.quotas.quit} onclick={() => void action('quit')}><Power size={15} /></button></footer>
</main>
<style>
  /* The window is opaque and square; Windows 11 rounds and borders it itself. */
  main { height: 100dvh; display: flex; flex-direction: column; background: var(--color-background); border: 1px solid var(--color-edge); overflow: hidden; }
  main[data-frame='native'] { border: none; }
  header, footer { display: flex; align-items: center; justify-content: space-between; flex: none; padding: 10px 12px; gap: 8px; }
  header { border-bottom: 1px solid var(--color-border); }
  footer { border-top: 1px solid var(--color-border); }
  h1 { font-size: var(--text-md); }
  .actions :global(.spinning) { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .actions :global(.spinning) { animation: none; } }
  .actions { display: flex; gap: 2px; }
  section { flex: 1; min-height: 0; overflow: auto; padding: 4px 12px; }
  .muted { padding: 16px 4px; margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .error { color: var(--color-danger); }
</style>
