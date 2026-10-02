<script lang="ts">
  import type { Store } from '../lib/store.svelte';
  import { isThisPC, workspace } from '../lib/workspace.svelte';
  import { strings } from '../lib/strings';

  let { store, fallback = strings.quotas.glance }: { store: Store; fallback?: string } = $props();
  let machine = $derived(workspace.machines.find((machine) => machine.store === store)
    ?? (store.core?.hostname || store.endpointUrl ? {
      id: store.endpointUrl ?? '', label: store.core?.hostname ?? store.endpointUrl!, store,
    } : null));
  let remote = $derived(machine !== null && !isThisPC(machine));
  let label = $derived(strings.quotas.machineAccounts.split('{machine}'));
</script>

{#if machine}
  <span class="scope" data-testid="quota-machine-scope" data-remote={remote}>
    {label[0]}<span class="name">{machine.label}</span>{label[1] ?? ''}
  </span>
{:else}
  {fallback}
{/if}

<style>
  .scope { overflow-wrap: anywhere; }
  .name { color: var(--color-accent); }
</style>
