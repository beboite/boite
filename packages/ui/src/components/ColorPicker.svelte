<script lang="ts">
  import { untrack } from 'svelte';
  import { hexToHsv, hsvToHex, normalizeHex } from '../lib/color-math';
  import { fill, strings } from '../lib/strings';

  let { value, label, onchange }: { value: string; label: string; onchange: (value: string) => void } = $props();
  let rememberedHue = $state(untrack(() => hexToHsv(value).h));
  let hsv = $derived(hexToHsv(value));
  let hue = $derived(hsv.s > 0 ? hsv.h : rememberedHue);
  let invalid = $state(false);
  let dragging = false;
  const uid = $props.id();

  function change(h: number, s: number, v: number) {
    rememberedHue = h;
    invalid = false;
    onchange(hsvToHex(h, s, v));
  }
  function point(event: PointerEvent) {
    const r = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null;
    if (!r) return;
    change(hue, Math.max(0, Math.min(100, (event.clientX - r.left) / r.width * 100)), Math.max(0, Math.min(100, 100 - (event.clientY - r.top) / r.height * 100)));
  }
  function start(event: PointerEvent) {
    if (event.button !== 0) return;
    dragging = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    point(event);
  }
  function onkey(event: KeyboardEvent) {
    const step = event.shiftKey ? 10 : 1;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowDown: [0, -step], ArrowUp: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    change(hue, Math.max(0, Math.min(100, hsv.s + delta[0]!)), Math.max(0, Math.min(100, hsv.v + delta[1]!)));
  }
  function hexInput(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const parsed = normalizeHex(input.value);
    invalid = !parsed;
    // Three digits are accepted on blur, so typing six digits never jumps midway.
    if (parsed && /^#?[\da-f]{6}$/i.test(input.value.trim())) onchange(parsed);
  }
  function hexBlur(event: FocusEvent) {
    const input = event.currentTarget as HTMLInputElement;
    const parsed = normalizeHex(input.value);
    invalid = !parsed;
    if (parsed) { onchange(parsed); input.value = parsed.toUpperCase(); }
  }
</script>

<div class="picker" data-testid="color-picker">
  <div class="plane" role="slider" tabindex="0" aria-label={fill(strings.settings.colors.field, { color: label })} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(hsv.s)} aria-valuetext={fill(strings.settings.colors.coordinates, { saturation: String(Math.round(hsv.s)), brightness: String(Math.round(hsv.v)) })} style:--picker-hue={`hsl(${hue} 100% 50%)`} onpointerdown={start} onpointermove={event => { if (dragging) point(event); }} onpointerup={() => { dragging = false; }} onlostpointercapture={() => { dragging = false; }} onkeydown={onkey} data-testid="color-plane">
    <span class="cursor" style:left={`${hsv.s}%`} style:top={`${100 - hsv.v}%`}></span>
  </div>
  <div class="hue-row">
    <label for="{uid}-hue">{strings.settings.colors.hue}</label>
    <input id="{uid}-hue" class="hue" type="range" min="0" max="359" step="1" value={Math.round(hue)} oninput={event => change(Number(event.currentTarget.value), hsv.s, hsv.v)} data-testid="color-hue" />
  </div>
  <div class="hex-row">
    <label for="{uid}-hex">{strings.settings.colors.hex}</label>
    <input id="{uid}-hex" class="hex" type="text" value={value.toUpperCase()} spellcheck="false" autocapitalize="off" maxlength="7" aria-invalid={invalid} aria-describedby={invalid ? `${uid}-error` : undefined} oninput={hexInput} onblur={hexBlur} data-testid="color-hex" />
    <span class="sample" style:background={value} aria-hidden="true"></span>
  </div>
  {#if invalid}<p class="error" id="{uid}-error" role="status">{strings.settings.colors.invalidHex}</p>{/if}
</div>

<style>
  .picker { display: grid; gap: 12px; min-width: 0; }
  .plane { position: relative; height: 126px; border-radius: var(--radius-md); background: linear-gradient(to top, var(--picker-black), transparent), linear-gradient(to right, var(--picker-white), transparent), var(--picker-hue); touch-action: none; cursor: crosshair; border: 1px solid var(--color-edge); }
  .cursor { position: absolute; width: 12px; height: 12px; border: 2px solid var(--picker-white); box-shadow: 0 0 0 1px var(--picker-black); border-radius: 50%; transform: translate(-50%, -50%); pointer-events: none; }
  .hue-row, .hex-row { display: flex; align-items: center; gap: 12px; }
  label { flex: none; width: 44px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .hue { appearance: none; flex: 1; min-width: 0; min-height: 0; height: 10px; padding: 0; border: none; border-radius: var(--radius-lg); background: var(--picker-hues); cursor: pointer; }
  .hue::-webkit-slider-thumb { appearance: none; width: 16px; height: 16px; background: var(--color-foreground); border: 2px solid var(--color-background); border-radius: 50%; }
  .hue::-moz-range-thumb { width: 12px; height: 12px; background: var(--color-foreground); border: 2px solid var(--color-background); border-radius: 50%; }
  .hex { min-width: 0; width: 100%; font-family: var(--font-mono); font-size: var(--text-sm); }
  .sample { width: var(--control); height: var(--control); flex: none; border-radius: var(--radius-sm); border: 1px solid var(--color-edge); }
  .error { color: var(--color-danger); font-size: var(--text-sm); }
  @media (max-width: 720px) { .hue-row { min-height: var(--touch-target); } .hue { height: 14px; } }
</style>
