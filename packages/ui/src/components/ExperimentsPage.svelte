<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import CacheKeepaliveSettings from './CacheKeepaliveSettings.svelte';
  import DeviceStreamSettings from './DeviceStreamSettings.svelte';
  import GoalTrackerSetting from './GoalTrackerSetting.svelte';
  import { untrack } from 'svelte';
  import { EXPERIMENT_IDS, readExperiments, setExperiment, type ExperimentId } from '../lib/experiments';
  import { experimentCopy } from '../lib/experiment-copy';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /** The switches of this device; with a store, the core's experiments below them. */
  let { store }: { store?: Store } = $props();
  const uid = $props.id();

  let copy = $derived(experimentCopy());

  let enabled = $state<ExperimentId[]>(untrack(() => readExperiments()));

  function toggle(id: ExperimentId, on: boolean) {
    setExperiment(id, on);
    enabled = readExperiments();
  }
</script>

<div class="page" data-testid="experiments-page">
  <header>
    <div>
      <h1 class="ui-label-box"><span class="ui-label">{strings.settings.tabs.experiments}</span><InfoTip topic={strings.settings.tabs.experiments} text={strings.settings.experiments.intro} /></h1>
    </div>
  </header>

  <section class="card">
    {#each EXPERIMENT_IDS as id (id)}
      <label for="{uid}-{id}" class="switch-row" id="settings-{id}">
        <span class="text">
          <span class="ui-label-box"><span class="ui-label" id="{uid}-{id}-name">{copy[id].title}</span><InfoTip topic={copy[id].title} text={copy[id].hint} /></span>
        </span>
        <input id="{uid}-{id}" aria-labelledby="{uid}-{id}-name"
          type="checkbox"
          role="switch"
          data-testid="experiment-{id}"
          checked={enabled.includes(id)}
          onchange={(event) => toggle(id, event.currentTarget.checked)}
        />
      </label>
      <!-- Only the owner sets the machine's checklist model: a paired device's save would be refused. -->
      {#if id === 'goal2' && enabled.includes(id) && store?.settings && store.owner}
        <GoalTrackerSetting {store} />
      {/if}
    {/each}
  </section>

  {#if store}<CacheKeepaliveSettings {store} /><DeviceStreamSettings {store} />{/if}
</div>
