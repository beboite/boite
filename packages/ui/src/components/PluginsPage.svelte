<script lang="ts">
  import PluginsMachine from './PluginsMachine.svelte';
  import type { Store } from '../lib/store.svelte';

  /**
   * One machine's plugins: the one the settings bar picked, this PC until
   * then, since a plugin runs beside the core that installed it and a desktop
   * app shows its window there. A fresh page per machine, so an answer still
   * on its way from the previous core lands in a discarded one.
   */
  let { store }: { store: Store } = $props();
</script>

{#key store}
  <PluginsMachine {store} />
{/key}
