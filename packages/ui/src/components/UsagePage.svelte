<script lang="ts">
  import { untrack } from 'svelte';
  import { ChevronDown, RefreshCw } from '@lucide/svelte';
  import type { UsageHistory } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { formatLocale } from '../lib/i18n.svelte';
  import {
    dayEdges,
    formatMetric,
    modelName,
    reportedValue,
    seriesFor,
    summarize,
    topThreads,
    totalTokens,
    USAGE_METRICS,
    USAGE_RANGES,
    type UsageMetric,
    type UsageRange,
    type UsageTotals
  } from '../lib/usage';
  import InfoTip from './InfoTip.svelte';
  import Menu from './Menu.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import UsageChart from './UsageChart.svelte';

  let { store }: { store: Store } = $props();

  let range = $state<UsageRange>(30);
  let metric = $state<UsageMetric>('tokens');
  let breakdown = $state<'model' | 'day'>('model');
  let provider = $state<string | null>(null);
  let historicalProviders = $state<string[]>([]);
  let history = $state<UsageHistory | null>(null);
  let loading = $state(false);
  let failure = $state<string | null>(null);
  /** Only the newest request writes, so a slow 90-day answer never lands over a 7-day one. */
  let latest = 0;

  async function load(days: UsageRange, providerId = provider) {
    const client = store.client;
    if (!client) return;
    const request = ++latest;
    loading = true;
    failure = null;
    try {
      const result = await client.call('usage.history', { edges: dayEdges(days), ...(providerId === null ? {} : { providerId }) });
      if (request !== latest) return;
      history = result;
      historicalProviders = [...new Set([...historicalProviders, ...result.rows.map((row) => row.providerId)])];
      failure = null;
    } catch (error) {
      if (request === latest) failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === latest) loading = false;
    }
  }

  $effect(() => {
    void store;
    untrack(() => { provider = null; historicalProviders = []; history = null; });
  });

  $effect(() => {
    const days = range;
    const selected = provider;
    if (!store.client) return;
    untrack(() => { history = null; void load(days, selected); });
    return () => { latest += 1; };
  });

  $effect(() => {
    const client = store.client;
    if (!client) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A finished turn changes today's column; a burst of them reloads once.
    const offTurns = client.on('turn.finished', () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(range), 1500);
    });
    return () => { clearTimeout(timer); offTurns(); };
  });

  function refresh() {
    void load(range);
  }

  let providerIds = $derived([...new Set([...store.providers.map((entry) => entry.id), ...historicalProviders, ...(provider === null ? [] : [provider])])]);
  let view = $derived(history === null ? null : summarize(history, metric, provider === null ? providerIds : [provider]));
  let chartSeries = $derived(view?.series.filter((serie) => view!.bySeries[serie.key]!.turns > 0) ?? []);
  let names = $derived(new Map(store.providers.map((provider) => [provider.id, provider.name])));
  let modelNames = $derived(new Map(store.providers.flatMap((entry) => entry.models.map((model) => [`${entry.id}\u0000${model.id}`, model.name] as const))));
  let colors = $derived(new Map(seriesFor(providerIds).series.map((serie) => [serie.key, serie.color])));
  let providerItems = $derived([
    { id: '', label: strings.usage.allProviders, active: provider === null },
    ...seriesFor(providerIds).series.filter((serie) => serie.key.trim()).map((serie) => ({ id: serie.key, label: providerName(serie.key), active: provider === serie.key }))
  ]);
  let known = $derived(new Set(store.threads.map((thread) => thread.id)));
  let threads = $derived(history === null ? [] : topThreads(history.threads, metric));
  let threadPeak = $derived(threads[0]?.value ?? 0);
  let dayRows = $derived(view?.days.filter((day) => day.turns > 0) ?? []);

  function providerName(providerId: string): string {
    if (!providerId.trim()) return strings.usage.unknownProvider;
    return names.get(providerId) ?? providerId;
  }

  function colorOf(providerId: string): string {
    return colors.get(providerId) ?? 'var(--series-other)';
  }

  function money(totals: UsageTotals): string {
    return totals.priced === 0 ? strings.usage.noPrice : formatMetric('cost', totals.usage.costUsdEquivalent ?? 0);
  }

  function valueOf(totals: UsageTotals & { value: number }): string {
    if (metric === 'cost') return money(totals);
    if (metric === 'tokens' && totals.turns > 0 && totals.reported === 0) return strings.usage.noUsage;
    return formatMetric(metric, totals.value);
  }

  // In the language the app speaks, not the system's.
  const dayName = $derived(new Intl.DateTimeFormat(formatLocale(), { weekday: 'short', day: 'numeric', month: 'short' }));
  const percent = $derived(new Intl.NumberFormat(formatLocale(), { style: 'percent', maximumFractionDigits: 0 }));
