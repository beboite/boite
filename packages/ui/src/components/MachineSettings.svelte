<script lang="ts">
  import { ArrowLeft } from '@lucide/svelte';
  import type { Machine } from '../lib/workspace.svelte';
  import { fill, strings } from '../lib/strings';
  import ResourcesPage from './ResourcesPage.svelte';
  import SchedulerSettings from './SchedulerSettings.svelte';
  import WorktreeStorageSetting from './WorktreeStorageSetting.svelte';

  let { machine, source, onback }: { machine: Machine; source?: string; onback: () => void } = $props();
  const store = $derived(machine.store);
</script>

<div class="machine-settings" data-testid="machine-settings" data-machine-id={machine.id}>
  <header>
    <button class="ghost back" data-testid="machine-settings-back" onclick={onback}><ArrowLeft size={15} />{strings.machines.heading}</button>
    <h1>{machine.label}</h1>
    <p>{strings.machines.settingsHint}</p>
    {#if source}<p class="synced" data-testid="machine-settings-source">{fill(strings.machines.synced, { source })}</p>{/if}
  </header>
  {#if store.connection !== 'ready'}<p role="status">{strings.connection[store.connection]}</p>{/if}
  {#if store.error}<p class="error" role="alert">{store.error}</p>{/if}
  <fieldset class="page" disabled={store.connection !== 'ready' || !store.settings}>
    <ResourcesPage {store} limitsOnly />
    <SchedulerSettings {store} />
    <section class="card">
      <h2>{strings.settings.worktrees.storage}</h2>
      <WorktreeStorageSetting {store} />
    </section>
  </fieldset>
</div>

<style>
  .machine-settings { padding: 36px clamp(20px, 4vw, 64px); }
  .machine-settings > * { max-width: var(--settings-width); }
  header { margin-bottom: 20px; }
  .back { margin-bottom: 16px; }
  h1 { margin: 0 0 8px; font-size: var(--text-lg); overflow-wrap: anywhere; }
  header p { margin: 8px 0 0; color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; }
  .synced { color: var(--color-subtle); }
  .machine-settings > fieldset.page { border: 0; padding: 0; margin: 0; min-width: 0; }
  .machine-settings > fieldset.page :global(.page) { padding: 0; }
  fieldset :global(.card) { margin-bottom: 16px; }
  fieldset :global([data-testid='worktree-storage']) { padding-bottom: 0; margin-bottom: 0; border-bottom: 0; }
  .error { color: var(--color-danger); overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    .machine-settings { padding: 16px; }
    .back { min-height: var(--touch-target); }
  }
</style>
