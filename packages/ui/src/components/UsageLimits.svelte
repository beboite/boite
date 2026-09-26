<script lang="ts">
  import type { AccountQuota } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { quotaWindowName, tenth, weekdayTime } from '../lib/format';
  import ProviderLogo from './ProviderLogo.svelte';

  let { rows }: { rows: AccountQuota[] } = $props();

  // The app's language, not the system's: a French app on an English machine still reads `ven. 03:30`.
  const when = { format: weekdayTime };
  const remaining = (used: number) => Math.max(0, Math.round((100 - used) * 10) / 10);

  /** An account the provider reports on, and was asked about. The rest are named once, below. */
  const reporting = (row: AccountQuota) => row.status !== 'unsupported' && row.status !== 'disabled' && (row.windows.length > 0 || row.error !== null);
  let read = $derived(rows.filter(reporting));
  let quiet = $derived(rows.filter((row) => !reporting(row)));
  /** The account's own name, left out when it only repeats the provider's. */
  const labelOf = (row: AccountQuota) => (row.label.trim().toLowerCase() === row.providerName.trim().toLowerCase() ? '' : row.label);
</script>

<div class="limits" data-testid="usage-limits">
  {#if read.length === 0}
    <p class="muted">{strings.usage.limitsEmpty}</p>
  {/if}
  {#each read as row (row.accountId)}
    <article data-testid="usage-limit-account" data-provider={row.providerId}>
      <header>
        <ProviderLogo providerId={row.providerId} size={16} />
        <strong>{row.providerName}</strong>
        <span class="label">{labelOf(row)}</span>
        {#if row.checkedAt}<small>{fill(strings.quotas.checked, { time: when.format(row.checkedAt) })}</small>{/if}
      </header>
      {#each row.windows as limit (limit.id)}
        <div class="window" class:low={limit.usedPercent >= 80} class:out={limit.usedPercent >= 100}>
          <span class="name">{quotaWindowName(limit.label)}</span>
          <div class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining(limit.usedPercent)} aria-label="{row.providerName} {quotaWindowName(limit.label)}">
            <div class="fill" style:width="{remaining(limit.usedPercent)}%"></div>
          </div>
          <span class="left">{fill(strings.quotas.remaining, { percent: tenth(remaining(limit.usedPercent)) })}</span>
          <small class="reset">{limit.resetsAt ? fill(strings.quotas.resets, { time: when.format(limit.resetsAt) }) : strings.quotas.noReset}</small>
        </div>
      {/each}
      {#if row.error}<p class="error" role="status">{row.error}</p>{/if}
    </article>
  {/each}
  {#if quiet.length > 0}
    <p class="muted quiet">{fill(strings.usage.notMonitored, { accounts: [...new Set(quiet.map((row) => row.providerName))].join(', ') })}</p>
  {/if}
</div>

<style>
  .limits { display: grid; gap: 14px; container-type: inline-size; }
  article { display: grid; gap: 8px; }
  article + article { padding-top: 14px; border-top: 1px solid var(--color-border); }
  header { display: flex; align-items: center; gap: 8px; min-width: 0; }
  header strong { font-weight: 600; }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  header small, .reset, .muted { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .window { display: grid; grid-template-columns: 96px minmax(80px, 1fr) max-content 128px; align-items: center; gap: 12px; font-size: var(--text-sm); }
  .name { color: var(--color-foreground); }
  .track { height: 6px; border-radius: 3px; background: var(--color-surface-3); overflow: hidden; }
  .fill { height: 100%; border-radius: 3px; background: var(--color-success); transition: width var(--dur-3) var(--ease-out-quint); }
  .low .fill { background: var(--color-live); }
  .left { font-variant-numeric: tabular-nums; text-align: right; }
  .out .left { color: var(--color-danger); }
  .reset { text-align: right; white-space: nowrap; }
  p { margin: 0; }
  .error { color: var(--color-danger); font-size: var(--text-sm); }
  .quiet { line-height: 1.5; }

  @container (max-width: 520px) {
    .window { grid-template-columns: 1fr auto; row-gap: 6px; column-gap: 12px; }
    .track { grid-column: 1 / -1; grid-row: 2; }
    .left { grid-column: 2; grid-row: 1; }
    .reset { grid-column: 1 / -1; grid-row: 3; text-align: left; }
  }
</style>
