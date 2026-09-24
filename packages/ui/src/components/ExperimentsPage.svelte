<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { untrack } from 'svelte';
  import { EXPERIMENT_IDS, readExperiments, setExperiment, type ExperimentId } from '../lib/experiments';
  import { strings } from '../lib/strings';

  const uid = $props.id();

  /** One entry per shipped id, so a new experiment cannot land without its words. */
  const copy: Record<ExperimentId, { title: string; hint: string }> = {
    'theme-grain': strings.experiments.themeGrain,
    'session-import': strings.experiments.sessionImport,
    'prompt-cache': strings.experiments.promptCache
  };

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
</div>
