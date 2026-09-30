<script lang="ts">
  import QuotaExtras from './QuotaExtras.svelte';
  import type { AccountQuota } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { exactTime, quotaWindowName, tenth, weekdayTime } from '../lib/format';
  import { quotaGroups } from '../lib/quota-reader.svelte';
  import ProviderLogo from './ProviderLogo.svelte';

  /**
   * One card per provider, one block per signed-in account inside it. The
   * account's name shows only when the provider has several; while a new
   * reading loads, the old one stays desaturated until that account answers.
   */
  let { rows, loading = false, completed = [] }: { rows: AccountQuota[]; loading?: boolean; completed?: string[] } = $props();

  let groups = $derived(quotaGroups(rows));
  const remaining = (used: number) => Math.max(0, Math.round((100 - used) * 10) / 10);
  /** The oldest reading of the card, the one a glance should doubt first. */
  const checked = (group: AccountQuota[]) => {
    const times = group.flatMap((row) => (row.checkedAt === null ? [] : [row.checkedAt]));
    return times.length > 0 ? Math.min(...times) : null;
  };
</script>

<div class="limits" class:loading data-testid="usage-limits">
  {#each groups as group (group.providerId)}
    {@const at = checked(group.rows)}
    {@const observed = group.rows.some((row) => row.source === 'observation')}
    <section class="card provider" data-testid="usage-limit-provider" data-provider={group.providerId}>
      <header>
        <ProviderLogo providerId={group.providerId} size={18} />
        <strong>{group.providerName}</strong>
        {#if at !== null}<small title={fill(observed ? strings.quotas.observed : strings.quotas.checked, { time: observed ? exactTime(at) : weekdayTime(at) })}>{observed ? exactTime(at) : weekdayTime(at)}</small>{/if}
      </header>
      {#each group.rows as row (row.accountId)}
        <article data-testid="usage-limit-account" data-provider={row.providerId} aria-busy={loading && !completed.includes(row.accountId)}>
          {#if group.rows.length > 1}<h3>{row.label}</h3>{/if}
          {#each row.windows as limit (limit.id)}
            {@const left = remaining(limit.usedPercent)}
            <div class="window" class:low={limit.usedPercent >= 80} class:out={limit.usedPercent >= 100}>
              <div class="line">
                <span class="name">{quotaWindowName(limit.label)}</span>
                <span class="left">{fill(strings.quotas.remaining, { percent: tenth(left) })}</span>
              </div>
              <div class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label="{group.providerName} {quotaWindowName(limit.label)}">
                <div class="fill" style:width="{left}%"></div>
              </div>
              {#if limit.resetsAt}<small>{fill(strings.quotas.resets, { time: weekdayTime(limit.resetsAt) })}</small>{/if}
            </div>
          {/each}
          <QuotaExtras {row} />
          {#if row.windows.length === 0 && !row.error}<p class="muted">{strings.quotas.unavailable}</p>{/if}
          {#if row.error}<p class="error" role="status">{row.error}</p>{/if}
        </article>
      {/each}
    </section>
  {/each}
</div>

<style>
  .limits { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 12px; max-width: var(--settings-width); }
  .provider { display: grid; align-content: start; gap: 14px; margin: 0; padding: var(--settings-padding); }
  header { display: flex; align-items: center; gap: 8px; min-width: 0; }
  header strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  header small { flex: none; }
  article { display: grid; gap: 12px; }
  article + article { padding-top: 14px; border-top: 1px solid var(--color-border); }
  h3 { margin: 0; font-size: var(--text-sm); font-weight: 500; color: var(--color-muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .window { display: grid; gap: 6px; }
  .line { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: var(--text-sm); }
  .left { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .out .left { color: var(--color-danger); }
  .track { height: 6px; border-radius: 3px; background: var(--color-surface-3); overflow: hidden; filter: saturate(1); transition: filter var(--dur-3) var(--ease-out-quint); }
  .fill { height: 100%; border-radius: 3px; background: var(--color-success); transition: width var(--dur-3) var(--ease-out-quint), background-color var(--dur-3) var(--ease-out-quint); }
  .low .fill { background: var(--color-live); }
  small, .muted { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  p { margin: 0; }
  .muted { font-size: var(--text-sm); }
  .error { color: var(--color-danger); font-size: var(--text-sm); }
  /* The reading on screen is the previous one until the new one lands. */
  article[aria-busy='true'] .track { filter: saturate(0.15); }
  @media (prefers-reduced-motion: reduce) {
    .track, .fill { transition: none; }
  }
</style>
