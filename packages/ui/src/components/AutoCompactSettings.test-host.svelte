<script lang="ts">
  import type { Store } from '../lib/store.svelte';
  import AutoCompactSettings from './AutoCompactSettings.svelte';

  /** The settings pages' shape for the tests: the card keyed on the machine the settings bar picked. */
  let { pick }: { pick: { store: Store } } = $props();
</script>

{#key pick.store}
  <AutoCompactSettings store={pick.store} />
{/key}
