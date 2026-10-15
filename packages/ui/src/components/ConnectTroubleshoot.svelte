<script lang="ts">
  import { Check, ChevronDown, CircleDot, ExternalLink, LifeBuoy, X } from '@lucide/svelte';
  import { localNetwork } from '../lib/local-network.svelte';
  import { fill, strings } from '../lib/strings';

  /**
   * What stands between a phone and its machine, checked one by one. A page
   * sees a bare socket error whatever blocked it, so each step says where to
   * look, and the one thing it can read, the browser's local network
   * permission, carries its live state.
   */
  let { machineUrl }: { machineUrl: string | null } = $props();
  const uid = $props.id();
  let open = $state(false);
  // Android asks for Nearby devices on top of the browser's Local network, Android 16 included; no page can read it.
  const android = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  // Only a page the browser can block has a state to show: the app's own address.
  let access = $derived(localNetwork.state === 'unknown' ? null : localNetwork.state);
  // A machine reached through another one has no address of its own to open.
  let machine = $derived.by(() => {
    try {
      const url = machineUrl ? new URL(machineUrl) : null;
      return url && /^https?:$/.test(url.protocol) ? { href: url.origin, host: url.host } : null;
    } catch {
      return null;
    }
  });
</script>

{#if access || android || machine}
  <div class="troubleshoot" data-testid="connect-troubleshoot">
    <button class="ghost toggle" aria-expanded={open} aria-controls="{uid}-steps" data-testid="connect-troubleshoot-toggle" onclick={() => (open = !open)}>
      <LifeBuoy size={15} /><span class="ui-label">{strings.mobile.troubleshoot}</span><ChevronDown size={15} class="fold-caret" />
    </button>
    <div class="disclosure-fold" class:open inert={!open}>
      <div>
        <ol id="{uid}-steps" class="steps" aria-label={strings.mobile.troubleshootSteps}>
          {#if access}
            <li data-testid="check-local-network">
              <div class="row">
                <strong>{strings.mobile.checkLocalNetwork}</strong>
                <span class="state {access}" data-testid="check-local-network-state">
                  {#if access === 'granted'}<Check size={13} />{:else if access === 'denied'}<X size={13} />{:else}<CircleDot size={13} />{/if}{strings.mobile.localNetworkStates[access]}
                </span>
              </div>
              <p>{fill(strings.mobile.checkLocalNetworkHint, { host: location.host })}</p>
            </li>
          {/if}
          {#if android}
            <li data-testid="check-nearby">
              <div class="row"><strong>{strings.mobile.checkNearby}</strong></div>
              <p>{strings.mobile.checkNearbyHint}</p>
            </li>
          {/if}
          {#if machine}
            <li data-testid="check-reach">
              <div class="row">
                <strong>{fill(strings.mobile.checkReach, { host: machine.host })}</strong>
                <a class="open" href={machine.href} target="_blank" rel="noopener noreferrer" data-testid="check-reach-open">{strings.mobile.checkOpen}<ExternalLink size={13} /></a>
              </div>
              <p>{strings.mobile.checkReachHint}</p>
            </li>
          {/if}
        </ol>
      </div>
    </div>
  </div>
{/if}

<style>
  .troubleshoot { margin-top: 4px; }
  .toggle { width: 100%; justify-content: center; gap: 8px; color: var(--color-muted-foreground); }
  .toggle :global(.fold-caret) { transition: transform var(--dur-2) var(--ease-out-quint); }
  .toggle[aria-expanded='true'] :global(.fold-caret) { transform: rotate(180deg); }
  .steps {
    display: grid;
    gap: 10px;
    margin: 10px 0 0;
    padding: 14px 16px 14px 34px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-xl);
    background: var(--color-surface);
  }
  li { font-size: var(--text-sm); line-height: 1.5; }
  li::marker { color: var(--color-muted-foreground); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  strong { font-weight: 600; min-width: 0; overflow-wrap: anywhere; color: var(--color-foreground); }
  p { margin: 2px 0 0; font-size: var(--text-xs); line-height: 1.55; color: var(--color-muted-foreground); }
  .state { display: inline-flex; align-items: center; gap: 4px; flex: none; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .state.granted { color: var(--color-success); }
  .state.denied { color: var(--color-danger); }
  .open { display: inline-flex; align-items: center; gap: 4px; flex: none; font-size: var(--text-xs); color: var(--color-accent); text-decoration: none; }
</style>
