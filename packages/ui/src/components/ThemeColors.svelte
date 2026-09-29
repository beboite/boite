<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Check, RotateCcw, SlidersHorizontal } from '@lucide/svelte';
  import { ACCENT_PRESETS, readAccent, setAccent } from '../lib/accent';
  import { accentHex, contrast, editPalette, paletteTokens, improvePaletteContrast, type ColorRole, type Palette } from '../lib/color-math';
  import { setTheme } from '../lib/theme';
  import { colorMode, COLORS_EVENT, hasCustomColors, PALETTES, presetPalette, readPalette, resetColors, setPalette, type ColorMode, type PaletteId } from '../lib/theme-colors';
  import { fill, strings } from '../lib/strings';
  import { tenth } from '../lib/format';
  import ColorPicker from './ColorPicker.svelte';
  import InfoTip from './InfoTip.svelte';

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
  let presets = $derived.by(() => { accent; return PALETTES.map(id => ({ id, palette: presetPalette(id, mode) })); });
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
    {#each presets as preset (preset.id)}
      <button type="button" class="preset" aria-pressed={matching === preset.id} onclick={() => pick(preset.id)} data-testid="palette-{preset.id}">
        <span>{strings.settings.colors.palettes[preset.id]}</span>{#if matching === preset.id}<Check size={14} />{/if}
      </button>
    {/each}
  </div>
  <div class="selection">
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
    <div class="right">
      {#key role}<ColorPicker value={palette[role]} label={strings.settings.colors.roles[role]} onchange={edit} />{/key}
    </div>
    {/if}
  </div>
  {#if ratio < 4.5}
  <div class="contrast" data-testid="theme-contrast">
    <span>{fill(strings.settings.colors.contrastLow, { ratio: tenth(ratio) })}<InfoTip topic={strings.settings.colors.contrast} text={strings.settings.colors.contrastHint} /></span>
    <button type="button" class="small" onclick={improveContrast} data-testid="colors-contrast-fix">{strings.settings.colors.improveContrast}</button>
  </div>
  {/if}
</div>

<style>
  .colors { padding: 20px 0; border-bottom: 1px solid var(--color-border); }
  .heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
  h3 { display: flex; align-items: center; gap: 4px; font-size: var(--text-base); }
  .actions { display: flex; gap: 4px; }
  .actions button { display: inline-flex; align-items: center; gap: 6px; }
  .presets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
  .preset { display: flex; justify-content: space-between; align-items: center; padding: 0 10px; gap: 8px; height: var(--control); border: 1px solid var(--color-border); background: transparent; border-radius: var(--radius-md); min-width: 0; text-align: left; color: var(--color-foreground); font-size: var(--text-sm); }
  .preset:hover { border-color: var(--color-edge); }
  .preset[aria-pressed='true'] { border-color: var(--color-accent); color: var(--color-foreground); box-shadow: inset 0 0 0 1px var(--color-accent); }
  .selection { display: flex; }
  .customize { display: inline-flex; align-items: center; gap: 7px; flex: none; }
  .editor { display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .editor.customizing { grid-template-columns: minmax(150px, .8fr) minmax(0, 1.6fr); margin-top: 16px; }
  .role-list { display: flex; flex-direction: column; gap: 5px; }
  .role { display: flex; align-items: center; gap: 10px; height: auto; min-height: 50px; padding: 8px 10px; border-radius: var(--radius-md); border: 1px solid transparent; background: transparent; text-align: left; }
  .role:hover { background: var(--color-hover); }
  .role[aria-pressed='true'] { background: var(--color-surface-2); border-color: var(--color-edge); }
  .dot { height: 26px; width: 26px; flex: none; border-radius: var(--radius-sm); border: 1px solid var(--color-edge); }
  .role-name { flex: 1; display: grid; gap: 2px; font-size: var(--text-sm); white-space: normal; }
  .value { color: var(--color-muted-foreground); font-size: var(--text-xs); font-family: var(--font-mono); }
  .selected { width: 5px; height: 5px; border-radius: 50%; background: var(--color-accent); }
  .right { display: grid; gap: 12px; min-width: 0; }
  .swatches { display: flex; flex-wrap: wrap; gap: 6px; padding: 14px 10px 0; }
  .swatch { width: 22px; height: 22px; min-height: 0; padding: 0; border-radius: 50%; border: 2px solid var(--color-surface); }
  .swatch[aria-pressed='true'] { outline: 2px solid var(--color-foreground); outline-offset: 2px; }
  .contrast { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 18px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .contrast > span:first-child { color: var(--color-danger); }
  .contrast > span:first-child { display: flex; align-items: center; }
  @media (max-width: 720px) {
    .presets { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .preset { height: var(--touch-target); }
    .editor, .editor.customizing { grid-template-columns: minmax(0, 1fr); gap: 16px; }
    .customize { min-height: var(--touch-target); }
    .role-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .role { gap: 8px; padding: 6px; }
    .swatches { grid-column: 1 / -1; gap: 16px; padding: 12px 8px; }
    .swatch { width: var(--touch-target); height: var(--touch-target); }
    .actions button { min-height: var(--touch-target); }
  }
</style>
