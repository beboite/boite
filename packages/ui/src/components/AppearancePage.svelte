<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { Minus, Plus } from '@lucide/svelte';
  import { onMount, untrack } from 'svelte';
  import { FONT_KEY, FONTS, MONO_KEY, MONOS, readFont, readMono, setFont, setMono, type Font, type Mono } from '../lib/fonts';
  import { percent } from '../lib/format';
  import { currentZoom, inShell, setZoom, stepZoom, subscribeZoom, wantedZoom, ZOOM_DEFAULT, ZOOM_STEPS } from '../lib/zoom';
  import { isExperimentEnabled, subscribeExperiments } from '../lib/experiments';
  import { effectiveGlass, hasMaterialChoice, readGlass, setGlass, supportedGlass, type Glass } from '../lib/glass';
  import { fill, LOCALES, localeSetting, setLocaleSetting, strings, type LocaleSetting } from '../lib/i18n.svelte';
  import { readTheme, setTheme, THEME_STORAGE_KEY, type Theme } from '../lib/theme';
  import { COLORS_EVENT } from '../lib/theme-colors';
  import { readChatWidth, setChatWidth, type ChatWidth } from '../lib/chat-width';
  import { readTerminalCursor, setTerminalCursor, type TerminalCursor } from '../lib/terminal-cursor';
  import { matchingPreset, work, type PanelStart, type Profile, type StartIn } from '../lib/work-prefs.svelte';
  import ThemeColors from './ThemeColors.svelte';
  import { controlGroups } from '../lib/control-groups';
  import type { Store } from '../lib/store.svelte';
  import SurfaceIcon from './SurfaceIcon.svelte';
  import { chatPrefs, setChatPref } from '../lib/chat-prefs.svelte';

  let { store }: { store: Store } = $props();
  const uid = $props.id();

  // The owner's buttons (the terminal, Add a project) are not a paired device's to hide.
  let groups = $derived(controlGroups(store.owner));
  let presets = $derived<{ id: Profile; label: string }[]>([
    { id: 'everyday', label: strings.controls.everyday },
    { id: 'developer', label: strings.controls.developer }
  ]);
  /** Lit while the buttons are exactly one preset's; a device that picked its own lights neither. */
  let preset = $derived(matchingPreset(work.current.hidden));

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

  let chatWidth = $state<ChatWidth>(untrack(() => readChatWidth()));
  let widths = $derived<{ id: ChatWidth; label: string }[]>([
    { id: 'comfortable', label: strings.settings.chatWidthComfortable },
    { id: 'wide', label: strings.settings.chatWidthWide },
    { id: 'full', label: strings.settings.chatWidthFull }
  ]);
  function pickChatWidth(next: ChatWidth) {
    chatWidth = next;
    setChatWidth(next);
  }

  let terminalCursor = $state<TerminalCursor>(untrack(() => readTerminalCursor()));
  let cursors = $derived<{ id: TerminalCursor; label: string }[]>([
    { id: 'bar', label: strings.settings.terminalCursorBar },
    { id: 'block', label: strings.settings.terminalCursorBlock },
    { id: 'underline', label: strings.settings.terminalCursorUnderline }
  ]);
  function pickTerminalCursor(next: TerminalCursor) {
    terminalCursor = next;
    setTerminalCursor(next);
  }

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
    // A face picked in another window restamps this one (`startFonts`); the buttons follow it.
    const followFaces = (event: StorageEvent) => {
      if (event.key === FONT_KEY) font = readFont();
      if (event.key === MONO_KEY) mono = readMono();
      if (event.key === THEME_STORAGE_KEY || event.key === null) theme = readTheme();
    };
    window.addEventListener('storage', followFaces);
    const followTheme = () => { theme = readTheme(); };
    window.addEventListener(COLORS_EVENT, followTheme);
    return () => { stopZoom(); stopExperiments(); window.removeEventListener('storage', followFaces); window.removeEventListener(COLORS_EVENT, followTheme); };
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
      <span class="text ui-label">{strings.settings.language}</span>
      <div class="segmented" role="group" aria-label={strings.settings.language}>
        <button type="button" class:on={locale === 'system'} aria-pressed={locale === 'system'} data-testid="locale-system" onclick={() => pickLocale('system')}>
          <span class="ui-label">{strings.settings.languageSystem}</span>
        </button>
        {#each LOCALES as id (id)}
          <button type="button" class:on={locale === id} aria-pressed={locale === id} data-testid="locale-{id}" onclick={() => pickLocale(id)}>
            <span class="ui-label">{strings.settings.languageNames[id]}</span>
          </button>
        {/each}
      </div>
    </div>
    <div class="switch-row">
      <span class="text ui-label">{strings.settings.theme}</span>
      <div class="segmented" role="group" aria-label={strings.settings.theme}>
        {#each themes as option (option.id)}
          <button
            type="button"
            class:on={theme === option.id}
            aria-pressed={theme === option.id}
            data-testid="theme-{option.id}"
            onclick={() => pickTheme(option.id)}
          >
            <span class="ui-label">{option.label}</span>
          </button>
        {/each}
      </div>
    </div>
    <ThemeColors />
    <div class="switch-row">
      <span class="text ui-label">{strings.settings.chatWidth}</span>
      <div class="segmented" role="group" aria-label={strings.settings.chatWidth}>
        {#each widths as option (option.id)}
          <button type="button" class:on={chatWidth === option.id} aria-pressed={chatWidth === option.id} data-testid="chat-width-{option.id}" onclick={() => pickChatWidth(option.id)}><span class="ui-label">{option.label}</span></button>
        {/each}
      </div>
    </div>
    <div class="switch-row">
      <span class="text ui-label">{strings.settings.terminalCursor}</span>
      <div class="segmented" role="group" aria-label={strings.settings.terminalCursor}>
        {#each cursors as option (option.id)}
          <button type="button" class:on={terminalCursor === option.id} aria-pressed={terminalCursor === option.id} data-testid="terminal-cursor-{option.id}" onclick={() => pickTerminalCursor(option.id)}><span class="ui-label">{option.label}</span></button>
        {/each}
      </div>
    </div>
    <label class="switch-row">
      <span class="text ui-label">{strings.settings.groupChanges}</span>
      <input type="checkbox" role="switch" checked={chatPrefs.groupChanges} data-testid="chat-group-changes" onchange={event => setChatPref('groupChanges', event.currentTarget.checked)} />
    </label>
    <label class="switch-row">
      <span class="text ui-label">{strings.settings.expandDiffs}</span>
      <input type="checkbox" role="switch" checked={chatPrefs.expandDiffs} data-testid="chat-expand-diffs" onchange={event => setChatPref('expandDiffs', event.currentTarget.checked)} />
    </label>
    {#if hasMaterial}
      <div class="switch-row">
        <span class="text ui-label">
          {strings.settings.material}
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
              <span class="ui-label">{option.label}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </section>

  <section class="card" id="settings-reading">
    <h2>{strings.settings.reading}</h2>
    <div class="switch-row faces-row">
      <span class="text ui-label">{strings.settings.font}</span>
      <div class="faces" role="group" aria-label={strings.settings.font}>
        {#each faces as face (face.id)}
          <button type="button" class="face" style:font-family="var(--face-{face.id})" aria-pressed={font === face.id} data-testid="font-{face.id}" onclick={() => pickFont(face.id)}>
            <span class="face-name ui-label">{face.name}</span>
            <span class="face-sample ui-label">{strings.settings.fontSample}</span>
          </button>
        {/each}
      </div>
    </div>
    <div class="switch-row">
      <span class="text ui-label">{strings.settings.monoFont}</span>
      <div class="segmented monos" role="group" aria-label={strings.settings.monoFont}>
        {#each monos as option (option.id)}
          <button type="button" class:on={mono === option.id} style:font-family="var(--face-mono-{option.id})" aria-pressed={mono === option.id} data-testid="font-mono-{option.id}" onclick={() => pickMono(option.id)}><span class="ui-label">{option.name}</span></button>
        {/each}
      </div>
    </div>
    {#if zoomable}
      <div class="switch-row">
        <span class="text ui-label-box"><span class="ui-label">{strings.settings.zoom}</span><InfoTip topic={strings.settings.zoom} text={strings.settings.zoomHint} /></span>
        <div class="segmented zoom" role="group" aria-label={strings.settings.zoom}>
          <button type="button" aria-label={strings.settings.zoomOut} title={strings.settings.zoomOut} disabled={zoom <= smallest} data-testid="zoom-out" onclick={() => zoomTo(stepZoom(wantedZoom(), -1))}><Minus size={14} strokeWidth={2} /></button>
          <button type="button" class="zoom-value" title={strings.settings.zoomReset} aria-label={strings.settings.zoomReset} data-testid="zoom-reset" onclick={() => zoomTo(ZOOM_DEFAULT)}><span class="ui-label">{percent(zoom * 100)}</span></button>
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
      <span class="text ui-label">{strings.settings.startIn}</span>
      <div class="segmented" role="group" aria-label={strings.settings.startIn}>
        {#each starts as option (option.id)}
          <button type="button" class:on={work.current.startIn === option.id} aria-pressed={work.current.startIn === option.id} data-testid="start-in-{option.id}" onclick={() => work.setStartIn(option.id)}><span class="ui-label">{option.label}</span></button>
        {/each}
      </div>
    </div>
    <div class="switch-row">
      <span class="text ui-label">{strings.settings.panelStart}</span>
      <div class="segmented" role="group" aria-label={strings.settings.panelStart}>
        {#each panels as option (option.id)}
          <button type="button" class:on={work.current.panel === option.id} aria-pressed={work.current.panel === option.id} data-testid="panel-start-{option.id}" onclick={() => work.setPanel(option.id)}><span class="ui-label">{option.label}</span></button>
        {/each}
      </div>
    </div>
  </section>

  <!-- Every optional button in one place, grouped by where it sits. A button's
       own right click hides it and leads here; this is the only way back. -->
  <section class="card" id="settings-buttons" data-testid="settings-buttons">
    <div class="card-head">
      <h2 class="ui-label-box"><span class="ui-label">{strings.controls.heading}</span><InfoTip topic={strings.controls.heading} text={strings.controls.headingHint} /></h2>
      <div class="segmented" role="group" aria-label={strings.controls.preset}>
        {#each presets as option (option.id)}
          <button type="button" class:on={preset === option.id} aria-pressed={preset === option.id} data-testid="controls-preset-{option.id}" onclick={() => work.showPreset(option.id)}><span class="ui-label">{option.label}</span></button>
        {/each}
      </div>
    </div>
    {#each groups as group (group.id)}
      <div class="control-group" role="group" aria-labelledby="{uid}-{group.id}">
        <p class="section-label" id="{uid}-{group.id}">{group.label}</p>
        <div class="toggles">
          {#each group.entries as entry (entry.id)}
            {@const shown = work.shows(entry.id)}
            <label class="toggle" class:off={!shown}>
              <span class="glyph" aria-hidden="true">
                {#if entry.kind}
                  <SurfaceIcon kind={entry.kind} size={15} />
                {:else if entry.icon}
                  {@const Icon = entry.icon}
                  <Icon size={15} strokeWidth={1.75} />
                {/if}
              </span>
              <span class="name ui-label">{entry.label}</span>
              <input type="checkbox" role="switch" checked={shown} data-testid="control-{entry.id}" onchange={(event) => work.show(entry.id, event.currentTarget.checked)} />
            </label>
          {/each}
        </div>
      </div>
    {/each}
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
  /* The title on the left, the presets on the right, the groups under them. */
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .card-head h2 { margin-bottom: 0; }
  .control-group + .control-group { margin-top: 20px; }
  .control-group .section-label { margin-bottom: 8px; }
  /* Each button as a tile that reads like the button itself: its icon and its
     name, dimmed while it is hidden, with the switch that brings it back. */
  .toggles { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 6px; }
  .toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 0 10px 0 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    color: var(--color-foreground);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-2), border-color var(--dur-2);
  }
  .toggle:hover { border-color: var(--color-edge); background: var(--color-surface-3); }
  .toggle .glyph { display: inline-flex; flex: none; color: var(--color-muted-foreground); transition: opacity var(--dur-2); }
  .toggle .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: opacity var(--dur-2); }
  .toggle.off .glyph, .toggle.off .name { opacity: 0.5; }
  .toggle.off { background: transparent; border-style: dashed; }
  /* Scoped under the page so it outranks the shared row, which centres its children.
     On a phone a label sits above its choices: side by side, a French label was
     squeezed to one word a line and ran under the three-option control. */
  @media (max-width: 720px) {
    :global(.settings .page) .switch-row:has(.segmented) { flex-direction: column; align-items: stretch; }
    :global(.settings .page) .segmented { display: flex; }
    .faces { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .segmented button { flex: 1; min-width: 0; }
    /* A code face runs wide: each name takes the room it needs, a step smaller. */
    .monos button { flex: 1 1 auto; min-width: auto; padding: 0 6px; font-size: var(--text-xs); }
    .card-head .segmented { flex: 1 1 100%; }
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
