<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import Menu from './Menu.svelte';
  import PluginsMachine from './PluginsMachine.svelte';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { isThisPC, workspace, type Machine } from '../lib/workspace.svelte';

  let { store: page }: { store: Store } = $props();

  /** The page's own machine, for a store the workspace does not list. */
  let own = $derived<Machine>({ id: page.endpointUrl ?? 'local', label: page.core?.hostname ?? strings.machines.local, store: page });
  /** Plugins are installed by an owner, so only the machines this window owns are offered. */
  let machines = $derived((workspace.machines.some((machine) => machine.store === page) ? workspace.machines : [own, ...workspace.machines])
    .filter((machine) => machine.store === page || machine.store.owner));
  let picked = $state<string | null>(null);
  /**
   * A plugin runs beside the core that installed it, and a desktop app shows
   * its window there. The page opens on this PC rather than on the machine of
   * the open conversation, which may be a server with nothing installed.
   */
  let chosen = $derived(machines.find((machine) => machine.id === picked)
    ?? machines.find(isThisPC)
    ?? machines.find((machine) => machine.store === page)
    ?? own);
  let machineItems = $derived(machines.map((machine) => ({ id: machine.id, label: machine.label, active: machine === chosen })));
</script>

{#snippet machineMenu()}
  {#if machines.length > 1}
    <Menu items={machineItems} label={strings.plugins.machine} placement="bottom" testid="plugins-machine" onpick={(id) => { picked = id; }}>
      <span class="machine-name ui-label">{chosen.label}</span><ChevronDown size={13} />
    </Menu>
  {/if}
{/snippet}

{#key chosen.store}
  <PluginsMachine store={chosen.store} {machineMenu} />
{/key}

<style>
  .machine-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
</style>
