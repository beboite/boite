<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { strings } from '../lib/strings';
  import type SignInCard from './SignInCard.svelte';

  /**
   * Sign-in cards are rare: the card loads with the first one, outside the
   * entry chunk, like the settings card. Until it does, the agent's reason
   * stands in for it.
   */
  let props: ComponentProps<typeof SignInCard> = $props();
  let loading = $state.raw(import('./SignInCard.svelte'));
</script>

{#await loading}
  <p class="hint" role="status" data-testid="sign-in-card-loading">{props.text}</p>
{:then module}
  <module.default {...props} />
{:catch}
  <div class="notice" role="status" data-testid="sign-in-card-failed">
    <span>{strings.signInRequest.loadFailed}</span>
    <button class="quiet" onclick={() => (loading = import('./SignInCard.svelte'))}><span class="ui-label">{strings.common.refresh}</span></button>
  </div>
{/await}

<style>
  .hint { margin: 0; padding: var(--activity-padding); font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .notice { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: var(--activity-padding); font-size: var(--text-sm); color: var(--color-muted-foreground); }
</style>
