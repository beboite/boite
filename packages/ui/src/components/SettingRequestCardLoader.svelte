<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import type SettingRequestCard from './SettingRequestCard.svelte';

  /**
   * Settings cards are rare: the card loads with the first one, outside the
   * entry chunk. While it loads the dock's row already shows the reason.
   */
  let props: ComponentProps<typeof SettingRequestCard> = $props();
  let loading = $state.raw(import('./SettingRequestCard.svelte'));
</script>

{#await loading then module}
  <module.default {...props} />
{/await}
