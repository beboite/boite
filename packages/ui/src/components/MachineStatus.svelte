<script lang="ts">
  import { workspace } from '../lib/workspace.svelte';
  import { Monitor, TriangleAlert } from '@lucide/svelte';


  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import Menu from './Menu.svelte';
  let { store, filter = null, onfilter }: { store: Store; filter?: string | null; onfilter?: (id: string | null) => void } = $props();

  const machines = $derived(workspace.machines.length ? workspace.machines : [{ id: 'current', label: strings.connection.local, store }]);
  const connected = $derived(machines.filter(m => m.store.connection === 'ready').length);
  const issues = $derived(machines.filter(m => m.store.connection === 'closed' || (m.store.booted && m.store.connection !== 'ready')).length);
  const items = $derived([
    { id: 'all', label: strings.machines.all, active: filter === null },
    ...machines.map(m => ({ id: m.id, label: m.label, status: { tone: m.store.connection === 'ready' ? 'success' as const : m.store.connection === 'closed' ? 'danger' as const : 'warning' as const, label: strings.connection[m.store.connection] }, active: m.id === filter })),
    { id: 'manage', label: strings.connection.manage }
  ]);
  function pick(id: string) {
    if (id === 'manage') store.showSettings('machines');
    else onfilter?.(id === 'all' ? null : id);
  }</script>

<div class="machines" class:problem={issues > 0} data-testid="status-connection" data-state={store.connection} aria-live="polite">
  <Menu {items} onpick={pick} label={strings.connection.manage} variant="ghost" testid="machine-status">
    {#if issues}<TriangleAlert size={14} />{:else}<Monitor size={14} />{/if}
    <span>{connected} {connected === 1 ? strings.connection.oneMachine : strings.connection.machines}</span>
    {#if issues}<span class="count" title={`${issues} ${strings.connection.issues}`}>{issues}</span>{/if}
  </Menu>
</div>

<style>
  .machines { flex: 1; min-width: 0; color: var(--color-muted-foreground); }
  .machines :global(.trigger) { width: 100%; justify-content: flex-start; font-size: var(--text-xs); padding: 0 4px; gap: 6px; }
  .machines span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .problem { color: var(--color-live); }
  .count { color: var(--color-live); flex: none; }
</style>
