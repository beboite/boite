<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import CompactionSettings from './CompactionSettings.svelte';
  import CacheKeepaliveSettings from './CacheKeepaliveSettings.svelte';
  import DeviceStreamSettings from './DeviceStreamSettings.svelte';
  import { untrack } from 'svelte';
  import { EXPERIMENT_IDS, canFollowDesktop, desktopExperiments, followsDesktop, readExperiments, setExperiment, setFollowDesktop, subscribeExperiments, type ExperimentId } from '../lib/experiments';
  import { experimentCopy } from '../lib/experiment-copy';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /** The switches of this device; with a store, the core's experiments below them. */
  let { store }: { store?: Store } = $props();
  const uid = $props.id();

  let copy = $derived(experimentCopy());

  let enabled = $state<ExperimentId[]>(untrack(() => readExperiments()));
  let following = $state(untrack(() => followsDesktop()));
  let heard = $state(untrack(() => desktopExperiments() !== null));

  function toggle(id: ExperimentId, on: boolean) {
    setExperiment(id, on);
  }

  // The desktop app can change them while the page is open.
  $effect(() => subscribeExperiments((next) => {
    enabled = next;
    following = followsDesktop();
    heard = desktopExperiments() !== null;
  }));
</script>

<div class="page" data-testid="experiments-page">
  <header>
    <div>
      <h1 class="ui-label-box"><span class="ui-label">{strings.settings.tabs.experiments}</span><InfoTip topic={strings.settings.tabs.experiments} text={strings.settings.experiments.intro} /></h1>
    </div>
  </header>

  <!-- The desktop app is what a phone follows: it has no one to follow itself. -->
  {#if canFollowDesktop()}
    <section class="card">
      <label for="{uid}-follow" class="switch-row">
        <span class="text">
          <span class="ui-label-box"><span class="ui-label" id="{uid}-follow-name">{strings.settings.experiments.follow}</span><InfoTip topic={strings.settings.experiments.follow} text={heard ? strings.settings.experiments.followHint : strings.settings.experiments.followNone} /></span>
        </span>
        <input id="{uid}-follow" aria-labelledby="{uid}-follow-name" type="checkbox" role="switch" data-testid="experiments-follow"
          checked={following} onchange={(event) => setFollowDesktop(event.currentTarget.checked)} />
      </label>
    </section>
  {/if}

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
    {/each}
  </section>

  {#if store}<CacheKeepaliveSettings {store} /><CompactionSettings {store} backgroundOnly /><DeviceStreamSettings {store} />{/if}
</div>
