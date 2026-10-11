<script lang="ts">
  import { isThisPC, machineHealth, workspace } from '../lib/workspace.svelte';
  import { Monitor, TriangleAlert } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import Menu from './Menu.svelte';
  import { separator, type MenuItem } from '../lib/menu';

  /**
   * The footer's machine button. One machine that is connected says nothing, so
   * nothing is drawn; a second machine, a filter or a connection in trouble
   * brings back one icon, the count or the chosen machine's name beside it
   * only while it filters the list. A remote machine that is merely switched
   * off is grey in the menu and raises no warning (`machineHealth`).
   *
   * `pick` is the Agents list's form: one machine at a time, no "All
   * machines", and the chosen machine always named on the button while there
   * are several to choose from.
   */
  let { store, filter = null, onfilter, pick = false }: { store: Store; filter?: string | null; onfilter?: (id: string | null) => void; pick?: boolean } = $props();

  const machines = $derived([...(workspace.machines.length ? workspace.machines : [{ id: 'current', label: strings.machines.local, store }])]
    .sort((a, b) => Number(isThisPC(b)) - Number(isThisPC(a))));
  const health = $derived(new Map(machines.map(m => [m, machineHealth(m, store)])));
  const issues = $derived(machines.filter(m => health.get(m) === 'lost').length);
  const tones = { ready: 'success', connecting: 'warning', offline: 'neutral', lost: 'danger' } as const;
  const chosen = $derived(filter === null ? null : machines.find(m => m.id === filter) ?? null);
  const shown = $derived(machines.length > 1 || issues > 0 || chosen !== null);
  /** The name beside the icon: a filter on, or the machine the Agents list shows. */
  const named = $derived(chosen !== null && (!pick || machines.length > 1));
  const label = $derived(issues > 0 ? `${strings.machines.filter} · ${issues} ${strings.connection.issues}` : strings.machines.filter);
  const items = $derived<MenuItem[]>([
    ...(machines.length > 1 ? [
      ...(pick ? [] : [{ id: 'all', label: strings.machines.all, active: filter === null, hideActiveMark: true }]),
      ...machines.map(m => ({ id: m.id, label: m.label, status: { tone: tones[health.get(m)!], label: health.get(m) === 'offline' ? strings.connection.offline : strings.connection[m.store.connection] }, active: m.id === filter })),
      separator('manage-separator')
    ] : []),
    { id: 'manage', label: strings.connection.manage, icon: 'settings' }
  ]);
  function choose(id: string) {
    if (id === 'manage') store.showSettings('machines');
    else onfilter?.(id === 'all' ? null : id);
  }
</script>

<!-- The wrapper stays, empty, so the connection state is always readable on it. -->
<div class="machines" class:problem={issues > 0} class:filtered={chosen !== null && !pick} class:named data-testid={pick ? 'agents-machine-status' : 'status-connection'} data-state={store.connection} aria-live="polite">
  {#if shown}
    <Menu {items} onpick={choose} {label} variant="ghost" testid={pick ? 'agents-machine' : 'machine-status'}>
      {#if issues}<TriangleAlert size={16} />{:else}<Monitor size={16} />{/if}
      {#if named && chosen}<span class="name ui-label">{chosen.label}</span>{/if}
    </Menu>
  {/if}
</div>

<style>
  .machines { min-width: 0; color: var(--color-muted-foreground); }
  .machines :global(.trigger) { font-size: var(--text-xs); }
  /* A filter hides threads, so while one is on the button says which machine. */
  .filtered :global(.trigger) { width: auto; max-width: 160px; padding: 0 8px; gap: 6px; background: var(--color-active); color: var(--color-foreground); }
  /* The Agents list names its machine without the filter's fill: nothing is hidden, it is where the list is. */
  .named:not(.filtered) :global(.trigger) { width: auto; max-width: 160px; padding: 0 8px; gap: 6px; color: var(--color-foreground); }
  /* min-width: a flex item never shrinks below its text otherwise, and a long
     name ran out of the button instead of ending in an ellipsis. */
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .problem { color: var(--color-live); }
  .problem :global(.trigger) { color: var(--color-live); }
</style>
