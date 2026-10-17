<script lang="ts">
  import { ExternalLink } from '@lucide/svelte';
  import { subscriptionProxyName } from '@boite/contracts';
  import { gatewayDashboard } from '../lib/gateway-dashboard';
  import { openExternal } from '../lib/links';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';

  /** Opens the gateway's own interface in the system browser, where this client can reach it. */
  let { store }: { store: Store } = $props();
  const proxy = $derived(store.settings?.subscriptionProxy);
  const url = $derived(gatewayDashboard(store));
</script>

{#if proxy && url}
  <button type="button" class="ghost small" onclick={() => void openExternal(url)} data-testid="subscription-proxy-open"><ExternalLink size={15} /><span class="ui-label">{fill(strings.subscriptionProxy.openGateway, { name: subscriptionProxyName(proxy.kind) })}</span></button>
{/if}
