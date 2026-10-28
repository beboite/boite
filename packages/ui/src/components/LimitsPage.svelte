<script lang="ts">
  import { workspace } from '../lib/workspace.svelte';
  import { untrack } from 'svelte';
  import { RefreshCw } from '@lucide/svelte';
  import { subscriptionProxyName, type AccountQuota, type QuotaAlertPeriod } from '@boite/contracts';
  import { errorText } from '../lib/errors';
  import InfoTip from './InfoTip.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import UsageLimits from './UsageLimits.svelte';
  import AccountRename from './AccountRename.svelte';
  import QuotaMachineScope from './QuotaMachineScope.svelte';
  import { gatewayReader, namedQuotas, quotaProviderOff, quotaReader, shownQuotas } from '../lib/quota-reader.svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { MediaQuery } from 'svelte/reactivity';
  import { desktopSettings } from '../lib/settings-tabs';
  import SubscriptionProxyDashboard from './SubscriptionProxyDashboard.svelte';
  import GatewayOpenButton from './GatewayOpenButton.svelte';
  import SubscriptionProxySettings from './SubscriptionProxySettings.svelte';
  import GatewaySwitch from './GatewaySwitch.svelte';
  import QuotaPin from './QuotaPin.svelte';

  /**
   * The subscription windows of every signed-in provider. The last reading
   * stays up while the next one loads, and a provider nobody connected is not
   * listed at all. Under them, the switch of every account that has limits to
   * read: the one place monitoring is turned on or off.
   */
  let { store, showTitle = true }: { store: Store; showTitle?: boolean } = $props();
  const uid = $props.id();
  /** Providers is a desktop settings page and the owner's: a phone is offered no way to it. */
  const phoneWidth = new MediaQuery('(max-width: 720px)');
  let providersReachable = $derived(store.owner && desktopSettings(phoneWidth.current));
  let native = $state(false);
  const proxy = $derived(store.settings?.subscriptionProxy);
  const proxyEnabled = $derived(proxy?.enabled === true);
  const proxyName = $derived(proxy ? subscriptionProxyName(proxy.kind) : '');
  /** Who answers for the limits: the gateway's kind, or this machine's own logins. */
  const route = $derived(proxyEnabled ? proxy!.kind : 'native');

  let reader = $derived(quotaReader(store.endpointUrl ?? 'here', store.core));
  let gateway = $derived(gatewayReader(store.endpointUrl ?? 'here'));
  /**
   * Douane serving its quotas: its entries are native bars like any account's.
   * CLIProxyAPI, or a Douane without the route, keeps its dashboard. A paired
   * phone reads the same bars as the owner.
   */
  const gatewayNative = $derived(proxyEnabled && proxy?.kind === 'douane' && gateway.state?.status !== 'unsupported');
  const dashboard = $derived(proxyEnabled && !gatewayNative && !native);
  const gatewayError = $derived(gatewayNative && gateway.state?.status === 'unavailable' ? gateway.state.error : null);

  let shown = $derived(reader.rows === null ? null : shownQuotas(reader.rows, store.accounts, store.providers));
  /** The card above says why the gateway's bars are old; each bar only dims. */
  let gatewayRows = $derived(gatewayNative ? (shown ?? []).filter((row) => row.gateway).map((row) => gatewayError ? { ...row, error: null } : row) : []);
  let rows = $derived(shown === null ? null : shown.filter((row) => !row.gateway));
  /** One heading per provider the gateway reports, in its order. */
  let gatewayGroups = $derived(gatewayRows.reduce<{ providerId: string; name: string; rows: AccountQuota[] }[]>((groups, row) => {
    const group = groups.find((entry) => entry.providerId === row.providerId);
    if (group) group.rows.push(row);
    else groups.push({ providerId: row.providerId, name: row.providerName, rows: [row] });
    return groups;
  }, []));
  /** Every signed-in account with limits to read, switched on or not. The gateway's entries are always read. */
  let tracked = $derived(namedQuotas(reader.rows ?? [], store.accounts).filter((row) => !row.gateway && row.status !== 'unsupported' && !quotaProviderOff(row, store.providers)
    && store.accounts?.find((account) => account.id === row.accountId)?.status !== 'unauthenticated'));

  $effect(() => {
    const client = store.client;
    const current = reader;
    // A call before the socket is up is refused at once: read when it becomes
    // ready, and again after a reconnect. A failure shows on `reader.error`.
    // The switch above can hand the limits to the gateway or back: read again then too.
    void route;
    if (!client || store.connection !== 'ready' || dashboard) return;
    const off = client.on('quotas.updated', (value) => current.accept(value));
    untrack(() => void current.read(client).catch(() => {}));
    return off;
  });

  // Whether Douane serves its quotas, asked again for another gateway.
  $effect(() => {
    const client = store.client;
    const current = gateway;
    if (!client || store.connection !== 'ready' || !proxyEnabled || proxy?.kind !== 'douane' || !proxy.baseUrl) return;
    const off = client.on('subscriptionProxy.quotasUpdated', (value) => current.accept(value));
    untrack(() => void current.read(client));
    return off;
  });

  /** A paired device reads again what the core holds; only the owner makes it ask the providers. */
  function refresh() {
    if (store.client) void reader.read(store.client, store.owner).catch(() => {});
  }

  /** A switch saves when it flips; a refusal puts it back. */
  async function toggleAutoResume(input: HTMLInputElement) {
    const ok = await store.saveSettings({ autoResumeLimitedThreads: input.checked });
    if (!ok) input.checked = store.settings?.autoResumeLimitedThreads === true;
  }

  /** A device may set alerts too: they decide when a window it already reads notifies. */
  async function alert(accountId: string, period: QuotaAlertPeriod, thresholds: number[]) {
    if (!store.client) return;
    try { await reader.alert(store.client, accountId, period, thresholds); }
    catch (error) { store.error = fill(strings.quotas.alertFailed, { error: errorText(error) }); }
  }

  async function monitor(accountId: string, enabled: boolean) {
    if (!store.client) return;
    try { await reader.configure(store.client, accountId, enabled); }
    catch (error) { store.error = String(error); }
  }
