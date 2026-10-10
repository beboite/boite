<script lang="ts">
  import { untrack } from 'svelte';
  import type { FirewallStatus, NetworkCategory } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';

  /**
   * Windows Defender Firewall between a phone and this core. Shown while the
   * core listens on the local network and Windows does not let it through:
   * the prompt Windows raises names the core's runtime, "Bun" by "Oven", and
   * dismissing it, or a network changing from public to private, leaves a
   * phone at a page that never loads. The button asks Windows once, as an
   * administrator, for a rule that covers every network.
   */
  let { store }: { store: Store } = $props();
  const text = strings.settings.pairing.firewall;

  let status = $state<FirewallStatus | null>(null);
  let busy = $state(false);
  let done = $state(false);

  const listening = $derived(store.settings?.listenOnLan === true);

  async function read(): Promise<void> {
    const client = store.client;
    if (!client) return;
    try {
      status = await client.call('firewall.status', {});
    } catch {
      status = null;
    }
  }

  /** Asks Windows for the rule unless it is already there; the switch calls it the moment it turns the network on. */
  export async function allow(): Promise<void> {
    const client = store.client;
    if (!client || busy) return;
    busy = true;
    done = false;
    try {
      const before = status ?? (await client.call('firewall.status', {}));
      if (before.state === 'unsupported' || before.state === 'ready') {
        status = before;
        return;
      }
      status = await client.call('firewall.allow', {});
      done = status.state === 'ready';
    } catch {
      status = null;
    } finally {
      busy = false;
    }
  }

  // Read on arrival, on reconnection and when the switch turns on; the call's own state is not a reason to read again.
  $effect(() => {
    if (store.connection === 'ready' && store.owner && listening) untrack(() => void read());
  });

  function names(list: NetworkCategory[]): string {
    return list.map((name) => text.networks[name]).join(text.and);
  }

  const problem = $derived(
    !status ? '' :
    status.state === 'blocked' ? fill(text.blocked, { networks: names(status.blocked) }) :
    status.state === 'unset' ? fill(text.unset, { networks: names(status.networks.filter((name) => !status!.allowed.includes(name))) }) :
    status.state === 'error' ? text.unreadable : ''
  );
  const outcome = $derived(!status?.detail ? '' : status.detail === 'cancelled' ? text.cancelled : text.failed);
</script>

{#if listening && store.owner}
  {#if problem}
    <div class="firewall" data-testid="firewall-notice" data-state={status?.state}>
      <p class="hint warn">{problem}</p>
      {#if outcome}<p class="hint" data-testid="firewall-outcome">{outcome}</p>{/if}
      {#if status?.state !== 'error'}
        <div class="actions">
          <button type="button" class="primary" data-testid="firewall-allow" disabled={busy || store.connection !== 'ready'} onclick={() => void allow()}>
            <span class="ui-label">{busy ? text.allowing : text.allow}</span>
          </button>
        </div>
      {/if}
    </div>
  {:else if done}
    <p class="hint allowed" data-testid="firewall-allowed">{text.allowed}</p>
  {/if}
{/if}

<style>
  .firewall { display: grid; gap: 8px; margin-top: 14px; }
  .firewall p { margin: 0; }
  .warn { color: var(--color-live); }
  .actions { margin: 0; }
  .allowed { margin: 14px 0 0; }
</style>
