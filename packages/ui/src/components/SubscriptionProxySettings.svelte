<script lang="ts">
  import { untrack } from 'svelte';
  import { checkSettingsPatch, type SubscriptionProxy } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  let { store }: { store: Store } = $props();
  let config = $state<SubscriptionProxy>({ enabled: false, kind: 'douane', baseUrl: 'http://127.0.0.1:8787', dashboardUrl: 'http://127.0.0.1:8787/admin/#quotas' });
  let key = $state('');
  let clearKey = $state(false);
  let busy = $state(false);
  let result = $state('');
  let failed = $state(false);
  $effect(() => {
    const saved = store.settings?.subscriptionProxy;
    untrack(() => { if (saved) config = { ...saved }; });
  });

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
        ...(key || clearKey ? { key: clearKey ? null : key } : {}),
      });
      key = ''; clearKey = false;
      result = strings.subscriptionProxy.saved;
    } catch (error) { failed = true; result = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  }
</script>

<section class="card proxy-settings" data-testid="subscription-proxy-settings">
  <h2 class="ui-label-box"><span class="ui-label">{strings.subscriptionProxy.heading}</span><InfoTip topic={strings.subscriptionProxy.heading} text={strings.subscriptionProxy.hint} /></h2>
  <label class="switch-row"><span class="text ui-label">{strings.subscriptionProxy.enable}</span><input type="checkbox" role="switch" bind:checked={config.enabled} data-testid="subscription-proxy-enabled" /></label>
  <div class="actions" role="group" aria-label={strings.subscriptionProxy.heading}>
    <button type="button" class="quiet small" aria-pressed={config.kind === 'douane'} onclick={() => choose('douane')} data-testid="subscription-proxy-douane"><span class="ui-label">Douane</span></button>
    <button type="button" class="quiet small" aria-pressed={config.kind === 'cliproxyapi'} onclick={() => choose('cliproxyapi')} data-testid="subscription-proxy-cliproxyapi"><span class="ui-label">CLIProxyAPI</span></button>
  </div>
  <form onsubmit={(event) => { event.preventDefault(); void save(); }}>
    <label><span class="ui-label">{strings.subscriptionProxy.baseUrl}</span><input type="url" bind:value={config.baseUrl} required data-testid="subscription-proxy-url" /></label>
    <label><span class="ui-label">{strings.subscriptionProxy.dashboardUrl}</span><input type="url" bind:value={config.dashboardUrl} required data-testid="subscription-proxy-dashboard" /></label>
    <label><span class="ui-label-box"><span class="ui-label">{strings.subscriptionProxy.key}</span><InfoTip topic={strings.subscriptionProxy.key} text={strings.subscriptionProxy.keyHint} /></span><input type="password" bind:value={key} autocomplete="new-password" disabled={clearKey} data-testid="subscription-proxy-key" /></label>
    <label class="clear-key"><input type="checkbox" bind:checked={clearKey} /><span class="ui-label">{strings.subscriptionProxy.clearKey}</span></label>
    <div class="actions"><button type="submit" class="primary small" disabled={busy} data-testid="subscription-proxy-save"><span class="ui-label">{strings.subscriptionProxy.save}</span></button></div>
    {#if result}<p class="hint" class:error={failed} role="status" data-testid="subscription-proxy-result">{result}</p>{/if}
  </form>
</section>

<style>
  .proxy-settings { max-width: var(--settings-width); padding: var(--settings-padding); }
  h2 { display: flex; align-items: center; }
  form { display: grid; gap: 12px; margin-top: 16px; }
  form > label { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: var(--text-sm); }
  form input:not([type='checkbox']) { width: 100%; min-width: 0; }
  .clear-key { min-height: var(--row); }
  .error { color: var(--color-danger); }
  [aria-pressed='true'] { background: var(--color-active); }
</style>
