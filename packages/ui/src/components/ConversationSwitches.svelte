<script lang="ts">
  import { FileText, ListFilter } from '@lucide/svelte';
  import { featureOn } from '../lib/features.svelte';
  import { setFeature } from '../lib/features';
  import { recentPreferences } from '../lib/recent.svelte';
  import { strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  /**
   * The conversation switches kept on this device, the same rows in the
   * desktop's General page and the phone's settings: how the thread lists
   * group, and whether answers show their files and previews.
   */
  let { mobile = false }: { mobile?: boolean } = $props();
  const uid = $props.id();
  const options = $derived([
    { id: 'group-working-threads', icon: ListFilter, label: strings.settings.groupWorkingThreads, hint: strings.settings.groupWorkingThreadsHint, checked: recentPreferences.groupWorking, set: (value: boolean) => recentPreferences.setGroupWorking(value) },
    { id: 'group-other-projects', icon: ListFilter, label: strings.settings.groupOtherProjects, hint: strings.settings.groupOtherProjectsHint, checked: recentPreferences.groupOtherProjects, set: (value: boolean) => recentPreferences.setGroupOtherProjects(value) },
    { id: 'chat-artifacts', icon: FileText, label: strings.features.chatArtifacts.title, hint: strings.features.chatArtifacts.hint, checked: featureOn('chat-artifacts'), set: (value: boolean) => setFeature('chat-artifacts', value) }
  ]);
</script>

{#each options as option (option.id)}
  <!-- On a desktop the rows are the settings page's own switch rows, the same face as the card's others. -->
  <label for="{uid}-{option.id}" class={mobile ? 'grouping-row mobile' : 'switch-row'}>
    {#if mobile}<option.icon size={20} />{/if}
    <span class="text ui-label-box">
      <span class="ui-label" id="{uid}-{option.id}-name">{option.label}</span><InfoTip topic={option.label} text={option.hint} />
    </span>
    <input id="{uid}-{option.id}" aria-labelledby="{uid}-{option.id}-name" type="checkbox" role="switch" data-testid="setting-{option.id}"
      checked={option.checked} onchange={event => option.set(event.currentTarget.checked)} />
  </label>
{/each}

<style>
  .grouping-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .grouping-row .text { flex: 1; min-width: 0; font-size: var(--text-sm); }
  /* The phone's settings rows (MobileSettings.svelte): the same height, padding and type as the links beside them. */
  .mobile { min-height: 56px; padding: 12px 16px; border-bottom: 1px solid var(--color-border); }
  .mobile .text { font-size: var(--text-base); font-weight: 500; color: var(--color-foreground); }
  .mobile:last-child { border-bottom: 0; }
  .mobile :global(svg) { flex: none; color: var(--color-muted-foreground); }
  input { flex: none; }
</style>
