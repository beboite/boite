<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { onMount, untrack } from 'svelte';
  import { isExperimentEnabled, subscribeExperiments } from '../lib/experiments';
  import { glassSupported, readGlass, setGlass, type Glass } from '../lib/glass';
  import { LOCALES, localeSetting, setLocaleSetting, strings, type LocaleSetting } from '../lib/i18n.svelte';
  import { readTheme, setTheme, type Theme } from '../lib/theme';
  import { work, type PanelStart, type StartIn } from '../lib/work-prefs.svelte';
  import { ACCENT_PRESETS, readAccent, setAccent } from '../lib/accent';

  let accent = $state(untrack(() => readAccent()));
  function pickAccent(hue: number) { accent = hue; setAccent(hue); }

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
  let starts = $derived<{ id: StartIn; label: string }[]>([
    { id: 'drafts', label: strings.settings.startDrafts },
    { id: 'project', label: strings.settings.startProject }
  ]);
  let panels = $derived<{ id: PanelStart; label: string }[]>([
    { id: 'launcher', label: strings.settings.panelLauncher },
    { id: 'files', label: strings.settings.panelFiles },
    { id: 'changes', label: strings.settings.panelChanges }
  ]);
  let theme = $state<Theme>(untrack(() => readTheme()));

  function pickTheme(next: Theme) {
    theme = next;
    setTheme(next);
  }

  // The labels follow the language, so the list is derived rather than built
  // once when the page mounts.
  let materials = $derived<{ id: Glass; label: string }[]>([
    { id: 'acrylic', label: strings.settings.materialAcrylic },
    { id: 'mica', label: strings.settings.materialMica },
    { id: 'solid', label: strings.settings.materialSolid }
  ]);

  let locale = $state<LocaleSetting>(untrack(() => localeSetting()));
  function pickLocale(next: LocaleSetting) {
    locale = next;
    setLocaleSetting(next);
  }

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
    <div class="switch-row">
      <span class="text">{strings.settings.language}<InfoTip topic={strings.settings.language} text={strings.settings.languageHint} /></span>
      <div class="segmented" role="group" aria-label={strings.settings.language}>
        <button type="button" class:on={locale === 'system'} aria-pressed={locale === 'system'} data-testid="locale-system" onclick={() => pickLocale('system')}>
          {strings.settings.languageSystem}
        </button>
        {#each LOCALES as id (id)}
          <button type="button" class:on={locale === id} aria-pressed={locale === id} data-testid="locale-{id}" onclick={() => pickLocale(id)}>
            {strings.settings.languageNames[id]}
          </button>
        {/each}
      </div>
    </div>
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
    <div class="switch-row accent-row">
      <span class="text">{strings.settings.accent}<InfoTip topic={strings.settings.accent} text={strings.settings.accentHint} /></span>
      <div class="accent-controls">
        <div class="swatches" role="group" aria-label={strings.settings.accent}>
          {#each ACCENT_PRESETS as hue, index (hue)}
            <button type="button" class="swatch" data-accent-swatch style:--accent-hue={hue} aria-label={strings.settings.accentNames[index]} aria-pressed={accent === hue} data-testid="accent-{hue}" onclick={() => pickAccent(hue)}></button>
          {/each}
        </div>
        <input class="hue" type="range" min="0" max="360" step="1" value={accent} aria-label={strings.settings.accentCustom} data-testid="accent-hue" oninput={event => pickAccent(Number(event.currentTarget.value))} />
      </div>
    </div>
    {#if hasMaterial}
      <div class="switch-row">
        <span class="text">
          {strings.settings.material}<InfoTip topic={strings.settings.material} text={strings.settings.materialHint} />
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

  <!-- What the tour's question set, each piece on its own. -->
  <section class="card" id="settings-workspace">
    <h2>{strings.settings.workspace}</h2>
    <div class="switch-row">
      <span class="text">{strings.settings.startIn}<InfoTip topic={strings.settings.startIn} text={strings.settings.startInHint} /></span>
      <div class="segmented" role="group" aria-label={strings.settings.startIn}>
        {#each starts as option (option.id)}
          <button type="button" class:on={work.current.startIn === option.id} aria-pressed={work.current.startIn === option.id} data-testid="start-in-{option.id}" onclick={() => work.setStartIn(option.id)}>{option.label}</button>
        {/each}
      </div>
    </div>
    <div class="switch-row">
      <span class="text">{strings.settings.panelStart}<InfoTip topic={strings.settings.panelStart} text={strings.settings.panelStartHint} /></span>
      <div class="segmented" role="group" aria-label={strings.settings.panelStart}>
        {#each panels as option (option.id)}
          <button type="button" class:on={work.current.panel === option.id} aria-pressed={work.current.panel === option.id} data-testid="panel-start-{option.id}" onclick={() => work.setPanel(option.id)}>{option.label}</button>
        {/each}
      </div>
    </div>
  </section>
</div>

<style>
  .accent-controls { display: grid; gap: 10px; min-width: 220px; }
  .swatches { display: flex; gap: 7px; }
  .swatch { width: 26px; height: 26px; padding: 0; border-radius: 50%; background: var(--color-accent); border: 3px solid var(--color-surface-2); transition: transform var(--dur-2) var(--ease-out-quint); }
  .swatch:hover { transform: scale(1.12); }
  .swatch[aria-pressed='true'] { outline: 2px solid var(--color-foreground); outline-offset: 2px; }
  .hue { appearance: none; width: 100%; min-height: 0; height: 8px; padding: 0; background: var(--accent-spectrum); border: none; border-radius: 999px; cursor: pointer; }
  .hue::-webkit-slider-thumb { appearance: none; width: 16px; height: 16px; background: var(--color-foreground); border: 2px solid var(--color-surface-2); border-radius: 50%; box-shadow: var(--shadow-e1); }
  .hue::-moz-range-thumb { width: 14px; height: 14px; background: var(--color-foreground); border: 2px solid var(--color-surface-2); border-radius: 50%; }
  /* Scoped under the page so it outranks the shared row, which centres its children. */
  @media (max-width: 720px) { :global(.settings .page) .accent-row { flex-direction: column; align-items: stretch; } }
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
