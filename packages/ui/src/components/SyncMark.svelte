<script lang="ts">
  import { Star } from '@lucide/svelte';
  import type { SyncKey } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { machineName, workspace } from '../lib/workspace.svelte';

  /**
   * The star beside a setting this machine changed for itself while it
   * follows its group's default machine. A click gives the setting back: the
   * next copy writes the default machine's value over it.
   */
  let { store, key }: { store: Store; key: SyncKey } = $props();
  let machine = $derived(workspace.machines.find((entry) => entry.store === store));
  let home = $derived(machine ? workspace.settingsSync.sourceName(machine) : undefined);
  let label = $derived(fill(strings.machines.kept, { machine: machine ? machineName(machine) : strings.machines.local, home: home ?? '' }));

  async function giveBack(event: MouseEvent) {
    // Inside a label, a click would also flip the switch it names.
    event.preventDefault();
    event.stopPropagation();
    if (await store.followHome(key) && machine) workspace.settingsSync.refresh(machine);
  }
</script>

{#if home !== undefined && store.kept(key)}
  <button type="button" class="ghost sync-mark" data-testid="sync-mark" data-key={key} title={label} aria-label={label} onclick={giveBack}>
    <Star size={13} fill="currentColor" strokeWidth={1.75} />
  </button>
{/if}

<style>
  .sync-mark {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 20px;
    height: 20px;
    min-height: 0;
    padding: 0;
    margin-left: 4px;
    border-radius: var(--radius-sm);
    color: var(--color-accent);
    vertical-align: middle;
  }
  .sync-mark:hover { background: var(--color-hover); }
</style>
