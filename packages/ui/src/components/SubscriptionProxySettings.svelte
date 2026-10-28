<script lang="ts">
  import { errorText } from '../lib/errors';
  import { untrack } from 'svelte';
  import { checkSettingsPatch, type PluginState, type SubscriptionProxy, type SubscriptionProxyMode } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';
  import PolicyLock from './PolicyLock.svelte';
  import { gatewayBlocked } from '../lib/policy';
  import GatewayMoveDialog from './GatewayMoveDialog.svelte';
  import GatewayOpenButton from './GatewayOpenButton.svelte';

  let { store }: { store: Store } = $props();
  let config = $state<SubscriptionProxy>({ enabled: false, kind: 'douane', baseUrl: 'http://127.0.0.1:8787', dashboardUrl: 'http://127.0.0.1:8787/admin/#quotas' });
  let key = $state('');
  let clearKey = $state(false);
  let busy = $state(false);
  let result = $state('');
  let failed = $state(false);
  let moving = $state(false);
  /** Every gateway off by the admin policy, or the one typed outside the addresses it allows: the core refuses the save either way. */
  const gatewayOff = $derived(gatewayBlocked(store.policy) === 'gateway');
  const blocked = $derived(gatewayOff || (config.enabled && gatewayBlocked(store.policy, config.baseUrl) !== null));
  /** A saved Douane, on a core that can move logins into it. */
  const movable = $derived(store.settings?.subscriptionProxy?.kind === 'douane' && !!store.settings.subscriptionProxy.baseUrl && store.core?.features?.gatewayMove === true);
  $effect(() => {
    const saved = store.settings?.subscriptionProxy;
    untrack(() => { if (saved) config = { ...saved }; });
  });
  const local = $derived(config.mode === 'local');
  /** What the form leaves when it switches to the plugin, so switching back finds the address typed. */
  let remote = $state<Pick<SubscriptionProxy, 'kind' | 'baseUrl' | 'dashboardUrl'> | null>(null);
  /** The Douane plugin as `plugins.list` reads it: undefined before an answer, null on a core without it. */
  let douane = $state<PluginState | null | undefined>(undefined);
  const gateway = $derived(douane?.status === 'installed' ? douane.gateway ?? null : null);

  // Read once local mode is on screen: the card also sits in Limits, which has no use for plugins.
  // Plugins are the owner's: a paired device reads none and shows no plugin state.
  $effect(() => {
    if (!local) return;
    const client = store.client;
    if (!client || !store.owner) return;
    let disposed = false;
    const off = client.on('plugins.updated', (value) => { if (value.id === 'douane') douane = value; });
    void client.call('plugins.list', {}).then((rows) => {
      if (!disposed) douane = rows.find((plugin) => plugin.id === 'douane') ?? null;
    }).catch(() => { if (!disposed) douane = null; });
    return () => { disposed = true; off(); };
  });

  /** Local mode points at the Douane plugin: the core writes the URLs, the ones here only pass the check. */
  function chooseMode(mode: SubscriptionProxyMode) {
    if (mode === (config.mode ?? 'remote')) return;
    result = '';
    if (mode === 'local') {
      remote = { kind: config.kind, baseUrl: config.baseUrl, dashboardUrl: config.dashboardUrl };
      config = { ...config, mode, kind: 'douane' };
    } else {
      const back = remote ?? { kind: 'douane' as const, baseUrl: 'http://127.0.0.1:8787', dashboardUrl: 'http://127.0.0.1:8787/admin/#quotas' };
      config = { ...config, ...back, mode };
    }
  }

  function choose(kind: SubscriptionProxy['kind']) {
    const oldDefault = config.kind === 'douane' ? 'http://127.0.0.1:8787' : 'http://127.0.0.1:8317';
    const baseUrl = config.baseUrl === oldDefault ? (kind === 'douane' ? 'http://127.0.0.1:8787' : 'http://127.0.0.1:8317') : config.baseUrl;
    config = { ...config, kind, baseUrl, dashboardUrl: `${baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')}${kind === 'douane' ? '/admin/#quotas' : '/management.html#/quota'}` };
    result = '';
  }

  async function save() {
    const client = store.client;
    if (!client || !store.owner || busy) return;
    busy = true; result = ''; failed = false;
    try {
      const checked = checkSettingsPatch({ subscriptionProxy: { ...config } });
      if (!checked.ok) throw new Error(checked.message);
      store.settings = await client.call('subscriptionProxy.configure', {
        subscriptionProxy: checked.patch.subscriptionProxy!,
        ...(!local && (key || clearKey) ? { key: clearKey ? null : key } : {}),
      });
      key = ''; clearKey = false;
      result = strings.subscriptionProxy.saved;
    } catch (error) { failed = true; result = errorText(error); }
    finally { busy = false; }
  }
