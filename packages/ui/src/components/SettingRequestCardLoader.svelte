<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { strings } from '../lib/strings';
  import type SettingRequestCard from './SettingRequestCard.svelte';

  /**
   * Settings cards are rare: the card loads with the first one, outside the
   * entry chunk. Until it does, the agent's reason stands in for it; a chunk
   * that fails to load (an update, a phone offline) offers another try.
   */
  let props: ComponentProps<typeof SettingRequestCard> = $props();
  let loading = $state.raw(import('./SettingRequestCard.svelte'));
</script>

{#await loading}
  <p class="hint" role="status" data-testid="setting-card-loading">{props.text}</p>
{:then module}
  <module.default {...props} />
{:catch}
  <div class="notice" role="status" data-testid="setting-card-failed">
    <span>{strings.settingRequest.loadFailed}</span>
    <button class="quiet" onclick={() => (loading = import('./SettingRequestCard.svelte'))}><span class="ui-label">{strings.common.refresh}</span></button>
  </div>
{/await}

<style>
  .hint { margin: 0; padding: var(--activity-padding); font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .notice { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: var(--activity-padding); font-size: var(--text-sm); color: var(--color-muted-foreground); }
</style>
