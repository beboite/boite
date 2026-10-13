<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { glides } from '../lib/motion';

  /**
   * The dictation's spectrum: voice bands mirrored around the middle, the low
   * ones in the centre, drawn on a canvas so a frame costs no layout. `live`
   * reads the analyser the recorder hangs beside its recording path; `busy`
   * is a travelling wave while the microphone opens or the core transcribes;
   * `still` keeps the bars at rest. Frames stop with the component, and the
   * browser pauses them in a hidden window.
   */
  let { analyser = null, mode }: { analyser?: AnalyserNode | null; mode: 'live' | 'busy' | 'still' } = $props();

  const BAR = 3, GAP = 2;
  /** Speech lives between these two frequencies; the bands split them on a log scale. */
  const LOW = 90, HIGH = 5200;
  let canvas = $state<HTMLCanvasElement>();
  let frame = 0;
  let heights = new Float32Array(0);
  let bins: Uint8Array<ArrayBuffer> | null = null;
  let size = { width: 0, height: 0, ratio: 1 };
  let ink = '';
  let gone = false;
  /** Plain copies the frame loop reads: it keeps drawing while the tape rolls up, when the props are no longer live. */
  let source: AnalyserNode | null = null;
  let drawn: 'live' | 'busy' | 'still' = 'still';
  const motion = glides();

  function measure(): void {
    if (!canvas) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = canvas.clientWidth, height = canvas.clientHeight;
    size = { width, height, ratio };
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }

  /** One level per band, 0 to 1, from the analyser's latest frame. */
  function bands(count: number, into: Float32Array): void {
    if (!source) { into.fill(0); return; }
    if (bins?.length !== source.frequencyBinCount) bins = new Uint8Array(source.frequencyBinCount);
    source.getByteFrequencyData(bins);
    const hz = source.context.sampleRate / 2 / bins.length;
    for (let band = 0; band < count; band++) {
      const from = Math.max(1, Math.floor((LOW * (HIGH / LOW) ** (band / count)) / hz));
      const to = Math.max(from + 1, Math.ceil((LOW * (HIGH / LOW) ** ((band + 1) / count)) / hz));
      let sum = 0;
      for (let bin = from; bin < to && bin < bins.length; bin++) sum += bins[bin]!;
      // Higher bands carry less energy in speech: a gentle tilt keeps them visible.
      const level = (sum / (to - from) / 255) * (1 + band / count * 0.6);
      into[band] = Math.min(1, level ** 1.5);
    }
  }

  let levels = new Float32Array(0);
  function draw(time: number): void {
    frame = 0;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    if (canvas.clientWidth !== size.width || canvas.clientHeight !== size.height) measure();
    const { width, height, ratio } = size;
    const count = Math.max(5, Math.floor((width + GAP) / (BAR + GAP)));
    const half = Math.ceil(count / 2);
    if (heights.length !== count) heights = new Float32Array(count);
    if (levels.length !== half) levels = new Float32Array(half);
    if (drawn === 'live') bands(half, levels);
    else for (let band = 0; band < half; band++) levels[band] = drawn === 'busy' && motion ? 0.16 + 0.22 * (0.5 + 0.5 * Math.sin(time / 210 - band * 0.7)) : 0;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = ink || getComputedStyle(canvas).color;
    const left = (width - (count * BAR + (count - 1) * GAP)) / 2;
    const middle = (count - 1) / 2;
    for (let bar = 0; bar < count; bar++) {
      const away = Math.abs(bar - middle) / Math.max(1, middle);
      const target = levels[Math.min(half - 1, Math.round(away * (half - 1)))]!;
      const was = heights[bar]!;
      // Quick to rise, slower to fall, as a meter reads.
      const next = target > was ? was + (target - was) * 0.6 : was * 0.84 + target * 0.16;
      heights[bar] = next;
      const tall = Math.max(BAR, next * height);
      context.globalAlpha = 0.5 + 0.5 * (1 - away);
      const x = left + bar * (BAR + GAP), y = (height - tall) / 2;
      if (typeof context.roundRect === 'function') { context.beginPath(); context.roundRect(x, y, BAR, tall, BAR / 2); context.fill(); }
      else context.fillRect(x, y, BAR, tall);
    }
    context.globalAlpha = 1;
    if (drawn !== 'still' || heights.some(value => value > 0.01)) frame = requestAnimationFrame(draw);
  }

  function schedule(): void { if (!frame && !gone) frame = requestAnimationFrame(draw); }

  onMount(() => { measure(); schedule(); });
  // A new mode or analyser repaints in its colour; `still` lets the bars settle, then stops.
  $effect(() => {
    source = analyser; drawn = mode;
    ink = '';
    queueMicrotask(() => { if (canvas && !gone) ink = getComputedStyle(canvas).color; schedule(); });
  });
  onDestroy(() => { gone = true; if (frame) cancelAnimationFrame(frame); frame = 0; });
</script>

<canvas bind:this={canvas} class="spectrum {mode}" aria-hidden="true" data-testid="dictation-spectrum" data-mode={mode}></canvas>

<style>
  .spectrum { display: block; width: 100%; height: 100%; min-width: 0; color: var(--color-accent); }
  .spectrum.busy { color: var(--color-muted-foreground); }
  .spectrum.still { color: var(--color-muted-foreground); opacity: .7; }
</style>
