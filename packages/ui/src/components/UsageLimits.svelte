<script lang="ts">
  import { Bell, BellRing, Clock3, RotateCcw, Wallet } from '@lucide/svelte';
  import QuotaAlerts, { alertPeriods } from './QuotaAlerts.svelte';
  import QuotaExtras from './QuotaExtras.svelte';
  import QuotaWindow from './QuotaWindow.svelte';
  import QuotaReset from './QuotaReset.svelte';
  import type { Store } from '../lib/store.svelte';
  import type { AccountQuota, QuotaAlertPeriod } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { creditBalance, exactTime, quotaResetTime, quotaWindowName, tenth, weekdayTime } from '../lib/format';
  import { quotaAccountName, quotaTone, remainingPercent } from '../lib/quota-reader.svelte';
  import { shownWindows } from '../lib/quota-display';
  import ProviderLogo from './ProviderLogo.svelte';

  /**
   * One card per signed-in account, named by its label beside the provider's
   * logo. Its primary window comes first and largest, with its reset; the
   * other windows follow, compact. While a new reading loads, the old one
   * stays desaturated until that account answers. With `onalert`, a bell in
   * the header folds out the account's alerts.
   */
  let { rows, loading = false, completed = [], store, onalert }: {
    rows: AccountQuota[]; loading?: boolean; completed?: string[]; store?: Store;
    onalert?: (accountId: string, period: QuotaAlertPeriod, thresholds: number[]) => Promise<void>;
  } = $props();
  /** The cards whose alerts are folded out. */
  let opened = $state<string[]>([]);

  /** What the bell says on hover: each alert set, or what it opens. */
  function bellTitle(row: AccountQuota): string {
    const set = alertPeriods(row).flatMap((period) => !row.alerts?.[period]?.length ? []
      : [fill(strings.quotas.alertSet, { period: strings.quotas.alertPeriods[period], percents: row.alerts[period].map((left) => fill(strings.quotas.alertAt, { percent: String(left) })).join(', ') })]);
    return set.length ? `${strings.quotas.alerts}: ${set.join(', ')}` : strings.quotas.alerts;
  }
</script>