</script>

<div class="page limits-page" data-testid="limits-page">
  {#if dashboard}
    <SubscriptionProxyDashboard {store} onNative={() => native = true} />
  {:else}
  <header class="top">
    {#if showTitle}<h1><QuotaMachineScope {store} fallback={strings.usage.limits} /></h1>{/if}
    <QuotaPin />
    {#if store.owner}
      <button type="button" class="quiet icon refresh" aria-label={strings.usage.refresh} title={strings.usage.refresh} data-testid="limits-refresh" aria-busy={reader.busy} onclick={refresh}>
        <RefreshCw size={15} strokeWidth={1.75} class={reader.busy ? 'spinning' : ''} />
      </button>
    {/if}
  </header>
  <GatewaySwitch {store} />
  {#if proxyEnabled}<div class="actions proxy-switch">
    {#if !gatewayNative}<button type="button" class="ghost small" onclick={() => native = false} data-testid="subscription-proxy-show-dashboard"><span class="ui-label">{strings.subscriptionProxy.showDashboard}</span></button>{/if}
    <GatewayOpenButton {store} />
  </div>{/if}

  {#if reader.error}
    <div class="card failed" role="alert" data-testid="limits-error">
      <p>{fill(strings.quotas.readFailed, { error: reader.error })}</p>
      <button type="button" class="ghost small" disabled={reader.loading} data-testid="limits-retry" onclick={refresh}><span class="ui-label">{strings.common.retry}</span></button>
    </div>
  {/if}
  {#if gatewayError}
    <div class="card failed" role="alert" data-testid="gateway-quotas-error">
      <p>{fill(strings.subscriptionProxy.quotasFailed, { name: proxyName, error: gatewayError })}</p>
      <button type="button" class="ghost small" disabled={reader.loading} onclick={refresh}><span class="ui-label">{strings.common.retry}</span></button>
    </div>
  {/if}
  {#if gatewayNative}
    {#each gatewayGroups as group (group.providerId)}
      <section class="gateway-group" data-testid="gateway-quotas" data-provider={group.providerId}>
        <h2 class="group-head"><ProviderLogo providerId={group.providerId} size={16} /><span class="ui-label">{group.name}</span><small class="ui-label">{fill(strings.subscriptionProxy.via, { name: proxyName })}</small></h2>
        <UsageLimits rows={group.rows} {store} loading={reader.busy} completed={reader.landed} onalert={alert} />
      </section>
    {/each}
    {#if gateway.state?.status === 'ready' && gatewayGroups.length === 0 && shown !== null}
      <p class="muted gateway-empty" data-testid="gateway-quotas-empty">{fill(strings.subscriptionProxy.quotasEmpty, { name: proxyName })}</p>
    {/if}
  {/if}
  {#if reader.outdated}
    <p class="muted" data-testid="limits-outdated">{strings.quotas.outdated}</p>
  {:else if rows === null}
    <div class="skeleton" role="status" aria-label={strings.quotas.loading}>
      {#each [0, 1] as index (index)}<div class="card ghost-card"></div>{/each}
    </div>
  {:else if gatewayNative && rows.length === 0 && tracked.length === 0}
    <!-- Everything this machine reads goes through the gateway. -->
  {:else if rows.length === 0 && tracked.length === 0}
    <!-- A failed read never passes for "no provider connected". -->
    {#if !reader.error}<div class="card empty" data-testid="limits-empty">
      <p>{strings.quotas.empty}</p>
      {#if providersReachable}<button type="button" onclick={() => workspace.active.showSettings('accounts')}><span class="ui-label">{strings.settings.connectProvider}</span></button>{/if}
    </div>{/if}
  {:else}
    {#if rows.length > 0}<UsageLimits {rows} {store} loading={reader.busy} completed={reader.landed} onalert={alert} />{/if}
    {#if store.owner}<section class="card tracked" data-testid="limits-tracked">
      <h2 class="ui-label-box"><span class="ui-label">{strings.quotas.tracked}</span><InfoTip topic={strings.quotas.tracked} text={strings.quotas.trackedHint} /></h2>
      {#each tracked as row (row.accountId)}
        {@const account = row.label}
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
    </section>{/if}
  {/if}
  {#if store.owner && store.settings && !dashboard}
    <section class="card resume" id="settings-limit-resume">
      <label for="{uid}-resume" class="switch-row">
        <span class="text ui-label-box"><span class="ui-label" id="{uid}-resume-name">{strings.quotas.autoResume}</span><InfoTip topic={strings.quotas.autoResume} text={strings.quotas.autoResumeHint} /></span>
        <input id="{uid}-resume" type="checkbox" role="switch" data-testid="setting-auto-resume" aria-labelledby="{uid}-resume-name"
          checked={store.settings.autoResumeLimitedThreads === true} onchange={(event) => void toggleAutoResume(event.currentTarget)} />
      </label>
    </section>
  {/if}
  {#if store.owner}<details class="disclosure"><summary><span class="ui-label">{strings.subscriptionProxy.configure}</span></summary><SubscriptionProxySettings {store} /></details>{/if}
  {/if}
</div>

<style>
  .top { display: flex; align-items: center; gap: 8px; max-width: var(--settings-width); }
  .proxy-switch { margin-bottom: 12px; }
  .gateway-group { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; max-width: var(--settings-width); margin-bottom: 16px; }
  .group-head { display: flex; align-items: center; gap: 8px; margin: 0; font-size: var(--text-base); font-weight: 600; }
  .group-head small { color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 400; }
  .gateway-empty { max-width: var(--settings-width); margin-bottom: 12px; }
  .refresh { flex: none; margin-left: auto; width: var(--control); height: var(--control); padding: 0; }
  .refresh :global(.spinning) { animation: spin 900ms linear infinite var(--loops); }
  .muted { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .resume { max-width: var(--settings-width); margin-top: 12px; padding: 6px var(--settings-padding); }
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
  .ghost-card { height: 150px; margin: 0; animation: ghost-breathe 1.4s var(--ease-out-quint) infinite alternate var(--loops); }
  @keyframes ghost-breathe { from { opacity: 0.45; } to { opacity: 0.9; } }
  @media (prefers-reduced-motion: reduce) {
    .refresh :global(.spinning), .ghost-card { animation: none; }
  }
</style>
