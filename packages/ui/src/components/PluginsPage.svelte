<script lang="ts">
  import { onMount } from 'svelte';
  import { Puzzle, Download, RefreshCw } from '@lucide/svelte';
  import type { PluginPool, PluginState, RpcParams } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { confirm } from '../lib/confirm.svelte';
  import QuotaList from './QuotaList.svelte';
  let { store }: { store: Store } = $props();
  let plugin = $state<PluginState | null>(null);
  let pools = $state<PluginPool[]>([]);
  let busy = $state(false);
  let error = $state('');
  const id = 'kebacc-switcher';
  async function loadPools(refresh = false) {
    if (!store.client || busy) return;
    busy = true;
    try { pools = await store.client.call('plugins.accounts', { id, refresh }); error = ''; }
    catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
  async function change(method: 'plugins.install' | 'plugins.cancel' | 'plugins.uninstall') {
    if (!store.client) return;
    if (method === 'plugins.uninstall' && !await confirm.ask({ title: strings.plugins.removeTitle, body: strings.plugins.removeBody, confirmLabel: strings.plugins.remove, cancelLabel: strings.common.cancel, danger: true })) return;
    busy = true;
    try {
      plugin = await store.client.call(method, { id }); error = '';
      if (!plugin.version) pools = [];
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
    if (plugin?.status === 'installed') await loadPools();
  }
  async function accountAction(provider: string, action: RpcParams<'plugins.accountAction'>['action'], email?: string) {
    if (!store.client) return;
    if (action !== 'add' && !await confirm.ask({ title: action === 'switch' ? strings.plugins.switchTitle : strings.plugins.forgetTitle,
      body: action === 'switch' ? strings.plugins.switchBody : strings.plugins.forgetBody,
      confirmLabel: action === 'switch' ? strings.plugins.switch : strings.plugins.forget, cancelLabel: strings.common.cancel, danger: action === 'remove' })) return;
    busy = true;
    try { pools = await store.client.call('plugins.accountAction', { id, provider, action, ...(email ? { email } : {}) }); error = ''; }
    catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
  onMount(() => {
    const client = store.client; if (!client) return;
    let disposed = false;
    const off = client.on('plugins.updated', (value) => {
      plugin = value;
      if (value.status === 'installed') void loadPools();
      if (!value.version) pools = [];
    });
    void client.call('plugins.list', {}).then(async (rows) => {
      if (disposed) return;
      plugin = rows[0] ?? null;
      if (plugin?.version) await loadPools();
    }).catch((cause) => { error = String(cause); });
    return () => { disposed = true; off(); };
  });
</script>
<div class="page" data-testid="plugins-page">
  <header><h1>{strings.plugins.heading}</h1></header>
  <p class="intro">{strings.plugins.intro}</p>
  <section class="card plugin">
    <header><div class="identity"><Puzzle size={24} /><div><h2>kebacc-switcher</h2><span>{plugin?.version ? `${strings.plugins.installed} · ${plugin.version}` : `v${plugin?.availableVersion ?? '2.0.1'}`}</span></div></div>
      {#if plugin?.status === 'installing'}<button class="quiet" onclick={() => void change('plugins.cancel')}>{strings.common.cancel}</button>
      {:else if plugin?.version}<div class="actions">
        {#if plugin.version !== plugin.availableVersion}<button disabled={busy} onclick={() => void change('plugins.install')}>{strings.plugins.update}</button>{/if}
        <button class="quiet" disabled={busy} data-testid="plugin-uninstall" onclick={() => void change('plugins.uninstall')}>{strings.plugins.remove}</button>
      </div>
      {:else}<button class="primary" disabled={busy || !plugin} data-testid="plugin-install" onclick={() => void change('plugins.install')}><Download size={15} />{strings.plugins.install}</button>{/if}
    </header>
    <p>{strings.plugins.description}</p>
    <a href="https://github.com/kebab1337420/kebacc-switch" target="_blank" rel="noreferrer">{strings.plugins.source}</a>
    {#if plugin?.status === 'installing'}<p role="status">{strings.plugins.installing} · {plugin.progress}%</p><progress max="100" value={plugin.progress}></progress>{/if}
    {#if plugin?.error}<p class="error" role="alert">{plugin.error}</p>{/if}
  </section>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if plugin?.version}
    <div class="pool-heading"><p class="intro">{strings.plugins.cliScope}</p><button class="quiet" disabled={busy} onclick={() => void loadPools(true)}><RefreshCw size={15} />{strings.plugins.refresh}</button></div>
    {#each pools as pool (pool.provider)}
      <section class="card pool" data-testid="plugin-pool" data-provider={pool.provider}>
        <header><h2>{pool.provider}</h2><button class="quiet" disabled={busy} onclick={() => void accountAction(pool.provider, 'add')}>{strings.plugins.add}</button></header>
        {#if pool.accounts.length === 0}<p class="intro">{strings.plugins.empty}</p>{/if}
        {#each pool.accounts as account (account.email)}
          <div class="saved-account" data-testid="plugin-account" data-email={account.email}>
            <QuotaList rows={[{ accountId: account.email, providerId: pool.provider, providerName: account.email, label: account.active ? strings.plugins.active : '', enabled: true,
              status: account.checkedSecondsAgo === null ? 'unavailable' : 'ready', windows: account.windows,
              checkedAt: account.checkedSecondsAgo === null ? null : Date.now() - account.checkedSecondsAgo * 1000, error: null }]} />
            <div class="actions">
              <button class="quiet" disabled={busy || account.active} data-testid="plugin-switch" onclick={() => void accountAction(pool.provider, 'switch', account.email)}>{strings.plugins.switch}</button>
              <button class="ghost" disabled={busy} onclick={() => void accountAction(pool.provider, 'remove', account.email)}>{strings.plugins.forget}</button>
            </div>
          </div>
        {/each}
      </section>
    {/each}
  {/if}
</div>
<style>
  .intro, .identity span, .plugin p { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .plugin, .pool { max-width: 800px; }
  header, .identity, .actions, .pool-heading { display: flex; align-items: center; gap: 12px; }
  header, .pool-heading { justify-content: space-between; }
  .identity h2 { margin: 0 0 4px; text-transform: none; font-size: var(--text-md); }
  .pool h2 { text-transform: capitalize; }
  .saved-account { margin-top: 12px; }
  .saved-account .actions { justify-content: flex-end; margin-top: 6px; }
  .error { color: var(--color-danger); }
  .pool-heading { max-width: 800px; margin: 20px 0 12px; }
  progress { width: 100%; accent-color: var(--color-foreground); }
  @media (max-width: 720px) { header, .pool-heading { align-items: flex-start; flex-wrap: wrap; } .actions { flex-wrap: wrap; } }
</style>
