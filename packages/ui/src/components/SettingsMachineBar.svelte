<script lang="ts">
  import { ChevronDown, Info } from '@lucide/svelte';
  import Menu from './Menu.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import { fill, strings } from '../lib/strings';
  import { listedName, machineName, workspace, type Machine } from '../lib/workspace.svelte';

  /**
   * The machine a settings page changes, picked above every page that belongs
   * to one machine. One that follows its group's default machine says so, and
   * each setting changed on it anyway carries a star (`SyncMark.svelte`).
   */
  let { machine, machines, onpick }: { machine: Machine; machines: Machine[]; onpick: (id: string) => void } = $props();
  let items = $derived(machines.map((entry) => ({ id: entry.id, label: listedName(entry), active: entry === machine })));
  let home = $derived(workspace.settingsSync.sourceName(machine));
  let connected = $derived(workspace.settingsSync.source(machine) !== undefined);
  /** The default machine itself, while others follow it. */
  let isHome = $derived(home === undefined && machine.store.group?.settingsHome === machine.store.group?.self && machine.store.group?.settingsHome !== undefined
    && (machine.store.group?.cores.length ?? 0) > 1);
</script>

<div class="machine-bar" data-testid="settings-machine-bar">
  {#if machines.length > 1}
    <Menu {items} label={strings.machines.pick} placement="bottom" testid="settings-machine" onpick={onpick}>
      <MachineIcon icon={machine.icon} os={machine.store.core?.os} size={15} /><span class="name ui-label">{listedName(machine)}</span><ChevronDown size={13} />
    </Menu>
  {/if}
  {#if home !== undefined}
    <p class="info" role="note" data-testid="settings-follows">
      <Info size={15} aria-hidden="true" />
      <span>{fill(strings.machines.follows, { machine: machineName(machine), home })}{#if !connected}{' '}{fill(strings.machines.followsAway, { home })}{/if}</span>
    </p>
  {:else if isHome}
    <p class="info quiet" role="note" data-testid="settings-is-home">
      <Info size={15} aria-hidden="true" />
      <span>{fill(strings.machines.isHome, { machine: machineName(machine) })}</span>
    </p>
  {/if}
</div>

<style>
  .machine-bar {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    max-width: var(--settings-width);
  }
  .machine-bar:empty { display: none; }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 28ch;
  }
  .info {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    margin: 0;
    padding: 10px 14px;
    border: 1px solid color-mix(in srgb, var(--color-accent) 35%, var(--color-border));
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface));
    color: var(--color-foreground);
    font-size: var(--text-sm);
    line-height: 1.5;
  }
  .info :global(svg) { flex: none; margin-top: 2px; color: var(--color-accent); }
  .info.quiet { border-color: var(--color-border); background: var(--color-surface); color: var(--color-muted-foreground); }
  .info.quiet :global(svg) { color: var(--color-muted-foreground); }
</style>
