<script lang="ts">
  import { ListFilter } from '@lucide/svelte';
  import { recentPreferences } from '../lib/recent.svelte';
  import { strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  let { mobile = false }: { mobile?: boolean } = $props();
  const uid = $props.id();
  const options = $derived([
    { id: 'working-threads', label: strings.settings.groupWorkingThreads, hint: strings.settings.groupWorkingThreadsHint, checked: recentPreferences.groupWorking, set: (value: boolean) => recentPreferences.setGroupWorking(value) },
    { id: 'other-projects', label: strings.settings.groupOtherProjects, hint: strings.settings.groupOtherProjectsHint, checked: recentPreferences.groupOtherProjects, set: (value: boolean) => recentPreferences.setGroupOtherProjects(value) }
  ]);
</script>

{#each options as option (option.id)}
  <label for="{uid}-{option.id}" class="grouping-row" class:mobile>
    {#if mobile}<ListFilter size={20} />{/if}
    <span class="text ui-label-box">
      <span class="ui-label" id="{uid}-{option.id}-name">{option.label}</span><InfoTip topic={option.label} text={option.hint} />
    </span>
    <input id="{uid}-{option.id}" aria-labelledby="{uid}-{option.id}-name" type="checkbox" role="switch" data-testid="setting-group-{option.id}"
      checked={option.checked} onchange={event => option.set(event.currentTarget.checked)} />
  </label>
{/each}

<style>
  .grouping-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 42px; padding: 10px 0; }
  .text { flex: 1; min-width: 0; font-size: var(--text-sm); }
  .mobile { min-height: var(--touch-target); padding: 13px 14px; border-bottom: 1px solid var(--color-border); }
  .mobile:last-child { border-bottom: 0; }
  .mobile :global(svg) { flex: none; color: var(--color-muted-foreground); }
  input { flex: none; }
</style>
