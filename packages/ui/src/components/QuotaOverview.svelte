<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import type { AccountQuota } from '@boite/contracts';
  import ProviderLogo from './ProviderLogo.svelte';
  import { fill, strings } from '../lib/strings';
  import { quotaWindowName, weekdayTime } from '../lib/format';
  import { quotaGroups } from '../lib/quota-reader.svelte';

  /**
   * The tray's glance: one line per signed-in provider with its tightest
   * window, unfolded into each window's own bar and reset time. Nothing to
   * set here; monitoring and accounts live in Settings.
   */
  let { rows, loading = false, connect }: { rows: AccountQuota[]; loading?: boolean; connect: () => void } = $props();

  let groups = $derived(quotaGroups(rows));
  let expanded = $state<string | null>(null);
  const left = (used: number) => fill(strings.quotas.remaining, { percent: String(Math.max(0, Math.round(100 - used))) });
  const reset = (at: number) => fill(strings.quotas.resets, { time: weekdayTime(at) });
</script>

<div class="overview" class:loading data-testid="quota-overview">
  {#if groups.length === 0}
    <div class="empty" data-testid="quota-empty">
      <p>{strings.quotas.empty}</p>
      <button class="small" onclick={connect}>{strings.settings.connectProvider}</button>
    </div>
  {/if}
  {#each groups as group (group.providerId)}
    {@const windows = group.rows.flatMap((row) => row.windows)}
    {@const used = windows.length ? Math.max(...windows.map((limit) => limit.usedPercent)) : null}
    {@const stale = group.rows.some((row) => row.status === 'unavailable')}
    {@const resets = windows.flatMap((limit) => (limit.resetsAt === null ? [] : [limit.resetsAt]))}
    <article data-testid="quota-provider" data-provider={group.providerId} class:expanded={expanded === group.providerId}>
      <button class="summary ghost" aria-expanded={expanded === group.providerId} aria-controls={`usage-${group.providerId}`} disabled={windows.length === 0} onclick={() => (expanded = expanded === group.providerId ? null : group.providerId)}>
        <span class="logo"><ProviderLogo providerId={group.providerId} size={19} /></span>
        <span class="content">
          <span class="headline"><span class="name">{group.providerName}</span><span class="amount" class:low={used !== null && used >= 80}>{used !== null ? left(used) : strings.quotas.noReading}</span></span>
          {#if windows.length}
            <span class="meters" class:stale>
              {#each windows as limit, index (`${index}:${limit.id}`)}
                <progress max="100" value={100 - limit.usedPercent} class:low={limit.usedPercent >= 80} class:empty={limit.usedPercent >= 100} aria-label={`${group.providerName} ${quotaWindowName(limit.label)}: ${left(limit.usedPercent)}`}></progress>
              {/each}
            </span>
            <span class="caption">{stale ? strings.quotas.stale : resets.length ? reset(Math.min(...resets)) : strings.quotas.noReset}</span>
          {/if}
        </span>
        {#if windows.length}<ChevronDown size={13} />{/if}
      </button>
      {#if expanded === group.providerId}
        <div class="details" id={`usage-${group.providerId}`}>
          {#each group.rows as row (row.accountId)}
            {#if group.rows.length > 1}<span class="account">{row.label}</span>{/if}
            {#each row.windows as limit (limit.id)}
              <div class="window" class:low={limit.usedPercent >= 80}>
                <span class="window-name">{quotaWindowName(limit.label)}</span>
                <span class="window-left">{left(limit.usedPercent)}</span>
                <progress max="100" value={100 - limit.usedPercent} class:low={limit.usedPercent >= 80} class:empty={limit.usedPercent >= 100}></progress>
                {#if limit.resetsAt}<span class="caption">{reset(limit.resetsAt)}</span>{/if}
              </div>
            {/each}
          {/each}
        </div>
      {/if}
    </article>
  {/each}
</div>

<style>
  .overview { display: grid; grid-template-columns: minmax(0, 1fr); }
  article { min-width: 0; }
  article + article { border-top: 1px solid var(--color-border); }
  .summary { width: 100%; height: auto; min-height: 60px; padding: 6px 4px; display: flex; gap: 10px; text-align: left; border-radius: var(--radius-md); white-space: normal; }
  .summary:disabled { opacity: 1; cursor: default; }
  .logo { flex: none; width: 26px; display: grid; place-items: center; }
  .content { flex: 1; min-width: 0; display: grid; gap: 3px; }
  .headline { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .name { font-size: var(--text-base); font-weight: 550; color: var(--color-foreground); }
  .amount { color: var(--color-muted-foreground); font-size: var(--text-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .amount.low { color: var(--color-live); }
  .caption { font-size: var(--text-xs); color: var(--color-muted-foreground); font-weight: 400; }
  .meters { display: flex; gap: 4px; }
  .meters.stale { opacity: 0.45; }
  progress { flex: 1; width: 0; min-width: 0; appearance: none; border: 0; height: 4px; border-radius: var(--radius-sm); overflow: hidden; background: var(--color-surface-3); }
  progress::-webkit-progress-bar { background: var(--color-surface-3); }
  progress::-webkit-progress-value { background: var(--color-success); border-radius: var(--radius-sm); }
  progress::-moz-progress-bar { background: var(--color-success); }
  progress.low::-webkit-progress-value { background: var(--color-live); }
  progress.low::-moz-progress-bar { background: var(--color-live); }
  progress.empty { background: color-mix(in srgb, var(--color-danger) 35%, var(--color-surface-3)); }
  progress.empty::-webkit-progress-bar { background: color-mix(in srgb, var(--color-danger) 35%, var(--color-surface-3)); }
  .summary :global(svg:last-child) { flex: none; color: var(--color-subtle); transition: transform var(--dur-2); }
  .expanded .summary > :global(svg) { transform: rotate(180deg); }
  /* Unfolded, each window is a name, what is left, its bar and its reset, lined up under the logo's column. */
  .details { display: grid; gap: 10px; padding: 2px 4px 12px 40px; animation: rise var(--dur-2) var(--ease-out-quint); }
  .account { font-size: var(--text-xs); font-weight: 600; color: var(--color-muted-foreground); text-transform: uppercase; letter-spacing: 0.04em; }
  .window { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; font-size: var(--text-sm); }
  .window progress { grid-column: 1 / -1; width: 100%; }
  .window .caption { grid-column: 1 / -1; }
  .window-left { font-variant-numeric: tabular-nums; color: var(--color-muted-foreground); }
  .window.low .window-left { color: var(--color-live); }
  .empty { display: grid; justify-items: start; gap: 10px; padding: 16px 4px; }
  .empty p { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  /* The previous reading stays while the next one loads. */
  .loading progress { animation: breathe 1.1s var(--ease-out-quint) infinite alternate; }
  @keyframes breathe { from { opacity: 1; } to { opacity: 0.45; } }
  @keyframes rise { from { opacity: 0; transform: translateY(-4px); } }
  @media (prefers-reduced-motion: reduce) {
    .loading progress, .details { animation: none; }
  }
</style>
