<script lang="ts">
  import type { Store } from '../lib/store.svelte';
  import { isThisPC, workspace } from '../lib/workspace.svelte';
  import { strings } from '../lib/strings';

  let { store }: { store: Store } = $props();
  let machine = $derived(workspace.machines.find((machine) => machine.store === store)
    ?? (store.core?.hostname || store.endpointUrl ? {
      id: store.endpointUrl ?? '', label: store.core?.hostname ?? store.endpointUrl!, store,
    } : null));
  let remote = $derived(machine !== null && !isThisPC(machine));
  let label = $derived(strings.quotas.machineAccounts.split('{machine}'));
</script>

{#if machine}
  <p class="scope" data-testid="quota-machine-scope" data-remote={remote}>
    {label[0]}<span class="name">{machine.label}</span>{label[1] ?? ''}
  </p>
{/if}

<style>
  .scope { max-width: var(--settings-width); margin: 8px 0 12px; font-size: var(--text-sm); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .name { color: var(--color-accent); font-weight: 600; }
</style>
