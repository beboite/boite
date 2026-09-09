<script lang="ts">
  import { untrack } from 'svelte';
  import { EXPERIMENT_IDS, readExperiments, setExperiment, type ExperimentId } from '../lib/experiments';
  import { strings } from '../lib/strings';

  /** One entry per shipped id, so a new experiment cannot land without its words. */
  const copy: Record<ExperimentId, { title: string; hint: string }> = {
    'theme-grain': strings.experiments.themeGrain
  };

  let enabled = $state<ExperimentId[]>(untrack(() => readExperiments()));

  function toggle(id: ExperimentId, on: boolean) {
    setExperiment(id, on);
    enabled = readExperiments();
  }
</script>

<div class="page" data-testid="experiments-page">
  <header>
    <h1>{strings.settings.tabs.experiments}</h1>
  </header>

  <section class="card">
    <h2>{strings.settings.experiments.heading}</h2>
    <p class="intro">{strings.settings.experiments.intro}</p>
    {#each EXPERIMENT_IDS as id (id)}
      <label class="switch-row">
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

<style>
  .intro {
    color: var(--color-muted-foreground);
    margin: 0;
  }

  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .switch-row .text {
    color: var(--color-foreground);
    font-size: var(--text-base);
    margin: 0;
  }

  .switch-row .hint {
    display: block;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    margin-top: 2px;
  }

  .switch-row input {
    flex: none;
    width: 28px;
    height: 16px;
    margin: 0;
    appearance: none;
    border-radius: 999px;
    background: var(--color-edge);
    position: relative;
    cursor: pointer;
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .switch-row input::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--color-background);
    transition: transform var(--dur-2) var(--ease-out-quint);
  }

  .switch-row input:checked {
    background: var(--color-foreground);
  }

  .switch-row input:checked::after {
    transform: translateX(12px);
  }

  /* The track is small and round, so the ring stands off it rather than
     hugging the pill where it would read as part of the control. */
  .switch-row input:focus-visible {
    outline-offset: 3px;
  }
</style>
