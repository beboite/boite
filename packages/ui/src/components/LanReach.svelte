<script lang="ts">
  import { lockedBy } from '../lib/policy';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';

  /**
   * What makes a phone's link reach this computer. A core started on its
   * defaults listens on 127.0.0.1 only, and its link names that address, which
   * on a phone is the phone. "Reachable on the local network" takes effect
   * when the core starts, and closing the window leaves the core running, so
   * nothing in the old flow ever applied it. In the desktop app this restarts
   * the core the way an update does: running turns end their tool call and the
   * next core resumes them; the shell starts that core again.
   */
  let { store, loopback, firewall, restarting = $bindable(false) }: {
    store: Store;
    /** The link on show names a loopback address. */
    loopback: boolean;
    firewall?: { allow(): Promise<void> };
    /** True while a restart is under way, for the switch to wait for it. */
    restarting?: boolean;
  } = $props();
  const text = strings.group.reach;

  /** Only the desktop app brings a stopped core of its own back. */
  const canRestart = $derived(store.localCore && typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined);
  let phase = $state<'idle' | 'restarting' | 'failed'>('idle');
  $effect(() => { restarting = phase === 'restarting'; });

  /** Turns the network on, asks the firewall, restarts, and shows the phone's new link. */
  async function reach(): Promise<void> {
    if (phase === 'restarting') return;
    if (!store.settings?.listenOnLan && !(await store.saveSettings({ listenOnLan: true }))) return;
    await firewall?.allow();
    if (canRestart) await restart(true);
  }

  /**
   * Restarts the core so it listens as the setting now says, and waits until
   * the address it is bound to agrees: the old core keeps answering through
   * its grace. A link's own address cannot tell, since a public address or a
   * group's names neither loopback nor the LAN. With `mint`, the link on show
   * is drawn again once, for the same role and kind, from the new core.
   */
  export async function restart(mint = false): Promise<void> {
    if (!canRestart || phase === 'restarting') return;
    phase = 'restarting';
    try {
      await store.client?.call('core.restart', {});
    } catch {
      phase = 'failed';
      return;
    }
    const deadline = Date.now() + 90_000;
    let settled = false;
    while (!settled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (store.connection !== 'ready' || !store.core) continue;
      settled = !isLoopbackHost(store.core.endpoint.host) === (store.settings?.listenOnLan === true);
    }
    if (settled && mint) await store.addDevice();
    phase = settled ? 'idle' : 'failed';
  }
</script>

<script lang="ts" module>
  /** An address only the computer itself reaches. */
  function isLoopbackHost(host: string): boolean {
    return host === 'localhost' || host === '[::1]' || host === '::1' || host.startsWith('127.');
  }

  /** A link that only reaches the computer that opens it. */
  export function isLoopback(url: string): boolean {
    try {
      return isLoopbackHost(new URL(url).hostname);
    } catch {
      return false;
    }
  }
</script>

{#if loopback || phase !== 'idle'}
  <div class="reach" data-testid="lan-reach" data-phase={phase}>
    {#if phase === 'restarting'}
      <p class="hint">{text.restarting}</p>
    {:else if phase === 'failed'}
      <p class="hint warn">{text.failed}</p>
    {:else}
      <p class="hint warn">{text.loopback}</p>
      {#if !canRestart}<p class="hint">{strings.group.lanHint}</p>{/if}
    {/if}
    {#if canRestart && phase !== 'restarting' && loopback}
      <div class="actions">
        <button type="button" class="primary" data-testid="lan-reach-button" disabled={store.connection !== 'ready' || lockedBy(store.policy, 'network.lan') !== null} onclick={() => void reach()}>
          <span class="ui-label">{text.button}</span>
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .reach { display: grid; gap: 8px; }
  .reach p { margin: 0; }
  .warn { color: var(--color-live); }
  .actions { margin: 0; }
</style>
