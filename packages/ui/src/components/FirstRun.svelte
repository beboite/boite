<script lang="ts">
  import { FolderOpen } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import BoiteMark from './BoiteMark.svelte';

  let { store }: { store: Store } = $props();

</script>

<div class="first-run" data-testid="first-run">
  <div class="card">
    <div class="mark"><BoiteMark size={28} /></div>
    <h1>{strings.firstRun.heading}</h1>
    <!-- A paired device cannot open a folder, so it gets the one sentence that
         says where the list comes from instead of a form that would be refused. -->
    <p class="muted">{store.owner ? strings.firstRun.body : strings.firstRun.deviceBody}</p>

    {#if store.owner}
      <button type="button" class="primary big" data-testid="add-project" onclick={() => (store.projectPickerOpen = true)}>
        <FolderOpen size={16} strokeWidth={1.75} />
        {strings.firstRun.pick}
      </button>
      <p class="subtle drop-hint">{strings.firstRun.dropHint}</p>
    {/if}
  </div>
</div>

<style>
  .first-run {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    width: min(420px, 100%);
    padding: 36px 32px 28px;
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-e2);
    text-align: center;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  /* The mark stands on the card, with no tile of its own: a second box behind a
     drawing that is already a box only doubles the edges. */
  .mark {
    display: grid;
    place-items: center;
    margin-bottom: 6px;
  }

  h1 {
    font-size: var(--text-lg);
  }

  p {
    max-width: 30ch;
  }

  .big {
    height: 36px;
    padding: 0 16px;
    margin-top: 10px;
  }

  .drop-hint {
    font-size: var(--text-sm);
    max-width: none;
    white-space: nowrap;
  }

</style>
