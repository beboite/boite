<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { ArrowUp, Check, RotateCcw, SlidersHorizontal } from '@lucide/svelte';
  import { ACCENT_PRESETS, readAccent, setAccent } from '../lib/accent';
  import { accentHex, contrast, editPalette, paletteTokens, improvePaletteContrast, type ColorRole, type Palette } from '../lib/color-math';
  import { setTheme } from '../lib/theme';
  import { colorMode, COLORS_EVENT, hasCustomColors, PALETTES, presetPalette, readPalette, resetColors, setPalette, type ColorMode, type PaletteId } from '../lib/theme-colors';
  import { fill, strings } from '../lib/strings';
  import { tenth } from '../lib/format';
  import ColorPicker from './ColorPicker.svelte';
  import InfoTip from './InfoTip.svelte';
  import DiffView from './DiffView.svelte';

  let mode = $state<ColorMode>(untrack(colorMode));
  let palette = $state<Palette>(untrack(() => readPalette(mode)));
  let custom = $state(untrack(() => hasCustomColors(mode)));
  let accent = $state(untrack(readAccent));
  let role = $state<ColorRole>('accent');
  let undo = $state<Palette>();
  let editingRole: ColorRole | undefined;
  let customizing = $state(false);
  const editorId = $props.id();
  const roles: ColorRole[] = ['background', 'frame', 'surface', 'foreground', 'accent'];
  let presets = $derived.by(() => { accent; return PALETTES.map(id => { const palette = presetPalette(id, mode); return { id, palette, tokens: paletteTokens(palette) }; }); });
  let tokens = $derived(paletteTokens(palette));
  let grounds = $derived(['--color-background', '--color-frame', '--color-surface', '--color-surface-2', '--color-surface-3'].map(key => tokens[key]!));
  let ratio = $derived(Math.min(...grounds.map(ground => contrast(palette.foreground, ground))));
  let matching = $derived(presets.find(p => roles.every(key => p.palette[key] === palette[key]) && JSON.stringify(p.palette.details ?? {}) === JSON.stringify(palette.details ?? {}))?.id);
  let canUndo = $derived(!!undo && JSON.stringify(undo) !== JSON.stringify(palette));
  function follow() {
    const nextMode = colorMode();
    if (nextMode !== mode) { undo = undefined; editingRole = undefined; }
    mode = nextMode;
    palette = readPalette(mode);
    accent = readAccent();
    custom = hasCustomColors(mode);
  }
  onMount(() => {
    window.addEventListener(COLORS_EVENT, follow);
    return () => window.removeEventListener(COLORS_EVENT, follow);
  });
  function pick(id: PaletteId) {
    if (id === 'oled') { setTheme('dark'); follow(); }
    editingRole = undefined;
    undo = { ...palette };
    if (id === 'default') resetColors(mode);
    else setPalette(mode, presetPalette(id, mode));
  }
  function select(next: ColorRole) { customizing = true; if (role !== next) editingRole = undefined; role = next; }
  function edit(value: string) {
    if (editingRole !== role) { undo = { ...palette }; editingRole = role; }
    setPalette(mode, editPalette(palette, role, value));
  }
  function reset() { editingRole = undefined; undo = { ...palette }; resetColors(mode); }
  function undoEdit() {
    if (!undo) return;
    const previous = undo;
    editingRole = undefined;
    undo = { ...palette };
    setPalette(mode, previous);
  }
  function improveContrast() {
    editingRole = undefined;
    undo = { ...palette };
    setPalette(mode, improvePaletteContrast(palette));
  }
  function pickAccent(hue: number) { editingRole = undefined; undo = { ...palette }; setAccent(hue); follow(); }
</script>

