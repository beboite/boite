<script lang="ts">
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  let { store, onopenthread }: { store: Store; onopenthread?: () => void } = $props();
  let loading = $state.raw(import('./TaskManager.svelte'));
</script>

{#await loading}
  <p class="hint" role="status">{strings.taskManager.loading}</p>
{:then module}
  <module.default {store} {onopenthread} />
{:catch}
  <div class="notice" role="status">
    <span>{strings.taskManager.loadFailed}</span>
    <button class="quiet" onclick={() => loading = import('./TaskManager.svelte')}>{strings.common.refresh}</button>
  </div>
{/await}
