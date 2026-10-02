<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { untrack } from 'svelte';
  import { EXPERIMENT_IDS, readExperiments, setExperiment, type ExperimentId } from '../lib/experiments';
  import { experimentCopy } from '../lib/experiment-copy';
  import { strings } from '../lib/strings';

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
      <h1>{strings.settings.tabs.experiments}<InfoTip topic={strings.settings.tabs.experiments} text={strings.settings.experiments.intro} /></h1>
    </div>
  </header>

  <section class="card">
    {#each EXPERIMENT_IDS as id (id)}
      <label for="{uid}-{id}" class="switch-row" id="settings-{id}">
        <span class="text">
          <span id="{uid}-{id}-name">{copy[id].title}</span><InfoTip topic={copy[id].title} text={copy[id].hint} />
          {#if id === 'agent-browser-control'}<span class="hint" id="{uid}-{id}-hint">{copy[id].hint}</span>{/if}
        </span>
        <input id="{uid}-{id}" aria-labelledby="{uid}-{id}-name"
          aria-describedby={id === 'agent-browser-control' ? `${uid}-${id}-hint` : undefined}
          type="checkbox"
          role="switch"
          data-testid="experiment-{id}"
          checked={enabled.includes(id)}
          onchange={(event) => toggle(id, event.currentTarget.checked)}
        />
      </label>
    {/each}
  </section>
</div>
