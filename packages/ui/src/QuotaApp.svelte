<script lang="ts">
  import { onMount } from 'svelte';
  import { RefreshCw, Settings2, X, Power } from '@lucide/svelte';
  import type { AccountQuota } from '@boite/contracts';
  import { WsClient, type Client } from './lib/client';
  import { resolveEndpoint } from './lib/endpoint';
  import { startTheme } from './lib/theme';
  import { strings } from './lib/strings';
  import QuotaList from './components/QuotaList.svelte';
  let rows = $state<AccountQuota[]>([]);
  let busy = $state(false);
  let error = $state('');
  let client: Client | null = null;
  let visible = true;
  let disposed = false;
  async function refresh(force = false) {
    if (busy || !client || disposed) return;
    busy = true;
    try { rows = await client.call('quotas.list', { refresh: force }); error = ''; }
    catch (cause) { error = String(cause); }
    finally { busy = false; }
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
        const ws = new WsClient({ ...endpoint, clientName: 'shell' }); client = ws;
        off.push(ws.onState((state) => { if (state === 'ready' && visible) void refresh(); }));
      }
      if (disposed) { client.close(); return; }
      await client.connect();
      off.push(client.on('quotas.updated', (value) => { rows = value; }));
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
<main data-testid="quota-popup">
  <header><h1>{strings.quotas.heading}</h1><div class="actions">
    <button class="ghost icon" aria-label={strings.quotas.refresh} disabled={busy} onclick={() => void refresh(true)}><RefreshCw size={15} /></button>
    <button class="ghost icon" aria-label={strings.common.close} onclick={() => void action('hide')}><X size={15} /></button>
  </div></header>
  <section>
    {#if busy && rows.length === 0}<p class="muted" role="status">{strings.quotas.loading}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <QuotaList rows={rows.filter((row) => row.enabled && row.status !== 'unsupported')} compact />
  </section>
  <footer><button class="ghost" onclick={() => void action('providers')}><Settings2 size={15} />{strings.quotas.providers}</button><button class="ghost icon" aria-label={strings.quotas.quit} onclick={() => void action('quit')}><Power size={15} /></button></footer>
</main>
<style>
  main { height: 100dvh; display: flex; flex-direction: column; background: var(--color-background); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); overflow: hidden; }
  header, footer { display: flex; align-items: center; justify-content: space-between; flex: none; padding: 10px 12px; gap: 8px; }
  header { border-bottom: 1px solid var(--color-border); }
  footer { border-top: 1px solid var(--color-border); }
  h1 { font-size: var(--text-md); }
  .actions { display: flex; gap: 2px; }
  section { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
  .muted { color: var(--color-muted-foreground); }
  .error { color: var(--color-danger); }
</style>
