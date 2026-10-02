<script lang="ts">
  import { Monitor } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { isThisPC, workspace } from '../lib/workspace.svelte';
  import { fill, strings } from '../lib/strings';

  let { store }: { store: Store } = $props();
  let machine = $derived(workspace.machines.find((machine) => machine.store === store)
    ?? (store.core?.hostname || store.endpointUrl ? {
      id: store.endpointUrl ?? '', label: store.core?.hostname ?? store.endpointUrl!, store,
    } : null));
  let remote = $derived(machine !== null && !isThisPC(machine));
</script>

{#if machine}
  <aside class="scope" class:remote data-testid="quota-machine-scope" data-remote={remote}>
    <Monitor size={18} aria-hidden="true" />
    <div>
      {#if remote}<span class="kind">{strings.quotas.remoteMachine}</span>{/if}
      <span class="name">{fill(strings.quotas.machineAccounts, { machine: machine.label })}</span>
    </div>
  </aside>
{/if}

<style>
  .scope { display: flex; align-items: center; gap: 10px; max-width: var(--settings-width); margin: 8px 0 12px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); }
  .scope.remote { border-color: color-mix(in oklch, var(--color-accent) 55%, var(--color-border)); background: var(--color-accent-soft); }
  .scope :global(svg) { flex: none; color: var(--color-muted-foreground); }
  .scope.remote :global(svg) { color: var(--color-accent); }
  .scope div { display: grid; gap: 2px; min-width: 0; }
  .kind { font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .name { font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; }
</style>
