<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import type TurnFiles from './TurnFiles.svelte';
  import { strings } from '../lib/strings';

  let props: ComponentProps<typeof TurnFiles> = $props();
  let loading = $state.raw(import('./TurnFiles.svelte'));
</script>

{#await loading then module}
  <module.default {...props} />
{:catch reason}
  <p role="alert">{reason instanceof Error ? reason.message : String(reason)}</p>
  <button class="ghost small" onclick={() => loading = import('./TurnFiles.svelte')}>{strings.common.refresh}</button>
{/await}