</script>

<section class="card proxy-settings" data-testid="subscription-proxy-settings">
  <h2 class="ui-label-box"><span class="ui-label">{strings.subscriptionProxy.heading}</span><InfoTip topic={strings.subscriptionProxy.heading} text={strings.subscriptionProxy.hint} /><PolicyLock {store} keys={['gateway', 'gateway.allowedBaseUrls']} /></h2>
  <label class="switch-row"><span class="text ui-label">{strings.subscriptionProxy.enable}</span><input type="checkbox" role="switch" bind:checked={config.enabled} disabled={gatewayOff} data-testid="subscription-proxy-enabled" /></label>
  <p class="hint" data-testid="subscription-proxy-enabled-hint">{strings.subscriptionProxy.enabledHint}</p>
  <div class="mode">
    <span class="ui-label-box"><span class="ui-label">{strings.subscriptionProxy.where}</span><InfoTip topic={strings.subscriptionProxy.local} text={strings.subscriptionProxy.localHint} /></span>
    <div class="segmented" role="group" aria-label={strings.subscriptionProxy.where}>
      <button type="button" aria-pressed={!local} onclick={() => chooseMode('remote')} data-testid="subscription-proxy-remote"><span class="ui-label">{strings.subscriptionProxy.remote}</span></button>
      <button type="button" aria-pressed={local} onclick={() => chooseMode('local')} data-testid="subscription-proxy-local"><span class="ui-label">{strings.subscriptionProxy.local}</span></button>
    </div>
  </div>
  {#if local}
    {#if douane !== undefined}
      <div class="plugin" data-testid="subscription-proxy-plugin" data-state={gateway?.status ?? 'missing'}>
        <span class="dot" class:ok={gateway?.status === 'running'} class:live={gateway?.status === 'starting' || gateway?.status === 'updating'} class:bad={gateway?.status === 'crashed'}></span>
        <span class="line">{gateway === null ? strings.subscriptionProxy.localMissing
          : gateway.status === 'running' ? fill(strings.subscriptionProxy.localRunning, { version: gateway.version ?? '', port: String(gateway.port) }).replace('  ', ' ')
          : gateway.status === 'starting' || gateway.status === 'updating' ? strings.subscriptionProxy.localStarting
          : strings.subscriptionProxy.localStopped}</span>
        {#if gateway?.status !== 'running'}
          <button type="button" class="ghost small" onclick={() => store.showSettings('plugins')} data-testid="subscription-proxy-open-plugins"><span class="ui-label">{strings.subscriptionProxy.openPlugins}</span></button>
        {/if}
      </div>
    {/if}
    <form onsubmit={(event) => { event.preventDefault(); void save(); }}>
      <div class="actions"><button type="submit" class="primary small" disabled={busy || !store.owner || blocked} data-testid="subscription-proxy-save"><span class="ui-label">{strings.subscriptionProxy.save}</span></button><GatewayOpenButton {store} /></div>
      {#if result}<p class="hint" class:error={failed} role="status" data-testid="subscription-proxy-result">{result}</p>{/if}
    </form>
  {:else}
  <div class="actions" role="group" aria-label={strings.subscriptionProxy.heading}>
    <button type="button" class="quiet small" aria-pressed={config.kind === 'douane'} onclick={() => choose('douane')} data-testid="subscription-proxy-douane"><span class="ui-label">Douane</span></button>
    <button type="button" class="quiet small" aria-pressed={config.kind === 'cliproxyapi'} onclick={() => choose('cliproxyapi')} data-testid="subscription-proxy-cliproxyapi"><span class="ui-label">CLIProxyAPI</span></button>
  </div>
  <form onsubmit={(event) => { event.preventDefault(); void save(); }}>
    <label><span class="ui-label">{strings.subscriptionProxy.baseUrl}</span><input type="url" bind:value={config.baseUrl} required data-testid="subscription-proxy-url" /></label>
    <label><span class="ui-label">{strings.subscriptionProxy.dashboardUrl}</span><input type="url" bind:value={config.dashboardUrl} required data-testid="subscription-proxy-dashboard" /></label>
    <label><span class="ui-label-box"><span class="ui-label">{strings.subscriptionProxy.key}</span><InfoTip topic={strings.subscriptionProxy.key} text={strings.subscriptionProxy.keyHint} /></span><input type="password" bind:value={key} autocomplete="new-password" disabled={clearKey} data-testid="subscription-proxy-key" /></label>
    <label class="clear-key"><input type="checkbox" bind:checked={clearKey} /><span class="ui-label">{strings.subscriptionProxy.clearKey}</span></label>
    <div class="actions"><button type="submit" class="primary small" disabled={busy || blocked} data-testid="subscription-proxy-save"><span class="ui-label">{strings.subscriptionProxy.save}</span></button><GatewayOpenButton {store} /></div>
    {#if result}<p class="hint" class:error={failed} role="status" data-testid="subscription-proxy-result">{result}</p>{/if}
  </form>
  {/if}
  {#if movable}
    <div class="move">
      <button type="button" class="ghost small" disabled={gatewayOff} onclick={() => moving = true} data-testid="gateway-move-open"><span class="ui-label">{strings.subscriptionProxy.move.open}</span></button>
      <InfoTip topic={strings.subscriptionProxy.move.open} text={strings.subscriptionProxy.move.openHint} />
    </div>
    <GatewayMoveDialog {store} open={moving} onclose={() => moving = false} />
  {/if}
</section>

<style>
  .proxy-settings { max-width: var(--settings-width); padding: var(--settings-padding); }
  h2 { display: flex; align-items: center; }
  form { display: grid; gap: 12px; margin-top: 16px; }
  form > label { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: var(--text-sm); }
  form input:not([type='checkbox']) { width: 100%; min-width: 0; }
  .clear-key { min-height: var(--row); }
  .proxy-settings > .hint { margin: 2px 0 10px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .error { color: var(--color-danger); }
  [aria-pressed='true'] { background: var(--color-active); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .mode { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; font-size: var(--text-sm); }
  .segmented { display: inline-flex; padding: 2px; gap: 2px; border-radius: var(--radius-md); background: var(--color-surface-2); }
  .segmented button {
    min-height: var(--control-sm); padding: 2px 12px; border: 0; border-radius: var(--radius-sm); background: transparent;
    color: var(--color-muted-foreground); font-size: var(--text-sm);
    transition: background var(--dur-2) var(--ease-out-quint), color var(--dur-2) var(--ease-out-quint);
  }
  .segmented button:hover { color: var(--color-foreground); }
  .segmented button[aria-pressed='true'] { background: var(--color-active); color: var(--color-foreground); }
  .plugin { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); font-size: var(--text-sm); }
  .plugin .line { flex: 1; min-width: 0; color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  .dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--color-subtle); }
  .dot.ok { background: var(--color-success); }
  .dot.live { background: var(--color-live); }
  .dot.bad { background: var(--color-danger); }
  .move { display: flex; align-items: center; gap: 4px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--color-border); }
</style>