<div class="limits" class:loading data-testid="usage-limits">
  {#each rows as row (row.accountId)}
    {@const name = quotaAccountName(row)}
    {@const at = row.checkedAt}
    {@const observed = row.source === 'observation'}
    {@const pending = loading && !completed.includes(row.accountId)}
    {@const stale = row.windows.length > 0 && (row.error !== null || row.status === 'unavailable')}
    {@const shown = shownWindows(row)}
    <section class="card provider" data-testid="usage-limit-provider" data-provider={row.providerId} data-account-id={row.accountId}>
      <header>
        <span class="logo" title={row.providerName}><ProviderLogo providerId={row.providerId} size={22} /></span>
        <div class="identity">
          <strong title={name}>{name}</strong>
          {#if row.gateway && (row.gateway.plan || row.gateway.status !== 'ready')}
            <span class="badges">
              {#if row.gateway.plan}<span class="badge" data-testid="usage-limit-plan"><span class="ui-label">{row.gateway.plan}</span></span>{/if}
              {#if row.gateway.status !== 'ready'}<span class="badge status-{row.gateway.status}" data-testid="usage-limit-status"><span class="ui-label">{strings.subscriptionProxy.entryStatus[row.gateway.status]}</span></span>{/if}
            </span>
          {/if}
          {#if at !== null}<small class="checked" title={fill(observed ? strings.quotas.observed : strings.quotas.checked, { time: observed ? exactTime(at) : weekdayTime(at) })}><Clock3 size={11} aria-hidden="true" /><span class="ui-label">{observed ? exactTime(at) : weekdayTime(at)}</span></small>{/if}
        </div>
        {#if onalert && alertPeriods(row).length > 0}
          {@const set = row.alerts !== undefined && Object.keys(row.alerts).length > 0}
          {@const open = opened.includes(row.accountId)}
          <button type="button" class="ghost icon bell" class:set aria-expanded={open} aria-label={bellTitle(row)} title={bellTitle(row)} data-testid="quota-alert-bell"
            onclick={() => { opened = open ? opened.filter((id) => id !== row.accountId) : [...opened, row.accountId]; }}>
            {#if set}<BellRing size={16} />{:else}<Bell size={16} />{/if}
          </button>
        {/if}
      </header>
      {#if onalert}<QuotaAlerts {row} {name} open={opened.includes(row.accountId)} {onalert} />{/if}
      <!-- Bars without a fresh answer: the last good reading, kept after a failure or before a re-read. -->
      <article data-testid="usage-limit-account" data-provider={row.providerId} aria-busy={pending} class:stale>
        {#if shown.primary}
          {@const limit = shown.primary}
          {@const left = remainingPercent(limit.usedPercent)}
          <div class="primary" data-tone={quotaTone(limit.usedPercent)} data-testid="usage-limit-primary" data-window-id={limit.id}>
            <div class="primary-line">
              <span class="primary-name ui-label">{quotaWindowName(limit.label)}</span>
              <span class="primary-left">{tenth(left)}<span class="unit">{strings.quotas.remainingUnit}</span></span>
            </div>
            <div class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label="{name} {quotaWindowName(limit.label)}: {fill(strings.quotas.remaining, { percent: tenth(left) })}">
              <div class="fill" style:width="{left}%"></div>
            </div>
            <p class="primary-reset" title={limit.resetsAt ? exactTime(limit.resetsAt) : undefined}><RotateCcw size={13} aria-hidden="true" /><span class="ui-label">{limit.resetsAt ? fill(strings.quotas.resets, { time: quotaResetTime(limit.resetsAt) }) : strings.quotas.noReset}</span></p>
          </div>
        {/if}
        {#if shown.others.length}
          <div class="others">
            {#each shown.others as limit (limit.id)}<QuotaWindow {limit} owner={name} busy={pending} {stale} />{/each}
          </div>
        {/if}
        {#each row.gateway?.credits ?? [] as credit (credit.id)}
          {@const unit = credit.unit ? ` ${credit.unit}` : ''}
          <div class="credit" data-testid="usage-limit-credit">
            <span class="heading"><Wallet size={13} aria-hidden="true" /><span class="ui-label">{credit.label}</span></span>
            <span class="amount ui-label">{credit.remaining !== null
              ? `${credit.limit !== null ? fill(strings.subscriptionProxy.creditOf, { remaining: creditBalance(credit.remaining), limit: creditBalance(credit.limit) }) : creditBalance(credit.remaining)}${unit}`
              : credit.used !== null ? `${fill(strings.subscriptionProxy.creditUsed, { used: creditBalance(credit.used) })}${unit}` : '—'}</span>
          </div>
        {/each}
        {#if store?.owner}<QuotaReset {row} {store} disabled={pending} />{:else}<QuotaExtras {row} />{/if}
        {#if stale}<small data-testid="usage-limit-stale">{row.checkedAt === null ? strings.quotas.stale : `${strings.quotas.stale} · ${weekdayTime(row.checkedAt)}`}</small>{/if}
        {#if row.windows.length === 0 && !row.gateway?.credits.length && !row.error}
          {#if pending}
            <p class="muted" role="status" data-testid="usage-limit-loading">{strings.quotas.loading}</p>
          {:else}<p class="muted">{strings.quotas.unavailable}</p>{/if}
        {/if}
        {#if row.error}<p class="error" role="status">{row.error}</p>{/if}
      </article>
    </section>
  {/each}
</div>

<style>
  .limits { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 12px; max-width: var(--settings-width); }
  .provider { display: grid; align-content: start; gap: 20px; margin: 0; padding: var(--settings-padding); background: linear-gradient(145deg, var(--color-surface-2), var(--color-surface)); }
  header { display: flex; align-items: center; gap: 11px; min-width: 0; }
  .logo { display: grid; place-items: center; flex: none; width: 38px; height: 38px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-3); }
  .identity { flex: 1; min-width: 0; display: grid; gap: 3px; }
  .bell { flex: none; align-self: flex-start; color: var(--color-muted-foreground); }
  .bell.set { color: var(--color-accent); }
  .bell[aria-expanded='true'] { background: var(--color-active); }
  header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: var(--text-md); }
  .checked { display: flex; align-items: center; gap: 5px; }
  .checked :global(svg) { flex: none; opacity: 0.7; }
  .badges { display: flex; flex-wrap: wrap; gap: 5px; }
  .badge { padding: 2px 7px; border-radius: var(--radius-sm); background: var(--color-surface-3); color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .status-cooldown { color: var(--color-live); }
  .status-error { color: var(--color-danger); }
  .credit { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: var(--text-sm); }
  .credit .heading { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--color-muted-foreground); }
  .credit .heading :global(svg) { flex: none; color: var(--color-success); }
  .credit .amount { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; }
  article { display: grid; gap: 17px; }
  .primary { display: grid; gap: 8px; }
  .primary-line { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
  .primary-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); font-size: var(--text-sm); font-weight: 500; }
  .primary-left { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 650; font-size: var(--text-lg); line-height: 1; }
  .primary-left .unit { margin-left: 1px; font-size: var(--text-sm); font-weight: 500; color: var(--color-muted-foreground); }
  .primary[data-tone='low'] .primary-left { color: var(--color-live); }
  .primary[data-tone='out'] .primary-left { color: var(--color-danger); }
  .primary-reset { display: flex; align-items: center; gap: 6px; color: var(--color-foreground); font-size: var(--text-sm); }
  .primary-reset :global(svg) { flex: none; color: var(--color-muted-foreground); }
  .others { display: grid; gap: 14px; padding-top: 14px; border-top: 1px solid var(--color-border); }
  /* The primary window's bar, larger than the shared windows below it. */
  .track { height: 10px; border-radius: var(--radius-sm); background: var(--color-surface-3); overflow: hidden; filter: saturate(1); transition: filter var(--dur-3) var(--ease-out-quint); }
  .fill { height: 100%; border-radius: var(--radius-sm); background: var(--color-success); transition: width var(--dur-3) var(--ease-out-quint), background-color var(--dur-3) var(--ease-out-quint); }
  .primary[data-tone='out'] .track { background: color-mix(in srgb, var(--color-danger) 15%, var(--color-surface-3)); }
  .primary[data-tone='low'] .fill { background: var(--color-live); }
  small, .muted { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  p { margin: 0; }
  .muted { font-size: var(--text-sm); }
  .error { color: var(--color-danger); font-size: var(--text-sm); }
  /* The reading on screen is the previous one until the new one lands. */
  article[aria-busy='true'] .track { filter: saturate(0.15); }
  article[aria-busy='true'] .fill { animation: breathe 1.1s ease-in-out infinite alternate var(--loops); }
  /* Dimmed like the tray's stale meters: a reading, but not a fresh one. */
  article.stale .track { opacity: 0.45; }
  @media (prefers-reduced-motion: reduce) {
    .track, .fill { transition: none; }
    article[aria-busy='true'] .fill { animation: none; }
  }
  :global(html[data-motion='reduced']) article[aria-busy='true'] .fill { animation: none; }
</style>
