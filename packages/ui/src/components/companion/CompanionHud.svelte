<!--
  The HUD beside the character, in the manner of a "Dynamic Island": a pill
  with how many threads are at work, the newest one's title, its step and how
  long it has run, and a small gauge per subscription of the proxy, each beside
  its provider's mark. On hover it
  opens into a card listing every thread at work, a click opening one in Boite,
  and the quotas spelled out.

  Its size follows the content it measures, so the outline morphs between the
  two shapes; the page reads it again as a hit area once the morph settles.
-->
<script lang="ts">
  import { Gauge } from '@lucide/svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import { count } from '../../lib/companion/describe';
  import { hudThreads, type HudGauge } from '../../lib/companion/hud';
  import { inShell, type CompanionLayout } from '../../lib/companion/shell';
  import { elapsed } from '../../lib/format';
  import { page } from '../../lib/page-hidden.svelte';
  import { fill, strings } from '../../lib/strings';
  import ProviderLogo from '../ProviderLogo.svelte';

  interface Props {
    threads: ThreadSummary[];
    projects: Map<string, string>;
    /** The companion's own conversation, left out. */
    own: string | null;
    gauges: HudGauge[];
    /** The shell's word that the pointer is on the companion (`senses.hover`). */
    hover: boolean;
    reachable: boolean;
    layout: CompanionLayout;
    /** Whether the card is open, for the page to read its hit areas again. */
    expanded?: boolean;
    onopen: (threadId: string) => void;
    /** The outline settled on a new size. */
    onresize: () => void;
  }

  let { threads, projects, own, gauges, hover, reachable, layout, expanded = $bindable(false), onopen, onresize }: Props = $props();

  const copy = strings.companion.hud;
  /** Passing over the pill on the way to the character does not open it. */
  const OPEN_AFTER = 120;
  const CLOSE_AFTER = 250;

  const rows = $derived(hudThreads(threads, projects, own));
  const first = $derived(rows[0] ?? null);
  const shown = $derived(reachable && (rows.length > 0 || gauges.length > 0));

  let pointer = $state(false);
  let pinned = $state(false);
  let keyboard = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A click-through window does not see the pointer go: the shell's word wins.
  $effect(() => {
    if (inShell() && !hover) {
      clearTimeout(timer);
      pointer = false;
      pinned = false;
    }
  });

  $effect(() => {
    expanded = shown && (pointer || pinned || keyboard);
  });

  function enter() {
    clearTimeout(timer);
    timer = setTimeout(() => (pointer = true), OPEN_AFTER);
  }

  function leave() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      pointer = false;
      pinned = false;
    }, CLOSE_AFTER);
  }

  $effect(() => () => clearTimeout(timer));

  // The clock runs while a thread is shown and the page can be seen.
  let now = $state(Date.now());
  $effect(() => {
    if (!shown || rows.length === 0 || page.hidden) return;
    now = Date.now();
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });

  const since = (from: number | null) => (from === null ? '' : elapsed(now - from));
  const working = $derived(count(rows.length, strings.companion.threadsOne, strings.companion.threadsMany));
  const summary = $derived(first ? [working, first.title, first.step, since(first.since)].filter(Boolean).join(', ') : copy.quotas);

  let width = $state(0);
  let height = $state(0);
  $effect(() => {
    void [width, height];
    requestAnimationFrame(onresize);
  });

  const left = (gauge: HudGauge) => (gauge.used === null ? '—' : `${Math.round(100 - gauge.used)}%`);
</script>

