<script lang="ts">
  import { untrack } from 'svelte';
  import { RefreshCw } from '@lucide/svelte';
  import InfoTip from './InfoTip.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import UsageLimits from './UsageLimits.svelte';
  import AccountRename from './AccountRename.svelte';
  import QuotaMachineScope from './QuotaMachineScope.svelte';
  import { namedQuotas, quotaReader, shownQuotas } from '../lib/quota-reader.svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import SubscriptionProxyDashboard from './SubscriptionProxyDashboard.svelte';
  import SubscriptionProxySettings from './SubscriptionProxySettings.svelte';

  /**
   * The subscription windows of every signed-in provider. The last reading
   * stays up while the next one loads, and a provider nobody connected is not
   * listed at all. Under them, the switch of every account that has limits to
   * read: the one place monitoring is turned on or off.
   */
  let { store, showTitle = true }: { store: Store; showTitle?: boolean } = $props();

  let reader = $derived(quotaReader(store.endpointUrl ?? 'here'));
  let rows = $derived(reader.rows === null ? null : shownQuotas(reader.rows, store.accounts));
  /** Every signed-in account with limits to read, switched on or not. */
  let tracked = $derived(namedQuotas(reader.rows ?? [], store.accounts).filter((row) => row.status !== 'unsupported'
    && store.accounts?.find((account) => account.id === row.accountId)?.status !== 'unauthenticated'));

  $effect(() => {
    const client = store.client;
    const current = reader;
    // A call before the socket is up is refused at once: read when it becomes
    // ready, and again after a reconnect. A failure shows on `reader.error`.
    if (!client || !store.owner || store.connection !== 'ready' || store.settings?.subscriptionProxy?.enabled) return;
    const off = client.on('quotas.updated', (value) => current.accept(value));
    untrack(() => void current.read(client).catch(() => {}));
    return off;
  });

  function refresh() {
    if (store.client) void reader.read(store.client, true).catch(() => {});
  }

  async function monitor(accountId: string, enabled: boolean) {
    if (!store.client) return;
    try { await reader.configure(store.client, accountId, enabled); }
    catch (error) { store.error = String(error); }
  }
</script>

<div class="page limits-page" data-testid="limits-page">
  {#if store.settings?.subscriptionProxy?.enabled}
    <SubscriptionProxyDashboard {store} />
  {:else}
  <header class="top">
    {#if showTitle}<h1><QuotaMachineScope {store} fallback={strings.usage.limits} /></h1>{/if}
    {#if store.owner}
      <button type="button" class="quiet icon refresh" aria-label={strings.usage.refresh} title={strings.usage.refresh} data-testid="limits-refresh" aria-busy={reader.loading} onclick={refresh}>
        <RefreshCw size={15} strokeWidth={1.75} class={reader.loading ? 'spinning' : ''} />
      </button>
    {/if}
  </header>

  {#if store.owner && reader.error}
    <div class="card failed" role="alert" data-testid="limits-error">
      <p>{fill(strings.quotas.readFailed, { error: reader.error })}</p>
      <button type="button" class="ghost small" disabled={reader.loading} data-testid="limits-retry" onclick={refresh}>{strings.quotas.retry}</button>
    </div>
  {/if}
  {#if !store.owner}
    <p class="muted" data-testid="usage-limits-owner">{strings.usage.limitsOwner}</p>
  {:else if rows === null}
    <div class="skeleton" role="status" aria-label={strings.quotas.loading}>
      {#each [0, 1] as index (index)}<div class="card ghost-card"></div>{/each}
    </div>
  {:else if rows.length === 0 && tracked.length === 0}
    <!-- A failed read never passes for "no provider connected". -->
    {#if !reader.error}<div class="card empty" data-testid="limits-empty">
      <p>{strings.quotas.empty}</p>
      <button type="button" onclick={() => store.showSettings('accounts')}>{strings.settings.connectProvider}</button>
    </div>{/if}
  {:else}
    {#if rows.length > 0}<UsageLimits {rows} {store} loading={reader.loading} completed={reader.completed} />{/if}
    <section class="card tracked" data-testid="limits-tracked">
      <h2>{strings.quotas.tracked}<InfoTip topic={strings.quotas.tracked} text={strings.quotas.trackedHint} /></h2>
      {#each tracked as row (row.accountId)}
        {@const account = row.accountId.startsWith('quota:') ? strings.quotas.cliSource : row.label}
        {@const entry = store.accounts?.find((entry) => entry.id === row.accountId)}
        <div class="tracked-account" data-testid="tracked-account" data-account-id={row.accountId}>
          <label class="track-row">
            <ProviderLogo providerId={row.providerId} size={16} />
            <span class="who"><span class="provider">{row.providerName}</span><span class="account">{account}</span></span>
            <input type="checkbox" role="switch" data-testid="quota-monitor" data-account-id={row.accountId} aria-label="{row.providerName} · {account}" checked={row.enabled} onchange={(event) => void monitor(row.accountId, event.currentTarget.checked)} />
          </label>
          {#if entry}<AccountRename {store} account={entry} />{/if}
        </div>
      {/each}
    </section>
  {/if}
  {#if store.owner}<details class="disclosure"><summary>{strings.subscriptionProxy.configure}</summary><SubscriptionProxySettings {store} /></details>{/if}
  {/if}
</div>

<style>
  .top { display: flex; align-items: center; gap: 8px; max-width: var(--settings-width); }
  .refresh { flex: none; margin-left: auto; width: var(--control); height: var(--control); padding: 0; }
  .refresh :global(.spinning) { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .muted { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .tracked { display: grid; gap: 2px; max-width: var(--settings-width); margin-top: 12px; padding: var(--settings-padding); }
  .tracked h2 { display: flex; align-items: center; margin: 0 0 8px; font-size: var(--text-base); font-weight: 600; }
  .track-row { display: flex; align-items: center; gap: 10px; min-height: var(--row); cursor: pointer; }
  .tracked-account { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 8px; }
  .tracked-account :global(form) { grid-column: 1 / -1; }
  .who { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; font-size: var(--text-sm); }
  .provider { flex: none; font-weight: 500; }
  .account { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); }
  @media (max-width: 480px) { .who { flex-direction: column; align-items: flex-start; gap: 2px; } .account { max-width: 100%; } }
  .failed { display: flex; align-items: center; justify-content: space-between; gap: 16px; max-width: var(--settings-width); margin-bottom: 12px; padding: var(--settings-padding); color: var(--color-danger); font-size: var(--text-sm); }
  .failed p { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .empty { display: flex; align-items: center; justify-content: space-between; gap: 16px; max-width: var(--settings-width); padding: var(--settings-padding); }
  .empty p { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .skeleton { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; max-width: var(--settings-width); }
  .ghost-card { height: 150px; margin: 0; animation: breathe 1.4s var(--ease-out-quint) infinite alternate; }
  @keyframes breathe { from { opacity: 0.45; } to { opacity: 0.9; } }
  @media (prefers-reduced-motion: reduce) {
    .refresh :global(.spinning), .ghost-card { animation: none; }
  }
</style>
