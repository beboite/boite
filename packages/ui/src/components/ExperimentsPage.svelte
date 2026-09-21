<script lang="ts">
  import { untrack } from 'svelte';
  import { EXPERIMENT_IDS, readExperiments, setExperiment, type ExperimentId } from '../lib/experiments';
  import { strings } from '../lib/i18n.svelte';

  /** One entry per shipped id, so a new experiment cannot land without its words. */
  const copy: Record<ExperimentId, { title: string; hint: string }> = {
    'theme-grain': strings.experiments.themeGrain,
    'session-import': strings.experiments.sessionImport
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
      <h1>{strings.settings.tabs.experiments}</h1>
      <p>{strings.settings.experiments.intro}</p>
    </div>
  </header>

  <section class="card">
    {#each EXPERIMENT_IDS as id (id)}
      <label class="switch-row" id="settings-{id}">
        <span class="text">
          {copy[id].title}
          <span class="hint">{copy[id].hint}</span>
        </span>
        <input
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
