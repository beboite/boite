<script lang="ts">
  import { Download } from '@lucide/svelte';
  import { appUpdater, showAppUpdateUi } from '../lib/app-update.svelte';
  import { strings } from '../lib/strings';
  import { workspace } from '../lib/workspace.svelte';

  const available = $derived((showAppUpdateUi() && appUpdater.hasUpdate)
    || workspace.machines.some(machine => machine.store.owner && (
      (!machine.store.localCore && machine.store.serverUpdater.offered)
      || machine.store.harnessUpdates.some(update => update.pending && update.skipped !== update.latest)
    )));
</script>

{#if available}
  <button type="button" class="ghost icon update-trigger" title={strings.serverUpdate.updates}
    aria-label={strings.serverUpdate.updates} onclick={() => workspace.active.showSettings('machines')}
    data-testid="nav-app-update">
    <Download size={16} strokeWidth={1.75} />
    <span class="badge" data-testid="app-update-badge" aria-hidden="true"></span>
  </button>
{/if}

<style>
  .update-trigger { position: relative; flex: none; }
  .badge { position: absolute; width: 5px; height: 5px; right: 3px; top: 3px; border-radius: 50%; background: var(--color-success); }
</style>
