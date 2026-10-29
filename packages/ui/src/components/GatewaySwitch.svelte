<script lang="ts">
  import { subscriptionProxyName, subscriptionProxyOrigin } from '@boite/contracts';
  import { errorText } from '../lib/errors';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';
  import PolicyLock from './PolicyLock.svelte';
  import { gatewayBlocked } from '../lib/policy';

  /**
   * The gateway the owner configured, on or off, from Limits. A paired phone
   * flips it too (`subscriptionProxy.setEnabled`); its address and key stay in
   * the desktop's proxy settings. Nothing shows before one is configured.
   */
  let { store }: { store: Store } = $props();
  const uid = $props.id();
  const proxy = $derived(store.settings?.subscriptionProxy);
  const name = $derived(proxy ? subscriptionProxyName(proxy.kind) : '');
  let busy = $state(false);
  /** The admin policy keeps this gateway from being turned on; turning it off stays open. */
  const blocked = $derived(proxy?.enabled !== true && gatewayBlocked(store.policy, proxy?.baseUrl) !== null);
  let error = $state('');

  /** The switch saves when it flips; a refusal puts it back. */
  async function toggle(input: HTMLInputElement) {
    const client = store.client;
    const enabled = input.checked;
    if (!client || busy) { input.checked = !enabled; return; }
    busy = true; error = '';
    try { store.settings = await client.call('subscriptionProxy.setEnabled', { enabled }); }
    catch (failure) {
      input.checked = store.settings?.subscriptionProxy?.enabled === true;
      error = fill(strings.subscriptionProxy.switchFailed, { name, error: errorText(failure) });
    } finally { busy = false; }
  }
</script>

{#if proxy?.baseUrl}
  <section class="card gateway-switch" data-testid="gateway-switch">
    <label for="{uid}-gateway" class="switch-row">
      <span class="text">
        <span class="ui-label-box"><span class="ui-label" id="{uid}-gateway-name">{fill(strings.subscriptionProxy.use, { name })}</span><InfoTip topic={fill(strings.subscriptionProxy.use, { name })} text={strings.subscriptionProxy.enabledHint} />{#if blocked}<PolicyLock {store} keys={['gateway', 'gateway.allowedBaseUrls']} />{/if}</span>
        <span class="hint where">{proxy.mode === 'local' ? strings.subscriptionProxy.local : subscriptionProxyOrigin(proxy)}</span>
      </span>
      <input id="{uid}-gateway" type="checkbox" role="switch" data-testid="gateway-switch-input" aria-labelledby="{uid}-gateway-name"
        checked={proxy.enabled} disabled={busy || store.connection !== 'ready' || blocked} onchange={(event) => void toggle(event.currentTarget)} />
    </label>
    {#if error}<p class="error" role="alert" data-testid="gateway-switch-error">{error}</p>{/if}
  </section>
{/if}

<style>
  .gateway-switch { flex: none; max-width: var(--settings-width); margin-bottom: 12px; padding: 6px var(--settings-padding); }
  .where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .error { margin: 0 0 10px; color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
</style>
