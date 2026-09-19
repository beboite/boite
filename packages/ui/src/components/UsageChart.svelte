<script lang="ts">
  import { strings } from '../lib/strings';
  import { formatMetric, formatTick, niceScale, type UsageBucket, type UsageMetric } from '../lib/usage';

  type Serie = { key: string; color: string; label: string };
  let { buckets, series, metric, label, days }: { buckets: UsageBucket[]; series: Serie[]; metric: UsageMetric; label: string; days: number } = $props();

  const HEIGHT = 200;
  const TOP = 10;
  const BOTTOM = 24;
  /** The surface left between two stacked segments and between two columns. */
  const GAP = 2;
  const RADIUS = 4;

  let width = $state(0);
  let active = $state<number | null>(null);

  let scale = $derived(niceScale(Math.max(0, ...buckets.map((bucket) => bucket.total)), 4, metric === 'turns' ? 1 : 0));
  let tickLabels = $derived(scale.ticks.map((tick) => formatTick(metric, tick)));
  let left = $derived(Math.ceil(Math.max(...tickLabels.map((text) => text.length)) * 7 + 12));
  let plotWidth = $derived(Math.max(0, width - left));
  let plotHeight = HEIGHT - TOP - BOTTOM;
  let band = $derived(buckets.length === 0 ? 0 : plotWidth / buckets.length);
  let barWidth = $derived(Math.max(1, Math.min(28, band >= 8 ? band * 0.68 : band - (band >= 4 ? GAP : 1))));
  function y(value: number): number {
    return TOP + plotHeight - (value / scale.max) * plotHeight;
  }

  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const fullDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  /** An estimate of a label's width at the tick size, wide enough to keep two labels apart. */
  const CHAR = 6.5;
  /**
   * Labels counted back from today on a regular step. A label pinned to an edge
   * of the plot, or one longer than the step allows, is skipped rather than
   * drawn over its neighbour.
   */
  let xLabels = $derived.by(() => {
    if (buckets.length === 0 || plotWidth === 0) return [];
    const every = Math.max(1, Math.ceil(64 / band));
    const chosen: { index: number; text: string; x: number; anchor: 'start' | 'middle' | 'end' }[] = [];
    let limit = Infinity;
    for (let index = buckets.length - 1; index >= 0; index -= every) {
      const centre = left + band * (index + 0.5);
      const text = days <= 7 ? weekday.format(buckets[index]!.start) : dayMonth.format(buckets[index]!.start);
      const size = text.length * CHAR;
      const anchor = centre + size / 2 > left + plotWidth ? 'end' : centre - size / 2 < left ? 'start' : 'middle';
      const x = anchor === 'end' ? left + plotWidth : anchor === 'start' ? left : centre;
      const start = anchor === 'end' ? x - size : anchor === 'start' ? x : x - size / 2;
      if (start + size + 8 > limit) continue;
      chosen.push({ index, text, x, anchor });
      limit = start;
    }
    return chosen;
  });

  /** Each column's segments, bottom up, with the gap taken off the top of all but the last. */
  let columns = $derived(buckets.map((bucket, index) => {
    const x = left + band * index + (band - barWidth) / 2;
    const drawn = series.filter((serie) => (bucket.values[serie.key] ?? 0) > 0);
    let base = TOP + plotHeight;
    return drawn.map((serie, position) => {
      const height = ((bucket.values[serie.key] ?? 0) / scale.max) * plotHeight;
      const last = position === drawn.length - 1;
      const top = base - height;
      const shown = Math.max(1, last ? height : height - GAP);
      const segment = { key: serie.key, color: serie.color, x, y: base - shown, height: shown, last };
      base = top;
      return segment;
    });
  }));

  /** A column's top segment: square at the baseline side, rounded at the data end. */
  function roundedTop(x: number, top: number, w: number, h: number): string {
    const r = Math.min(RADIUS, w / 2, h);
    return `M${x},${top + h}V${top + r}A${r},${r} 0 0 1 ${x + r},${top}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${top + r}V${top + h}Z`;
  }

  function pointer(event: PointerEvent) {
    const box = (event.currentTarget as SVGElement).getBoundingClientRect();
    const index = Math.floor((event.clientX - box.left - left) / band);
    active = index >= 0 && index < buckets.length ? index : null;
  }

  function keydown(event: KeyboardEvent) {
    if (buckets.length === 0) return;
    const current = active ?? buckets.length - 1;
    const next =
      event.key === 'ArrowLeft' ? Math.max(0, current - 1)
      : event.key === 'ArrowRight' ? Math.min(buckets.length - 1, current + 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? buckets.length - 1
      : null;
    if (event.key === 'Escape') { active = null; return; }
    if (next === null) return;
    event.preventDefault();
    active = next;
  }

  let tip = $derived(active === null ? null : buckets[active] ?? null);
  /** What a screen reader says for the day under the keyboard: the same lines as the tooltip. */
  let valueText = $derived.by(() => {
    const bucket = buckets[active ?? buckets.length - 1];
    if (bucket === undefined) return '';
    const lines = [...series].reverse().map((serie) => `${serie.label} ${formatMetric(metric, bucket.values[serie.key] ?? 0)}`);
    return `${fullDay.format(bucket.start)}: ${strings.usage.total} ${formatMetric(metric, bucket.total)}, ${lines.join(', ')}`;
  });
  let tipWidth = $state(0);
  /** Beside the column, on whichever side has room, never past the chart's edges. */
  let tipX = $derived.by(() => {
    if (active === null) return 0;
    const centre = left + band * (active + 0.5);
    const after = centre + 12;
    const before = centre - 12 - tipWidth;
    if (after + tipWidth <= width) return after;
    if (before >= 0) return before;
    return Math.max(0, width - tipWidth);
  });
</script>

<!-- A slider over the days: the arrow keys move it, and each stop reads that day's column. -->
<div
  class="chart"
  role="slider"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={Math.max(0, buckets.length - 1)}
  aria-valuenow={active ?? Math.max(0, buckets.length - 1)}
  aria-valuetext={valueText}
  tabindex="0"
  bind:clientWidth={width}
  onkeydown={keydown}
  onfocus={() => { if (active === null && buckets.length > 0) active = buckets.length - 1; }}
  onblur={() => { active = null; }}
  data-testid="usage-chart"
>
  {#if width > 0}
    <svg width={width} height={HEIGHT} aria-hidden="true" onpointermove={pointer} onpointerdown={pointer} onpointerleave={() => { active = null; }}>
      {#each scale.ticks as tick, index (tick)}
        <line class="grid" class:base={index === 0} x1={left} x2={left + plotWidth} y1={Math.round(y(tick)) + 0.5} y2={Math.round(y(tick)) + 0.5} />
        <text class="tick" x={left - 8} y={y(tick)} text-anchor="end" dominant-baseline="middle">{tickLabels[index]}</text>
      {/each}
      {#if active !== null}
        <rect class="band" x={left + band * active} y={TOP} width={band} height={plotHeight} rx={Math.min(4, band / 4)} />
      {/if}
      {#each columns as column, index (buckets[index]!.start)}
        <g class:dim={active !== null && active !== index}>
          {#each column as segment (segment.key)}
            {#if segment.last}
              <path d={roundedTop(segment.x, segment.y, barWidth, segment.height)} style:fill={segment.color} />
            {:else}
              <rect x={segment.x} y={segment.y} width={barWidth} height={segment.height} style:fill={segment.color} />
            {/if}
          {/each}
        </g>
      {/each}
      {#each xLabels as entry (entry.index)}
        <text class="tick" x={entry.x} y={HEIGHT - 6} text-anchor={entry.anchor}>{entry.text}</text>
      {/each}
    </svg>
  {/if}
  {#if tip}
    <div class="tooltip" style:left="{tipX}px" bind:clientWidth={tipWidth} aria-hidden="true" data-testid="usage-tooltip">
      <strong>{fullDay.format(tip.start)}</strong>
      <ul>
        {#each [...series].reverse() as serie (serie.key)}
          <li class:zero={(tip.values[serie.key] ?? 0) === 0}>
            <span class="key" style:background={serie.color}></span>
            <span class="value">{formatMetric(metric, tip.values[serie.key] ?? 0)}</span>
            <span class="name">{serie.label}</span>
          </li>
        {/each}
        <li class="sum"><span class="key"></span><span class="value">{formatMetric(metric, tip.total)}</span><span class="name">{strings.usage.total}</span></li>
      </ul>
    </div>
  {/if}
</div>

<style>
  .chart { position: relative; height: 200px; outline: none; border-radius: var(--radius-md); touch-action: pan-y; }
  .chart:focus-visible { box-shadow: 0 0 0 2px var(--color-edge); }
  svg { display: block; overflow: visible; }
  .grid { stroke: var(--color-border); stroke-width: 1; }
  .grid.base { stroke: var(--color-edge); }
  .tick { fill: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .band { fill: var(--color-hover); }
  g { transition: opacity var(--dur-1) var(--ease-out-quint); }
  g.dim { opacity: 0.45; }
  .tooltip {
    position: absolute;
    top: 0;
    z-index: 2;
    min-width: 168px;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    box-shadow: var(--shadow-e2);
    font-size: var(--text-sm);
    pointer-events: none;
    animation: fade var(--dur-1) var(--ease-out-quint);
  }
  .tooltip strong { display: block; margin-bottom: 6px; font-weight: 600; }
  ul { display: grid; gap: 3px; margin: 0; padding: 0; list-style: none; }
  li { display: grid; grid-template-columns: 12px auto 1fr; align-items: center; gap: 8px; }
  li.zero { color: var(--color-subtle); }
  .key { width: 12px; height: 3px; border-radius: 2px; }
  .value { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; min-width: 52px; }
  li.zero .value { font-weight: 400; }
  .name { color: var(--color-muted-foreground); white-space: nowrap; }
  .sum { margin-top: 3px; padding-top: 5px; border-top: 1px solid var(--color-border); }
</style>