{#if shown}
  <div
    class="island"
    class:expanded
    data-hit
    data-testid="companion-hud"
    data-align={layout.align}
    data-edge={layout.edge}
    role="region"
    aria-label={copy.label}
    style:width="{width}px"
    style:height="{height}px"
    onpointerenter={enter}
    onpointerleave={leave}
    onfocusin={(event) => (keyboard = (event.target as HTMLElement).matches(':focus-visible'))}
    onfocusout={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) keyboard = false;
    }}
    ontransitionend={(event) => {
      if (event.target === event.currentTarget) onresize();
    }}
  >
    <div class="content" bind:offsetWidth={width} bind:offsetHeight={height}>
      <div class="top">
        <button class="summary" aria-expanded={expanded} aria-label={summary} onclick={() => (pinned = !pinned)} data-testid="companion-hud-summary">
          {#if rows.length > 0}<span class="count" aria-hidden="true">{rows.length}</span>{:else}<span class="icon" aria-hidden="true"><Gauge size={14} /></span>{/if}
          {#if expanded}
            <span class="heading">{first ? working : copy.quotas}</span>
          {:else if first}
            <span class="lines">
              <span class="title">{first.title}</span>
              <span class="step"><span class="what">{first.step}</span><span class="time">{since(first.since)}</span></span>
            </span>
          {/if}
        </button>
        {#if !expanded && gauges.length > 0}
          <span class="gauges" role="group" aria-label={copy.quotas}>
            {#each gauges as gauge (gauge.id)}
              <span class="gauge" data-level={gauge.level} role="img" aria-label={gauge.label} title={gauge.label}>
                <ProviderLogo providerId={gauge.providerId} size={12} />
                <span class="level"><i style:height="{gauge.used === null ? 0 : 100 - gauge.used}%"></i></span>
              </span>
            {/each}
          </span>
        {/if}
      </div>

      {#if expanded}
        <div class="body">
          {#if rows.length > 0}
            <ul class="rows">
              {#each rows as row (row.id)}
                <li>
                  <button class="row" aria-label={fill(copy.openThread, { title: row.title })} onclick={() => onopen(row.id)} data-testid="companion-hud-row">
                    <span class="lines">
                      <span class="title">{row.title}</span>
                      <span class="step">{#if row.project}<span class="project">{row.project}</span>{/if}<span class="what">{row.step}</span></span>
                    </span>
                    {#if row.since !== null}<span class="time" title={fill(copy.since, { time: since(row.since) })}>{since(row.since)}</span>{/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if gauges.length > 0}
            <ul class="quotas" aria-label={copy.quotas}>
              {#each gauges as gauge (gauge.id)}
                <li class="quota" data-level={gauge.level}>
                  <span class="mark" aria-hidden="true"><ProviderLogo providerId={gauge.providerId} size={14} /></span>
                  <span class="name" title={gauge.window ? `${gauge.name} · ${gauge.window}` : gauge.name}>{gauge.name}</span>
                  <span class="bar" role="img" aria-label={gauge.label}><i style:width="{gauge.used === null ? 0 : 100 - gauge.used}%"></i></span>
                  <span class="left" aria-hidden="true">{left(gauge)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .island {
    position: relative;
    flex: none;
    box-sizing: content-box;
    border: 1px solid var(--color-border);
    border-radius: 22px;
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    overflow: hidden;
    font-size: var(--text-xs);
    transition:
      width var(--dur-3) var(--ease-out-quint),
      height var(--dur-3) var(--ease-out-quint),
      border-radius var(--dur-3) var(--ease-out-quint);
  }
  .island.expanded {
    border-radius: var(--radius-lg);
  }
  /* The content keeps its natural size and the outline follows it, from the
     side it is anchored on. */
  .content {
    position: absolute;
    top: 0;
    left: 0;
    width: max-content;
    max-width: 290px;
  }
  .expanded .content {
    width: 300px;
    max-width: none;
    animation: fade var(--dur-3) var(--ease-out-quint);
  }
  .island[data-align='right'] .content {
    left: auto;
    right: 0;
  }
  .island[data-align='center'] .content {
    left: 50%;
    transform: translateX(-50%);
  }
  .island[data-edge='bottom'] .content {
    top: auto;
    bottom: 0;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px 4px 4px;
  }
  .top:has(.summary:only-child) {
    padding-right: 4px;
  }
  .summary,
  .row {
    flex: 1;
    min-width: 0;
    height: auto;
    justify-content: flex-start;
    gap: 8px;
    padding: 2px 4px 2px 2px;
    border: none;
    border-radius: 18px;
    background: none;
    box-shadow: none;
    font-weight: 400;
    text-align: left;
  }
  .summary:hover:not(:disabled),
  .row:hover:not(:disabled) {
    background: var(--color-surface-2);
  }
  .summary:focus-visible,
  .row:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }
  .count {
    flex: none;
    display: grid;
    place-items: center;
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--color-accent);
    color: var(--color-accent-ink);
    font-weight: 600;
    animation: breathe 2.4s ease-in-out infinite;
  }
  .icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    color: var(--color-muted-foreground);
  }
  .heading {
    font-weight: 600;
  }
  .lines {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.3;
  }
  .title,
  .what,
  .project {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    font-weight: 600;
  }
  .step {
    display: flex;
    gap: 6px;
    min-width: 0;
    color: var(--color-muted-foreground);
  }
  .project {
    flex: none;
    max-width: 40%;
    color: var(--color-foreground);
  }
  .time {
    flex: none;
    color: var(--color-muted-foreground);
    font-variant-numeric: tabular-nums;
  }

  .gauges {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 20px;
  }
  /* The provider's mark beside its bar, so each gauge says whose quota it is. */
  .gauge {
    display: flex;
    align-items: center;
    gap: 3px;
    height: 100%;
  }
  .level {
    position: relative;
    width: 5px;
    height: 100%;
    border-radius: 2px;
    background: var(--color-surface-3);
    overflow: hidden;
  }
  .level i {
    position: absolute;
    inset: auto 0 0;
    border-radius: 2px;
  }
  [data-level] i {
    background: var(--color-success);
  }
  [data-level='warning'] i {
    background: var(--color-live);
  }
  [data-level='danger'] i {
    background: var(--color-danger);
  }
  [data-level='danger'] .left {
    color: var(--color-danger);
  }
  [data-level='unknown'] .left {
    color: var(--color-muted-foreground);
  }
  .gauge[data-level='danger'] .level {
    outline: 1px solid var(--color-danger);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 6px 8px;
  }
  .rows,
  .quotas {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    width: 100%;
    padding: 5px 8px;
    border-radius: var(--radius-md);
  }
  .row .lines {
    flex: 1;
  }
  .quotas {
    gap: 4px;
    padding: 6px 8px 0;
    border-top: 1px solid var(--color-border);
  }
  .quota {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr) 72px 36px;
    align-items: center;
    gap: 8px;
  }
  .mark {
    display: flex;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar {
    position: relative;
    height: 5px;
    border-radius: var(--radius-full);
    background: var(--color-surface-3);
    overflow: hidden;
  }
  .bar i {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: var(--radius-full);
  }
  .left {
    color: var(--color-muted-foreground);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes breathe {
    50% {
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 30%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .island,
    .expanded .content,
    .count {
      transition: none;
      animation: none;
    }
  }
</style>