</script>

{#snippet numbers(totals: UsageTotals)}
  <td class="num mid">{formatMetric('turns', totals.turns)}</td>
  <td class="num" class:muted={totals.reported === 0}>{totals.reported === 0 ? strings.usage.noUsage : formatMetric('tokens', totalTokens(totals.usage))}</td>
  <td class="num wide">{reportedValue('tokens', totals.usage.inputTokens, totals)}</td>
  <td class="num wide">{reportedValue('tokens', totals.usage.outputTokens, totals)}</td>
  <td class="num wide">{reportedValue('tokens', totals.usage.cacheReadTokens + totals.usage.cacheWriteTokens, totals)}</td>
  <td class="num" class:muted={totals.priced === 0}>{money(totals)}</td>
{/snippet}

{#snippet heads(first: string)}
  <tr>
    <th>{first}</th>
    <th class="num mid">{strings.usage.turns}</th>
    <th class="num">{strings.usage.tokens}</th>
    <th class="num wide">{strings.usage.input}</th>
    <th class="num wide">{strings.usage.output}</th>
    <th class="num wide">{strings.usage.cache}</th>
    <th class="num">{strings.usage.metrics.cost}</th>
  </tr>
{/snippet}

<div class="page usage" data-testid="usage-page">
  <header>
    <div><h1>{strings.usage.heading}<InfoTip topic={strings.usage.heading} text={`${strings.usage.intro} ${strings.usage.note}`} /></h1></div>
  </header>

  <div class="filters">
    <div class="segmented" role="group" aria-label={strings.usage.range}>
      {#each USAGE_RANGES as days (days)}
        <button type="button" class:on={range === days} aria-pressed={range === days} data-testid="usage-range-{days}" onclick={() => { range = days; }}>
          {fill(strings.usage.days, { days: String(days) })}
        </button>
      {/each}
    </div>
    <div class="segmented" role="group" aria-label={strings.usage.metric}>
      {#each USAGE_METRICS as option (option)}
        <button type="button" class:on={metric === option} aria-pressed={metric === option} data-testid="usage-metric-{option}" onclick={() => { metric = option; }}>
          {strings.usage.metrics[option]}
        </button>
      {/each}
    </div>
    <Menu items={providerItems} label={strings.usage.provider} placement="bottom" testid="usage-provider-filter" onpick={(id) => { provider = id || null; }}>
      <span class="filter-name">{provider === null ? strings.usage.allProviders : providerName(provider)}</span><ChevronDown size={13} />
    </Menu>
    <button type="button" class="quiet icon refresh" aria-label={strings.usage.refresh} title={strings.usage.refresh} data-testid="usage-refresh" onclick={refresh}>
      <RefreshCw size={15} strokeWidth={1.75} class={loading ? 'spinning' : ''} />
    </button>
  </div>

  {#if failure}
    <p class="failure" role="alert">{fill(strings.usage.failed, { error: failure })}</p>
  {/if}

  <div class="body settings-stack" class:stale={loading && view !== null} aria-busy={loading}>
    {#if view === null && !failure}
      <section class="card"><p class="muted">{strings.usage.loading}</p></section>
    {:else if view !== null}
      <section class="card overview" id="settings-usage-overview" data-testid="usage-overview">
        <div class="hero">
          <span class="section-label">{fill(strings.usage.totalOf[metric], { days: String(range) })}</span>
          <strong data-testid="usage-total">{valueOf(view.total)}</strong>
          <small>{fill(view.total.turns > 0 && view.total.reported === 0 ? strings.usage.summaryMissing : view.total.priced === 0 ? strings.usage.summaryNoPrice : strings.usage.summary, {
            turns: formatMetric('turns', view.total.turns),
            tokens: formatMetric('tokens', totalTokens(view.total.usage)),
            cost: money(view.total)
          })}</small>
          {#if view.total.turns > 0}
            <small class="coverage" data-testid="usage-coverage">{fill(strings.usage.coverage, {
              reported: formatMetric('turns', view.total.reported), priced: formatMetric('turns', view.total.priced), turns: formatMetric('turns', view.total.turns)
            })}</small>
          {/if}
        </div>
        {#if view.series.length > 0}
          <ul class="providers" data-testid="usage-providers">
            {#each view.series as serie (serie.key)}
              {@const totals = view.bySeries[serie.key]!}
              {@const share = view.total.value > 0 ? totals.value / view.total.value : 0}
              <li data-provider={serie.key}>
                <span class="swatch" style:background={serie.color}></span>
                <span class="provider"><ProviderLogo providerId={serie.key} size={14} /><span>{providerName(serie.key)}{#if totals.turns > 0}<small>{fill(strings.usage.coverage, { reported: formatMetric('turns', totals.reported), priced: formatMetric('turns', totals.priced), turns: formatMetric('turns', totals.turns) })}</small>{/if}</span></span>
                <span class="value" class:muted={totals.turns === 0}>{totals.turns === 0 ? strings.usage.noActivity : valueOf(totals)}</span>
                <span class="share" title={fill(strings.usage.share, { percent: percent.format(share) })}>{totals.turns > 0 && (metric === 'turns' || (metric === 'tokens' ? totals.reported : totals.priced) > 0) ? percent.format(share) : ''}</span>
                <span class="bar"><span style:width="{share * 100}%" style:background={serie.color}></span></span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="card" id="settings-usage-chart">
        <h2>{strings.usage.chart}</h2>
        {#if view.total.turns === 0}
          <p class="muted" data-testid="usage-empty">{fill(strings.usage.emptyRange, { days: String(range) })}</p>
        {:else if metric === 'cost' && view.total.priced === 0}
          <p class="muted" data-testid="usage-empty">{strings.usage.noPrice}</p>
        {:else if metric === 'tokens' && view.total.reported === 0}
          <p class="muted" data-testid="usage-empty">{strings.usage.noUsage}</p>
        {:else}
          <UsageChart
            buckets={view.buckets}
            series={chartSeries.map((serie) => ({ key: serie.key, color: serie.color, label: providerName(serie.key) }))}
            {metric}
            days={range}
            label={fill(strings.usage.chartLabel, { metric: strings.usage.metrics[metric] })}
          />
          <ul class="legend" aria-hidden="true">
            {#each chartSeries as serie (serie.key)}
              <li><span class="swatch" style:background={serie.color}></span>{providerName(serie.key)}</li>
            {/each}
          </ul>
        {/if}
        {#if metric === 'cost' && view.unpriced.length > 0}
          <p class="aside" data-testid="usage-unpriced">{fill(strings.usage.unpriced, { providers: view.unpriced.map(providerName).join(', ') })}</p>
        {/if}
        {#if view.total.turns > view.total.reported}
          <p class="aside">{fill(strings.usage.unreported, { count: formatMetric('turns', view.total.turns - view.total.reported) })}</p>
        {/if}
        {#if metric === 'cost' && view.total.priced > 0 && view.total.priced < view.total.turns}
          <p class="aside" data-testid="usage-partial-cost">{fill(strings.usage.partialCost, { count: formatMetric('turns', view.total.turns - view.total.priced) })}</p>
        {/if}
      </section>

      {#if view.total.turns > 0}
        <section class="card breakdown" id="settings-usage-breakdown">
          <div class="card-head">
            <h2>{strings.usage.breakdown}</h2>
            <div class="segmented" role="group" aria-label={strings.usage.breakdown}>
              <button type="button" class:on={breakdown === 'model'} aria-pressed={breakdown === 'model'} data-testid="usage-by-model" onclick={() => { breakdown = 'model'; }}>{strings.usage.byModel}</button>
              <button type="button" class:on={breakdown === 'day'} aria-pressed={breakdown === 'day'} data-testid="usage-by-day" onclick={() => { breakdown = 'day'; }}>{strings.usage.byDay}</button>
            </div>
          </div>
          <div class="table" class:scroll={breakdown === 'day'}>
            <table data-testid="usage-breakdown">
              {#if breakdown === 'model'}
                <thead>{@render heads(strings.usage.model)}</thead>
                <tbody>
                  {#each view.models as row (`${row.providerId}:${row.model}`)}
                    <tr>
                      <td class="who">
                        <span class="swatch" style:background={colorOf(row.providerId)}></span>
                        <span><span class="model">{modelName(row.model, modelNames, row.providerId)}</span><small>{providerName(row.providerId)}</small></span>
                      </td>
                      {@render numbers(row)}
                    </tr>
                  {/each}
                </tbody>
              {:else}
                <thead>{@render heads(strings.usage.day)}</thead>
                <tbody>
                  {#each dayRows as row (row.start)}
                    <tr>
                      <td>{dayName.format(row.start)}</td>
                      {@render numbers(row)}
                    </tr>
                  {/each}
                </tbody>
              {/if}
            </table>
          </div>
        </section>

        <section class="card" id="settings-usage-threads">
          <h2>{strings.usage.threads}</h2>
          {#if threads.length === 0}<p class="muted">{strings.usage.noRankedThreads}</p>{/if}
          <ol class="threads" data-testid="usage-threads">
            {#each threads as thread (thread.threadId)}
              <li>
                {#if known.has(thread.threadId)}
                  <button type="button" class="ghost thread" onclick={() => void store.open(thread.threadId)}>
                    {@render threadRow(thread)}
                  </button>
                {:else}
                  <div class="thread">{@render threadRow(thread)}</div>
                {/if}
              </li>
            {/each}
          </ol>
        </section>
      {/if}
    {/if}
  </div>
</div>

{#snippet threadRow(thread: (typeof threads)[number])}
  <ProviderLogo providerId={thread.providerId} size={16} />
  <span class="title">
    <span class="name">{thread.title || strings.usage.untitled}</span>
    <small>
      {fill(strings.usage.threadTurns, { turns: formatMetric('turns', thread.turns) })}
      {#if thread.archived}<span class="tag">{strings.usage.archived}</span>{/if}
    </small>
  </span>
  <span class="amount">
    <span class="value">{formatMetric(metric, thread.value)}</span>
    <span class="bar"><span style:width="{threadPeak > 0 ? (thread.value / threadPeak) * 100 : 0}%" style:background={colorOf(thread.providerId)}></span></span>
  </span>
{/snippet}

<style>
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: var(--settings-width); margin-bottom: 20px; }
  .refresh { margin-left: auto; width: var(--control); height: var(--control); padding: 0; }
  .filter-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
  .refresh :global(.spinning) { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .failure { max-width: var(--settings-width); margin: 0 0 12px; color: var(--color-danger); font-size: var(--text-sm); }
  .body { max-width: var(--settings-width); transition: opacity var(--dur-2) var(--ease-out-quint); }
  .body.stale { opacity: 0.6; }

  /* The options in one track, the chosen one filled like a primary button. */
  .segmented { display: inline-flex; flex: none; gap: 2px; padding: 2px; border: 1px solid var(--color-edge); border-radius: var(--radius-md); background: var(--color-surface-2); }
  .segmented button { height: var(--control-sm); padding: 0 10px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .segmented button:hover:not(.on) { background: var(--color-surface-3); color: var(--color-foreground); }
  .segmented button.on { background: var(--color-foreground); border-color: var(--color-foreground); color: var(--color-on-foreground); }

  .hero { display: grid; gap: 4px; }
  .hero strong { font-size: calc(var(--text-lg) * 1.6); line-height: 1.1; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .hero small, .aside, .muted { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .aside { margin: 10px 0 0; line-height: 1.5; }

  .providers { display: grid; gap: 8px; margin: 16px 0 0; padding: 14px 0 0; list-style: none; border-top: 1px solid var(--color-border); }
  .providers li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto 44px minmax(60px, 160px); align-items: center; gap: 10px; font-size: var(--text-sm); }
  .swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  .provider { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .provider > span { display: grid; min-width: 0; overflow-wrap: anywhere; }
  .provider small { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .value { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
  .share { font-variant-numeric: tabular-nums; color: var(--color-muted-foreground); text-align: right; }
  .bar { display: block; height: 4px; border-radius: 2px; background: var(--color-surface-3); overflow: hidden; }
  .bar span { transition: width var(--dur-3) var(--ease-out-quint); display: block; height: 100%; border-radius: 2px; }

  .legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 10px 0 0; padding: 0; list-style: none; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .legend li { display: inline-flex; align-items: center; gap: 6px; }

  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
  .card-head h2 { margin: 0; }
  .breakdown .card-head h2 { margin-bottom: 0; }
  .breakdown { container-type: inline-size; }
  .table { overflow-x: auto; margin: 0 calc(-1 * var(--settings-padding)) calc(-1 * var(--settings-padding)); border-radius: 0 0 var(--radius-lg) var(--radius-lg); }
  /* Ninety days is ninety rows: the day view scrolls under its sticky header. */
  .table.scroll { max-height: 420px; overflow-y: auto; }
  table { font-size: var(--text-sm); }
  th { position: sticky; top: 0; z-index: 1; background: var(--color-surface); }
  th:first-child, td:first-child { padding-left: var(--settings-padding); }
  th:last-child, td:last-child { padding-right: var(--settings-padding); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  td.muted { font-size: var(--text-sm); }
  .who { display: flex; align-items: center; gap: 10px; white-space: normal; }
  .who > span:last-child { display: grid; min-width: 0; }
  .model { overflow: hidden; text-overflow: ellipsis; }
  .who small { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  tbody tr:hover td { background: var(--color-hover); }
  @container (max-width: 560px) { .wide { display: none; } }
  @container (max-width: 420px) { .mid { display: none; } }

  .threads { display: grid; gap: 2px; margin: 0 -8px; padding: 0; list-style: none; }
  .thread { display: grid; grid-template-columns: 16px minmax(0, 1fr) minmax(88px, 150px); align-items: center; gap: 10px; width: 100%; height: auto; min-height: var(--row); padding: 6px 8px; border-radius: var(--radius-md); color: var(--color-foreground); text-align: left; font-weight: 400; }
  .title { display: grid; min-width: 0; }
  .title .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title small { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .tag { margin-left: 6px; padding: 0 5px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
  .amount { display: grid; gap: 4px; justify-items: end; }
  .amount .bar { width: 100%; }

  @media (max-width: 720px) {
    .hero strong { font-size: calc(var(--text-lg) * 1.4); }
    .providers li { grid-template-columns: 10px minmax(0, 1fr) auto 40px; }
    .providers .bar { grid-column: 2 / -1; }
    .thread { grid-template-columns: 16px minmax(0, 1fr) 80px; }
  }
  @media (prefers-reduced-motion: reduce) { .refresh :global(.spinning) { animation: none; } }
</style>
