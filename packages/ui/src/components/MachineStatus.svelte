<script lang="ts">
  import { untrack } from 'svelte';
  import { Monitor, TriangleAlert } from '@lucide/svelte';
  import { WsClient } from '../lib/client';
  import { defaultEnvironmentLabel } from '../lib/endpoint';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import Menu from './Menu.svelte';
  let { store }: { store: Store } = $props();

  // Only the active core loads projects and threads. These sockets observe availability.
  $effect(() => {
    const active = store.endpointUrl;
    const environments = store.environments;
    const clients = untrack(() => environments.filter(e => e.url !== active).map(environment => {
      const client = new WsClient({ ...environment, reconnect: false });
      const stop = client.onState(state => {
        store.machineStates = { ...store.machineStates, [environment.url]: { state } };
      });
      let timeout: ReturnType<typeof setTimeout>;
      function connect() {
        timeout = setTimeout(() => { if (client.state !== 'ready') client.close(); }, 8000);
        void client.connect().catch(error => {
          store.machineStates = { ...store.machineStates, [environment.url]: { state: 'closed', error: error instanceof Error ? error.message : String(error) } };
        }).finally(() => clearTimeout(timeout));
      }
      connect();
      const retry = setInterval(() => { if (client.state === 'closed') connect(); }, 30_000);
      return () => { clearTimeout(timeout); clearInterval(retry); stop(); client.close(); };
    }));
    return () => clients.forEach(close => close());
  });

  const otherMachines = $derived(store.environments.filter(e => e.url !== store.endpointUrl));
  const connected = $derived((store.connection === 'ready' ? 1 : 0) + otherMachines.filter(e => store.machineStates[e.url]?.state === 'ready').length);
  const issues = $derived((store.connection === 'closed' ? 1 : 0) + otherMachines.filter(e => store.machineStates[e.url]?.state === 'closed').length);
  const currentName = $derived(store.localCore ? strings.connection.local : store.endpointUrl ? defaultEnvironmentLabel(store.endpointUrl) : strings.connection.current);
  const items = $derived([
    { id: 'current', label: currentName, hint: strings.connection[store.connection], active: true },
    ...otherMachines.map(e => ({ id: e.url, label: e.label, hint: store.machineStates[e.url]?.error ?? strings.connection[store.machineStates[e.url]?.state ?? 'connecting'] })),
    { id: 'manage', label: strings.connection.manage }
  ]);
  function pick(id: string) {
    if (id === 'manage') store.showSettings('general');
    else if (id !== 'current') void store.switchEnvironment(id);
  }
</script>

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
