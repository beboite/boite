<script lang="ts">
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
  const text = strings.settings.pairing.reach;

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
   * Restarts the core so it listens as the setting now says. With `mint`, it
   * draws the link on show again, for the same role, until its address agrees
   * with the setting: the old core keeps answering through its grace, so the
   * first links can still name the address it listened on.
   */
  export async function restart(mint = false): Promise<void> {
    if (!canRestart || phase === 'restarting') return;
    phase = 'restarting';
    const shown = store.pairing;
    const role = shown?.role ?? 'device';
    const short = role === 'owner' && !!shown?.code;
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
      if (store.connection !== 'ready') continue;
      const lan = store.settings?.listenOnLan === true;
      if (!mint) {
        settled = (store.core?.endpoint.host !== '127.0.0.1') === lan;
        continue;
      }
      try {
        await store.mintPairing(role, short);
      } catch {
        // The core is still coming back; the next round asks again.
        continue;
      }
      settled = !!store.pairing && isLoopback(store.pairing.url) !== lan;
    }
    phase = settled ? 'idle' : 'failed';
  }
</script>

<script lang="ts" module>
  /** A link that only reaches the computer that opens it. */
  export function isLoopback(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host === 'localhost' || host === '[::1]' || host.startsWith('127.');
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
      {#if !canRestart}<p class="hint">{strings.settings.pairing.lanHint}</p>{/if}
    {/if}
    {#if canRestart && phase !== 'restarting' && loopback}
      <div class="actions">
        <button type="button" class="primary" data-testid="lan-reach-button" disabled={store.connection !== 'ready'} onclick={() => void reach()}>
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
