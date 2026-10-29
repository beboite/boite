<script lang="ts">
  import { Pin, PinOff } from '@lucide/svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { pinnedQuotas } from '../lib/pinned-quotas.svelte';
  import { strings } from '../lib/strings';
  let label = $derived(pinnedQuotas.current.pinned ? strings.quotas.unpin : strings.quotas.pin);
</script>

{#if experimentOn('pinned-quotas')}
  <button type="button" class="ghost icon" aria-label={label} title={label} aria-pressed={pinnedQuotas.current.pinned} data-testid="quota-pin"
    onclick={() => pinnedQuotas.set(!pinnedQuotas.current.pinned)}>
    {#if pinnedQuotas.current.pinned}<PinOff size={16} />{:else}<Pin size={16} />{/if}
  </button>
{/if}
