<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import Menu from './Menu.svelte';
  import type { MenuItem } from '../lib/menu';
  import { strings } from '../lib/strings';
  import { workspace } from '../lib/workspace.svelte';

  /**
   * The machine this device opens on at every start, chosen among the ones it
   * is connected to. The choice stays on the device: a phone picks its own.
   * With one machine there is nothing to choose.
   */
  const LAST = 'last';
  const s = strings.machines;
  let chosen = $derived(workspace.machines.find((machine) => workspace.isMain(machine)));
  let items = $derived<MenuItem[]>([
    { id: LAST, label: s.mainLast, active: chosen === undefined },
    ...workspace.machines.map((machine) => ({ id: machine.id, label: machine.label, active: machine === chosen }))
  ]);

  function pick(id: string) {
    workspace.setMain(id === LAST ? null : workspace.machines.find((machine) => machine.id === id) ?? null);
  }
</script>

{#if workspace.machines.length > 1}
  <section class="card" data-testid="main-machine">
    <div class="switch-row">
      <span class="text">
        <span class="ui-label">{s.main}</span>
        <span class="hint">{chosen ? s.mainHint : s.mainLastHint}</span>
      </span>
      <Menu {items} onpick={pick} label={s.main} placement="bottom" align="end" testid="main-machine-pick">
        <span class="current ui-label">{chosen?.label ?? s.mainLast}</span><ChevronDown size={13} />
      </Menu>
    </div>
  </section>
{/if}

<style>
  .current {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
  }
</style>
