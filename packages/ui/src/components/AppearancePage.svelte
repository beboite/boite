<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { Minus, Plus } from '@lucide/svelte';
  import { onMount, untrack } from 'svelte';
  import { FONTS, MONOS, readFont, readMono, setFont, setMono, type Font, type Mono } from '../lib/fonts';
  import { percent } from '../lib/format';
  import { currentZoom, inShell, setZoom, stepZoom, subscribeZoom, wantedZoom, ZOOM_DEFAULT, ZOOM_STEPS } from '../lib/zoom';
  import { isExperimentEnabled, subscribeExperiments } from '../lib/experiments';
  import { effectiveGlass, hasMaterialChoice, readGlass, setGlass, supportedGlass, type Glass } from '../lib/glass';
  import { fill, LOCALES, localeSetting, setLocaleSetting, strings, type LocaleSetting } from '../lib/i18n.svelte';
  import { readTheme, setTheme, type Theme } from '../lib/theme';
  import { work, type PanelStart, type StartIn } from '../lib/work-prefs.svelte';
  import { ACCENT_PRESETS, readAccent, setAccent } from '../lib/accent';

  let accent = $state(untrack(() => readAccent()));
  function pickAccent(hue: number) { accent = hue; setAccent(hue); }

  /*
   * A face's own name, the same in every language; `system` is the one the
   * catalogue words. Here rather than in lib/fonts.ts, which the entry chunk
   * carries: nothing but this picker reads them.
   */
  const FONT_NAMES: Record<Exclude<Font, 'system'>, string> = {
    geist: 'Geist',
    inter: 'Inter',
    plex: 'IBM Plex Sans',
    atkinson: 'Atkinson Hyperlegible',
    figtree: 'Figtree',
    source: 'Source Sans 3',
    dm: 'DM Sans'
  };
  const MONO_NAMES: Record<Exclude<Mono, 'system'>, string> = { geist: 'Geist Mono', jetbrains: 'JetBrains Mono' };

  let font = $state<Font>(untrack(() => readFont()));
  let mono = $state<Mono>(untrack(() => readMono()));
  let faces = $derived(FONTS.map((id) => ({ id, name: id === 'system' ? strings.settings.fontSystem : FONT_NAMES[id] })));
  let monos = $derived(MONOS.map((id) => ({ id, name: id === 'system' ? strings.settings.monoSystem : MONO_NAMES[id] })));
  function pickFont(next: Font) { font = next; setFont(next); }
  function pickMono(next: Mono) { mono = next; setMono(next); }

  // The zoom is the shell webview's own; a browser tab has its own Ctrl+= already.
  const zoomable = inShell();
  let zoom = $state(currentZoom());
  let zoomError = $state('');
  function zoomTo(factor: number) {
    zoomError = '';
    setZoom(factor).catch((error: unknown) => {
      zoomError = fill(strings.settings.zoomFailed, { error: error instanceof Error ? error.message : String(error) });
    });
  }
  const smallest = ZOOM_STEPS[0] ?? ZOOM_DEFAULT;
  const largest = ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? ZOOM_DEFAULT;

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
  // Only the kinds this Windows draws without lag: the shell answers from its build.
  let offered = $state<Glass[]>([]);
  let materials = $derived(
    ([
      { id: 'acrylic', label: strings.settings.materialAcrylic },
      { id: 'mica', label: strings.settings.materialMica },
      { id: 'solid', label: strings.settings.materialSolid }
    ] satisfies { id: Glass; label: string }[]).filter((option) => offered.includes(option.id))
  );

  let locale = $state<LocaleSetting>(untrack(() => localeSetting()));
  function pickLocale(next: LocaleSetting) {
    locale = next;
    setLocaleSetting(next);
  }

  let glass = $state<Glass>(untrack(() => readGlass()));
  // The shell answers on Windows alone, and Windows 10 offers solid alone, so
  // the row stays away wherever there is nothing to pick.
  let hasMaterial = $derived(hasMaterialChoice(offered));

  onMount(() => {
    void supportedGlass().then((supported) => {
      offered = supported;
      glass = effectiveGlass(glass, supported);
    });
    // Ctrl+= moves the zoom from anywhere, this page included.
    const stopZoom = subscribeZoom((factor) => { zoom = factor; });
    const stopExperiments = subscribeExperiments(() => {
      grain = isExperimentEnabled('theme-grain');
      theme = readTheme();
    });
    return () => { stopZoom(); stopExperiments(); };
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
    <h2>{strings.settings.display}</h2>
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

  <section class="card" id="settings-reading">
    <h2>{strings.settings.reading}</h2>
    <div class="switch-row faces-row">
      <span class="text">{strings.settings.font}<InfoTip topic={strings.settings.font} text={strings.settings.fontHint} /></span>
      <div class="faces" role="group" aria-label={strings.settings.font}>
        {#each faces as face (face.id)}
          <button type="button" class="face" style:font-family="var(--face-{face.id})" aria-pressed={font === face.id} data-testid="font-{face.id}" onclick={() => pickFont(face.id)}>
            <span class="face-name">{face.name}</span>
            <span class="face-sample">{strings.settings.fontSample}</span>
          </button>
        {/each}
      </div>
    </div>
    <div class="switch-row">
      <span class="text">{strings.settings.monoFont}</span>
      <div class="segmented monos" role="group" aria-label={strings.settings.monoFont}>
        {#each monos as option (option.id)}
          <button type="button" class:on={mono === option.id} style:font-family="var(--face-mono-{option.id})" aria-pressed={mono === option.id} data-testid="font-mono-{option.id}" onclick={() => pickMono(option.id)}>{option.name}</button>
        {/each}
      </div>
    </div>
    {#if zoomable}
      <div class="switch-row">
        <span class="text">{strings.settings.zoom}<InfoTip topic={strings.settings.zoom} text={strings.settings.zoomHint} /></span>
        <div class="segmented zoom" role="group" aria-label={strings.settings.zoom}>
          <button type="button" aria-label={strings.settings.zoomOut} title={strings.settings.zoomOut} disabled={zoom <= smallest} data-testid="zoom-out" onclick={() => zoomTo(stepZoom(wantedZoom(), -1))}><Minus size={14} strokeWidth={2} /></button>
          <button type="button" class="zoom-value" title={strings.settings.zoomReset} aria-label={strings.settings.zoomReset} data-testid="zoom-reset" onclick={() => zoomTo(ZOOM_DEFAULT)}>{percent(zoom * 100)}</button>
          <button type="button" aria-label={strings.settings.zoomIn} title={strings.settings.zoomIn} disabled={zoom >= largest} data-testid="zoom-in" onclick={() => zoomTo(stepZoom(wantedZoom(), 1))}><Plus size={14} strokeWidth={2} /></button>
        </div>
      </div>
      {#if zoomError}<p class="zoom-error" role="alert" data-testid="zoom-error">{zoomError}</p>{/if}
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
  /* The text font's choices are tiles, each drawn in the face it picks, so the
     choice is made by reading rather than by name. */
  :global(.settings .page) .faces-row { flex-direction: column; align-items: stretch; gap: 12px; }
  .faces { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
  .face {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    height: auto;
    min-height: 0;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    color: var(--color-foreground);
    text-align: left;
    white-space: normal;
  }
  .face:hover:not([aria-pressed='true']) { background: var(--color-surface-3); }
  .face[aria-pressed='true'] { border-color: var(--color-foreground); box-shadow: inset 0 0 0 1px var(--color-foreground); }
  .face-name { font-size: var(--text-sm); font-weight: 600; }
  .face-sample { font-size: var(--text-base); line-height: 1.45; color: var(--color-muted-foreground); }
  .zoom button { display: inline-flex; align-items: center; justify-content: center; padding: 0 8px; }
  .zoom-error { margin: 0; color: var(--color-danger); font-size: var(--text-xs); overflow-wrap: anywhere; }
  .zoom .zoom-value { min-width: 56px; font-variant-numeric: tabular-nums; color: var(--color-foreground); }
  .accent-controls { display: grid; gap: 10px; min-width: 220px; }
  .swatches { display: flex; gap: 7px; }
  .swatch { width: 26px; height: 26px; padding: 0; border-radius: 50%; background: var(--color-accent); border: 3px solid var(--color-surface-2); transition: transform var(--dur-2) var(--ease-out-quint); }
  .swatch:hover { transform: scale(1.12); }
  .swatch[aria-pressed='true'] { outline: 2px solid var(--color-foreground); outline-offset: 2px; }
  .hue { appearance: none; width: 100%; min-height: 0; height: 8px; padding: 0; background: var(--accent-spectrum); border: none; border-radius: 999px; cursor: pointer; }
  .hue::-webkit-slider-thumb { appearance: none; width: 16px; height: 16px; background: var(--color-foreground); border: 2px solid var(--color-surface-2); border-radius: 50%; box-shadow: var(--shadow-e1); }
  .hue::-moz-range-thumb { width: 14px; height: 14px; background: var(--color-foreground); border: 2px solid var(--color-surface-2); border-radius: 50%; }
  /* Scoped under the page so it outranks the shared row, which centres its children.
     On a phone a label sits above its choices: side by side, a French label was
     squeezed to one word a line and ran under the three-option control. */
  @media (max-width: 720px) {
    :global(.settings .page) .accent-row,
    :global(.settings .page) .switch-row:has(.segmented) { flex-direction: column; align-items: stretch; }
    :global(.settings .page) .segmented { display: flex; }
    .faces { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .segmented button { flex: 1; min-width: 0; }
    /* A code face runs wide: each name takes the room it needs, a step smaller. */
    .monos button { flex: 1 1 auto; min-width: auto; padding: 0 6px; font-size: var(--text-xs); }
    /* A 26 px dot keeps its look and gets a finger-sized hit box. */
    .swatches { flex-wrap: wrap; gap: 18px; padding: 9px; margin: 0 -9px -9px; }
    .swatch { position: relative; }
    .swatch::before { content: ''; position: absolute; inset: -12px; border-radius: 50%; }
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
