<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowUpRight, Download, Puzzle, RefreshCw } from '@lucide/svelte';
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
  <header><div><h1>{strings.plugins.heading}</h1><p>{strings.plugins.intro}</p></div></header>
  <section class="card plugin">
    <div class="head"><div class="identity"><span class="logo"><Puzzle size={20} strokeWidth={1.75} /></span><div><h2>kebacc-switcher</h2><span class="version">{plugin?.version ? `${strings.plugins.installed} · ${plugin.version}` : `v${plugin?.availableVersion ?? '2.0.1'}`}</span></div></div>
      {#if plugin?.status === 'installing'}<button class="quiet" onclick={() => void change('plugins.cancel')}>{strings.common.cancel}</button>
      {:else if plugin?.version}<div class="actions">
        {#if plugin.version !== plugin.availableVersion}<button disabled={busy} onclick={() => void change('plugins.install')}>{strings.plugins.update}</button>{/if}
        <button class="quiet" disabled={busy} data-testid="plugin-uninstall" onclick={() => void change('plugins.uninstall')}>{strings.plugins.remove}</button>
      </div>
      {:else}<button class="primary" disabled={busy || !plugin} data-testid="plugin-install" onclick={() => void change('plugins.install')}><Download size={15} />{strings.plugins.install}</button>{/if}
    </div>
    <p class="hint description">{strings.plugins.description}</p>
    <a class="source" href="https://github.com/kebab1337420/kebacc-switch" target="_blank" rel="noreferrer">{strings.plugins.source}<ArrowUpRight size={13} /></a>
    {#if plugin?.status === 'installing'}<p class="hint" role="status">{strings.plugins.installing} · {plugin.progress}%</p><progress max="100" value={plugin.progress}></progress>{/if}
    {#if plugin?.error}<p class="error" role="alert">{plugin.error}</p>{/if}
  </section>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if plugin?.version}
    <div class="group-heading"><p>{strings.plugins.cliScope}</p><button class="quiet" disabled={busy} onclick={() => void loadPools(true)}><RefreshCw size={15} />{strings.plugins.refresh}</button></div>
    {#each pools as pool (pool.provider)}
      <section class="card pool" data-testid="plugin-pool" data-provider={pool.provider}>
        <div class="head"><h2>{pool.provider}</h2><button class="quiet" disabled={busy} onclick={() => void accountAction(pool.provider, 'add')}>{strings.plugins.add}</button></div>
        {#if pool.accounts.length === 0}<p class="hint">{strings.plugins.empty}</p>{/if}
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
  .head, .identity, .actions { display: flex; align-items: center; gap: 12px; }
  .head { justify-content: space-between; }
  .card .head h2 { margin: 0; }
  .pool .head { margin-bottom: 12px; }
  .pool .head h2 { text-transform: capitalize; }
  .logo { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border-radius: var(--radius-md); background: var(--color-surface-3); color: var(--color-muted-foreground); }
  .version { display: block; margin-top: 2px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .description { margin-top: 16px; }
  .source { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px; font-size: var(--text-sm); text-decoration: none; }
  .source:hover { text-decoration: underline; }
  .saved-account { margin-top: 12px; }
  .saved-account .actions { justify-content: flex-end; margin-top: 6px; }
  .error { color: var(--color-danger); }
  progress { width: 100%; margin-top: 8px; accent-color: var(--color-foreground); }
  @media (max-width: 720px) { .head { align-items: flex-start; flex-wrap: wrap; } .actions { flex-wrap: wrap; } }
</style>
