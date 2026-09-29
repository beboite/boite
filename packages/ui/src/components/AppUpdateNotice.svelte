<script lang="ts">
  import { CircleArrowDown, X } from '@lucide/svelte';
  import { appUpdater, showAppUpdateUi } from '../lib/app-update.svelte';
  import { appUpdateInstall } from '../lib/app-update-install.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  let { store }: { store: Store } = $props();
</script>

  {#if showAppUpdateUi() && appUpdater.announceReady}
    <div class="update-actions" role="group" aria-label={strings.appUpdate.heading} data-testid="update-notice-actions">
      <button
        type="button"
        class="small update-ready"
        title={strings.appUpdate.detailsNotice}
        aria-label={strings.appUpdate.detailsNotice}
        disabled={appUpdateInstall.preparing}
        onclick={() => store.showSettings('general', 'app-update')}
        data-testid="update-notice-ready"
      >
        <CircleArrowDown size={14} strokeWidth={1.75} />
        <span>{strings.appUpdate.readyAction}</span>
      </button>
      <button
        type="button"
        class="ghost small icon update-dismiss"
        title={strings.appUpdate.dismissNotice}
        aria-label={strings.appUpdate.dismissNotice}
        onclick={() => appUpdater.dismiss()}
        data-testid="update-notice-dismiss"
      ><X size={14} strokeWidth={1.75} /></button>
    </div>
  {/if}

<style>
  .update-actions {
    display: inline-flex;
    align-items: center;
    flex: none;
    align-self: flex-start;
    margin: 0 8px 8px;
    height: var(--control-sm);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
  }

  .update-actions button {
    height: 100%;
    border: none;
    background: transparent;
  }
  .update-actions button:hover:not(:disabled) { background: var(--color-hover); }
  .update-ready {
    gap: 5px;
    font-size: var(--text-xs);
    border-radius: var(--radius-md) 0 0 var(--radius-md);
  }
  .update-actions .update-dismiss {
    border-left: 1px solid var(--color-edge);
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
  }

</style>
