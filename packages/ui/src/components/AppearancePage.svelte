<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { isExperimentEnabled, subscribeExperiments } from '../lib/experiments';
  import { glassSupported, readGlass, setGlass, type Glass } from '../lib/glass';
  import { strings } from '../lib/strings';
  import { readTheme, setTheme, type Theme } from '../lib/theme';

  // Grain rides behind an experiment, so the fourth option comes and goes with
  // the switch on the Experiments page rather than on a reload.
  let grain = $state(untrack(() => isExperimentEnabled('theme-grain')));

  let themes = $derived<{ id: Theme; label: string }[]>([
    { id: 'system', label: strings.settings.themeSystem },
    { id: 'dark', label: strings.settings.themeDark },
    { id: 'light', label: strings.settings.themeLight },
    ...(grain ? [{ id: 'grain' as const, label: strings.settings.themeGrain }] : [])
  ]);

  // `readTheme` answers `system` for a grain that lost its experiment, which is
  // the fallback the segmented control has to show.
  let theme = $state<Theme>(untrack(() => readTheme()));

  function pickTheme(next: Theme) {
    theme = next;
    setTheme(next);
  }

  const materials: { id: Glass; label: string }[] = [
    { id: 'acrylic', label: strings.settings.materialAcrylic },
    { id: 'mica', label: strings.settings.materialMica },
    { id: 'solid', label: strings.settings.materialSolid }
  ];
  let glass = $state<Glass>(untrack(() => readGlass()));
  // The shell answers on Windows alone, so the row stays away everywhere else.
  let hasMaterial = $state(false);

  onMount(() => {
    void glassSupported().then((supported) => (hasMaterial = supported));
    return subscribeExperiments(() => {
      grain = isExperimentEnabled('theme-grain');
      theme = readTheme();
    });
  });

  function pickMaterial(next: Glass) {
    glass = next;
    setGlass(next);
  }
</script>

<div class="page" data-testid="appearance-page">
  <header>
    <h1>{strings.settings.tabs.appearance}</h1>
  </header>

  <section class="card" id="settings-theme">
    <h2>{strings.settings.appearance}</h2>
    <div class="switch-row">
      <span class="text">{strings.settings.theme}</span>
      <div class="segmented" role="group" aria-label={strings.settings.theme}>
        {#each themes as option (option.id)}
          <button
            type="button"
            class:on={theme === option.id}
            aria-pressed={theme === option.id}
            data-testid="theme-{option.id}"
            onclick={() => pickTheme(option.id)}
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>
    {#if hasMaterial}
      <div class="switch-row">
        <span class="text">
          {strings.settings.material}
          <span class="hint">{strings.settings.materialHint}</span>
        </span>
        <div class="segmented" role="group" aria-label={strings.settings.material}>
          {#each materials as option (option.id)}
            <button
              type="button"
              class:on={glass === option.id}
              aria-pressed={glass === option.id}
              data-testid="glass-{option.id}"
              onclick={() => pickMaterial(option.id)}
            >
              {option.label}
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </section>
</div>

<style>
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

  /* The options in one track, the chosen one filled like a primary button. */
  .segmented {
    display: inline-flex;
    flex: none;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
  }

  .segmented button {
    height: var(--control-sm);
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }

  .segmented button:hover:not(.on) {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  .segmented button.on {
    background: var(--color-foreground);
    border-color: var(--color-foreground);
    color: var(--color-on-foreground);
  }
</style>
