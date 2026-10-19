<script lang="ts">
  import { featureOn } from '../lib/features.svelte';
  import { setFeature } from '../lib/features';
  import { recentPreferences } from '../lib/recent.svelte';
  import { strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  /**
   * The conversation switches kept on this device, rows of the desktop's
   * General page: how the thread lists group, and whether answers show their
   * files and previews. A phone groups from the list's display options and
   * finds the files switch under Appearance.
   */
  const uid = $props.id();
  const options = $derived([
    { id: 'group-working-threads', label: strings.settings.groupWorkingThreads, hint: strings.settings.groupWorkingThreadsHint, checked: recentPreferences.groupWorking, set: (value: boolean) => recentPreferences.setGroupWorking(value) },
    { id: 'group-other-projects', label: strings.settings.groupOtherProjects, hint: strings.settings.groupOtherProjectsHint, checked: recentPreferences.groupOtherProjects, set: (value: boolean) => recentPreferences.setGroupOtherProjects(value) },
    { id: 'chat-artifacts', label: strings.features.chatArtifacts.title, hint: strings.features.chatArtifacts.hint, checked: featureOn('chat-artifacts'), set: (value: boolean) => setFeature('chat-artifacts', value) }
  ]);
</script>

{#each options as option (option.id)}
  <label for="{uid}-{option.id}" class="switch-row">
    <span class="text ui-label-box">
      <span class="ui-label" id="{uid}-{option.id}-name">{option.label}</span><InfoTip topic={option.label} text={option.hint} />
    </span>
    <input id="{uid}-{option.id}" aria-labelledby="{uid}-{option.id}-name" type="checkbox" role="switch" data-testid="setting-{option.id}"
      checked={option.checked} onchange={event => option.set(event.currentTarget.checked)} />
  </label>
{/each}

<style>
  input { flex: none; }
</style>