<div class="colors" data-testid="theme-colors">
  <div class="heading">
    <h3>{strings.settings.colors.title}<InfoTip topic={strings.settings.colors.title} text={strings.settings.colors.hint} /></h3>
    <div class="actions">
      <button type="button" class="small ghost" disabled={!canUndo} onclick={undoEdit} data-testid="colors-undo">{strings.settings.colors.undo}</button>
      <button type="button" class="small ghost" disabled={!custom} onclick={reset} data-testid="colors-reset"><RotateCcw size={13} />{strings.settings.colors.reset}</button>
    </div>
  </div>
  <div class="presets" role="group" aria-label={strings.settings.colors.palette}>
    {#each presets.filter(preset => preset.id !== 'default') as preset (preset.id)}
      <button type="button" class="preset" aria-pressed={matching === preset.id} onclick={() => pick(preset.id)} data-testid="palette-{preset.id}" style:--preview-ground={preset.palette.background} style:--preview-frame={preset.palette.frame} style:--preview-surface={preset.palette.surface} style:--preview-text={preset.palette.foreground} style:--preview-accent={preset.palette.accent} style:--preview-active={preset.tokens['--color-active']} style:--preview-code={preset.tokens['--color-code-background']} style:--preview-success={preset.tokens['--color-success']} style:--preview-danger={preset.tokens['--color-danger']}>
        <span class="mini" aria-hidden="true">
          <span class="mini-rail"><span class="mini-project"></span><span class="mini-thread"></span><span class="mini-thread active"></span><span class="mini-thread"></span></span>
          <span class="mini-page"><span class="mini-line title"></span><span class="mini-bubble"></span><span class="mini-line short"></span><span class="mini-code"><span class="mini-deletion"></span><span class="mini-addition"></span></span><span class="mini-input"><span></span></span></span>
        </span>
        <span class="preset-name">{strings.settings.colors.palettes[preset.id]}{#if matching === preset.id}<Check size={14} />{/if}</span>
        <span class="preset-description">{strings.settings.colors.descriptions[preset.id]}{#if preset.id === 'oled'} · {strings.settings.themeDark}{/if}</span>
      </button>
    {/each}
  </div>
  <div class="selection">
    <div><span class="selection-name">{matching ? strings.settings.colors.palettes[matching] : strings.settings.colors.custom}</span><span class="selection-description">{matching ? strings.settings.colors.descriptions[matching] : strings.settings.colors.customHint}</span></div>
    <button type="button" class="ghost small customize" aria-expanded={customizing} aria-controls={editorId} onclick={() => { customizing = !customizing; }} data-testid="colors-customize"><SlidersHorizontal size={14} />{strings.settings.colors.customize}</button>
  </div>
  <div class="editor" class:customizing id={editorId}>
    {#if customizing}
    <div class="role-list" role="group" aria-label={strings.settings.colors.edit}>
      {#each roles as key (key)}
        <button type="button" class="role" aria-pressed={role === key} onclick={() => select(key)} data-testid="color-{key}">
          <span class="dot" style:background={palette[key]}></span>
          <span class="role-name">{strings.settings.colors.roles[key]}<span class="value">{palette[key].toUpperCase()}</span></span>
          {#if role === key}<span class="selected" aria-hidden="true"></span>{/if}
        </button>
      {/each}
      <div class="swatches" role="group" aria-label={strings.settings.accent}>
        {#each ACCENT_PRESETS as hue, index (hue)}
          <button type="button" class="swatch" data-accent-swatch style:background={`oklch(68% 0.19 ${hue})`} aria-label={strings.settings.accentNames[index]} aria-pressed={palette.accent === accentHex(hue)} data-testid="accent-{hue}" onclick={() => pickAccent(hue)}></button>
        {/each}
      </div>
    </div>
    {/if}
    <div class="right">
      <div class="preview" aria-label={strings.settings.colors.preview} data-testid="theme-preview">
        <button type="button" class="preview-rail" aria-label={strings.settings.colors.roles.frame} onclick={() => select('frame')}><span class="rail-dot"></span><span></span><span></span><span></span></button>
        <div class="preview-chat">
          <button type="button" class="preview-title" onclick={() => select('foreground')}>{strings.settings.colors.previewTitle}</button>
          <button type="button" class="preview-bubble" onclick={() => select('surface')}>{strings.settings.colors.previewPrompt}</button>
          <button type="button" class="preview-answer" onclick={() => select('foreground')}>{strings.settings.colors.previewAnswer}</button>
          <div class="preview-diff"><DiffView path={strings.settings.colors.previewFile} oldText={strings.settings.colors.previewBefore} newText={strings.settings.colors.previewAfter} headless /></div>
          <button type="button" class="preview-composer" onclick={() => select('accent')}><span>{strings.settings.colors.previewMessage}</span><span class="preview-send"><ArrowUp size={14} /></span></button>
        </div>
      </div>
      {#if customizing}
        <div class="picker-heading"><span>{strings.settings.colors.roles[role]}</span><InfoTip topic={strings.settings.colors.roles[role]} text={strings.settings.colors.pickerHint} /></div>
        {#key role}<ColorPicker value={palette[role]} label={strings.settings.colors.roles[role]} onchange={edit} />{/key}
      {/if}
    </div>
  </div>
  <div class="contrast" class:low={ratio < 4.5} data-testid="theme-contrast">
    <span>{fill(ratio >= 4.5 ? strings.settings.colors.contrastGood : strings.settings.colors.contrastLow, { ratio: tenth(ratio) })}<InfoTip topic={strings.settings.colors.contrast} text={strings.settings.colors.contrastHint} /></span>
    {#if ratio < 4.5}<button type="button" class="small" onclick={improveContrast} data-testid="colors-contrast-fix">{strings.settings.colors.improveContrast}</button>{/if}
    <span class="mode">{mode === 'light' ? strings.settings.colors.editingLight : strings.settings.colors.editingDark}</span>
  </div>
</div>

<style>
  .colors { padding: 20px 0; border-bottom: 1px solid var(--color-border); }
  .heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
  h3 { display: flex; align-items: center; gap: 4px; font-size: var(--text-base); }
  .actions { display: flex; gap: 4px; }
  .actions button { display: inline-flex; align-items: center; gap: 6px; }
  .presets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
  .preset { display: flex; flex-direction: column; padding: 7px; gap: 6px; height: auto; border: 1px solid var(--color-border); background: transparent; border-radius: var(--radius-lg); min-width: 0; text-align: left; color: var(--color-foreground); }
  .preset:hover { border-color: var(--color-edge); }
  .preset[aria-pressed='true'] { border-color: var(--color-accent); color: var(--color-foreground); box-shadow: inset 0 0 0 1px var(--color-accent); }
  .mini { display: flex; width: 100%; height: 104px; border-radius: var(--radius-md); overflow: hidden; background: var(--preview-frame); padding: 6px; gap: 6px; }
  .mini-rail { display: flex; flex-direction: column; gap: 5px; width: 23%; flex: none; padding-top: 8px; }
  .mini-project { width: 58%; height: 4px; margin: 0 4px 3px; background: var(--preview-text); opacity: .5; border-radius: var(--radius-sm); }
  .mini-thread { height: 9px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--preview-text) 9%, transparent); }
  .mini-thread.active { background: var(--preview-active); border-left: 2px solid var(--preview-accent); }
  .mini-page { display: flex; flex-direction: column; min-width: 0; gap: 6px; flex: 1; padding: 9px; background: var(--preview-ground); border-radius: var(--radius-sm); }
  .mini-line { height: 3px; width: 68%; background: var(--preview-text); opacity: .65; border-radius: var(--radius-sm); }
  .mini-line.short { width: 75%; opacity: .4; }
  .mini-line.title { width: 44%; margin-bottom: 3px; opacity: .9; }
  .mini-bubble { align-self: end; width: 68%; height: 11px; background: var(--preview-surface); border-radius: var(--radius-sm); }
  .mini-code { display: flex; flex-direction: column; gap: 4px; background: var(--preview-code); padding: 6px; border-radius: var(--radius-sm); }
  .mini-code span { height: 3px; width: 75%; border-radius: var(--radius-sm); }
  .mini-deletion { background: var(--preview-danger); opacity: .65; }
  .mini-addition { background: var(--preview-success); }
  .mini-input { margin-top: auto; height: 12px; background: var(--preview-surface); display: flex; justify-content: end; padding: 3px; border-radius: var(--radius-sm); }
  .mini-input span { width: 7px; background: var(--preview-accent); border-radius: var(--radius-sm); }
  .preset-name { display: flex; justify-content: space-between; align-items: center; gap: 4px; width: 100%; padding: 2px 4px 0; font-size: var(--text-base); font-weight: 550; white-space: normal; }
  .preset-description { color: var(--color-muted-foreground); font-size: var(--text-xs); padding: 0 4px 4px; line-height: 1.4; white-space: normal; }
  .selection { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
  .selection > div { display: grid; gap: 4px; }
  .selection-name { font-size: var(--text-base); font-weight: 550; }
  .selection-description { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .customize { display: inline-flex; align-items: center; gap: 7px; flex: none; }
  .editor { display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .editor.customizing { grid-template-columns: minmax(150px, .8fr) minmax(0, 1.6fr); }
  .role-list { display: flex; flex-direction: column; gap: 5px; }
  .role { display: flex; align-items: center; gap: 10px; height: auto; min-height: 50px; padding: 8px 10px; border-radius: var(--radius-md); border: 1px solid transparent; background: transparent; text-align: left; }
  .role:hover { background: var(--color-hover); }
  .role[aria-pressed='true'] { background: var(--color-surface-2); border-color: var(--color-edge); }
  .dot { height: 26px; width: 26px; flex: none; border-radius: var(--radius-sm); border: 1px solid var(--color-edge); }
  .role-name { flex: 1; display: grid; gap: 2px; font-size: var(--text-sm); white-space: normal; }
  .value { color: var(--color-muted-foreground); font-size: var(--text-xs); font-family: var(--font-mono); }
  .selected { width: 5px; height: 5px; border-radius: 50%; background: var(--color-accent); }
  .right { display: grid; gap: 12px; min-width: 0; }
  .preview { display: flex; min-height: 170px; background: var(--color-frame); border: 1px solid var(--color-edge); padding: 7px; gap: 8px; border-radius: var(--radius-lg); }
  .preview-rail { display: flex; flex-direction: column; justify-content: start; align-items: start; gap: 10px; width: 34px; height: auto; padding: 9px 2px; background: transparent; border: none; }
  .preview-rail span { width: 22px; height: 4px; border-radius: var(--radius-sm); background: var(--color-muted-foreground); opacity: .4; }
  .preview-rail .rail-dot { width: 14px; height: 14px; border-radius: var(--radius-sm); opacity: .8; }
  .preview-chat { display: flex; flex-direction: column; align-items: start; gap: 10px; flex: 1; min-width: 0; padding: 10px 12px; background: var(--color-background); border-radius: var(--radius-md); }
  .preview-chat button { height: auto; min-height: 0; padding: 0; border: none; background: transparent; white-space: normal; font-size: var(--text-sm); text-align: left; }
  .preview-chat .preview-title { font-weight: 600; color: var(--color-foreground); }
  .preview-chat .preview-bubble { align-self: end; border-radius: var(--radius-md); background: var(--color-surface-2); padding: 5px 9px; color: var(--color-foreground); }
  .preview-answer { color: var(--color-muted-foreground); }
  .preview-diff { width: 100%; min-width: 0; }
  .preview-chat .preview-composer { display: flex; width: 100%; align-items: center; gap: 8px; justify-content: space-between; background: var(--color-surface-2); border: 1px solid var(--color-border); padding: 6px; border-radius: var(--radius-md); color: var(--color-subtle); margin-top: auto; }
  .preview-send { display: flex; padding: 3px; background: var(--color-accent); color: var(--color-accent-ink); border-radius: var(--radius-sm); }
  .picker-heading { display: flex; align-items: center; font-weight: 500; font-size: var(--text-sm); }
  .swatches { display: flex; flex-wrap: wrap; gap: 6px; padding: 14px 10px 0; }
  .swatch { width: 22px; height: 22px; min-height: 0; padding: 0; border-radius: 50%; border: 2px solid var(--color-surface); }
  .swatch[aria-pressed='true'] { outline: 2px solid var(--color-foreground); outline-offset: 2px; }
  .contrast { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 18px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .contrast.low > span:first-child { color: var(--color-danger); }
  .contrast > span:first-child { display: flex; align-items: center; }
  .mode { margin-left: auto; color: var(--color-subtle); }
  @media (max-width: 720px) {
    .presets { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .mini { height: 88px; padding: 5px; gap: 4px; }
    .mini-page { padding: 7px; gap: 4px; }
    .preset-description { min-height: 34px; }
    .editor, .editor.customizing { grid-template-columns: minmax(0, 1fr); gap: 16px; }
    .selection { align-items: start; flex-direction: column; }
    .customize { min-height: var(--touch-target); }
    .preview-rail { width: var(--touch-target); min-width: var(--touch-target); }
    .preview-chat button { min-height: var(--touch-target); }
    .role-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .role { gap: 8px; padding: 6px; }
    .swatches { grid-column: 1 / -1; gap: 16px; padding: 12px 8px; }
    .swatch { width: var(--touch-target); height: var(--touch-target); }
    .contrast .mode { margin-left: 0; flex-basis: 100%; }
    .actions button { min-height: var(--touch-target); }
  }
</style>
