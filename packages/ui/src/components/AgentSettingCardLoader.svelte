<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { strings } from '../lib/strings';
  import type AgentSettingCard from './AgentSettingCard.svelte';

  /**
   * Agent setting cards are rare: the card loads with the first one, outside the
   * entry chunk. Until it does, the thread's reason stands in for it; a chunk
   * that fails to load (an update, a phone offline) offers another try.
   */
  let props: ComponentProps<typeof AgentSettingCard> = $props();
  let loading = $state.raw(import('./AgentSettingCard.svelte'));
</script>

{#await loading}
  <p class="hint" role="status" data-testid="agent-setting-card-loading">{props.text}</p>
{:then module}
  <module.default {...props} />
{:catch}
  <div class="notice" role="status" data-testid="agent-setting-card-failed">
    <span>{strings.agentSettingRequest.loadFailed}</span>
    <button class="quiet" onclick={() => (loading = import('./AgentSettingCard.svelte'))}><span class="ui-label">{strings.common.refresh}</span></button>
  </div>
{/await}

<style>
  .hint { margin: 0; padding: var(--activity-padding); font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .notice { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: var(--activity-padding); font-size: var(--text-sm); color: var(--color-muted-foreground); }
</style>
