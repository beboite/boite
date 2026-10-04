<script lang="ts">
  import { Clock3, Wallet } from '@lucide/svelte';
  import QuotaExtras from './QuotaExtras.svelte';
  import QuotaReset from './QuotaReset.svelte';
  import type { Store } from '../lib/store.svelte';
  import type { AccountQuota } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { creditBalance, exactTime, quotaWindowName, tenth, weekdayTime } from '../lib/format';
  import { quotaAccountName } from '../lib/quota-reader.svelte';
  import ProviderLogo from './ProviderLogo.svelte';

  /**
   * One card per signed-in account, named by its label beside the provider's
   * logo. While a new reading loads, the old one stays desaturated until that
   * account answers.
   */
  let { rows, loading = false, completed = [], store }: { rows: AccountQuota[]; loading?: boolean; completed?: string[]; store?: Store } = $props();

  const remaining = (used: number) => Math.max(0, Math.round((100 - used) * 10) / 10);
</script>

<div class="limits" class:loading data-testid="usage-limits">
  {#each rows as row (row.accountId)}
    {@const name = quotaAccountName(row)}
    {@const at = row.checkedAt}
    {@const observed = row.source === 'observation'}
    {@const pending = loading && !completed.includes(row.accountId)}
    {@const stale = row.windows.length > 0 && (row.error !== null || row.status === 'unavailable')}
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
      </header>
      <!-- Bars without a fresh answer: the last good reading, kept after a failure or before a re-read. -->
      <article data-testid="usage-limit-account" data-provider={row.providerId} aria-busy={pending} class:stale>
        {#each row.windows as limit (limit.id)}
          {@const left = remaining(limit.usedPercent)}
          <div class="window" class:low={limit.usedPercent >= 80} class:out={limit.usedPercent >= 100}>
            <div class="line">
              <span class="name">{quotaWindowName(limit.label)}</span>
              <span class="left">{fill(strings.quotas.remaining, { percent: tenth(left) })}</span>
            </div>
            <div class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label="{name} {quotaWindowName(limit.label)}">
              <div class="fill" style:width="{left}%"></div>
            </div>
            {#if limit.resetsAt}<small class="reset"><Clock3 size={11} aria-hidden="true" /><span class="ui-label">{fill(strings.quotas.resets, { time: weekdayTime(limit.resetsAt) })}</span></small>{/if}
          </div>
        {/each}
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
            {#if row.providerId === 'antigravity'}<small>{strings.quotas.slowHint}</small>{/if}
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
  header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: var(--text-md); }
  .checked, .reset { display: flex; align-items: center; gap: 5px; }
  .badges { display: flex; flex-wrap: wrap; gap: 5px; }
  .badge { padding: 2px 7px; border-radius: var(--radius-sm); background: var(--color-surface-3); color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .status-cooldown { color: var(--color-live); }
  .status-error { color: var(--color-danger); }
  .credit { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: var(--text-sm); }
  .credit .heading { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--color-muted-foreground); }
  .credit .heading :global(svg) { flex: none; color: var(--color-success); }
  .credit .amount { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; }
  .checked :global(svg), .reset :global(svg) { flex: none; opacity: 0.7; }
  article { display: grid; gap: 17px; }
  .window { display: grid; gap: 7px; }
  .line { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: var(--text-sm); }
  .name { font-weight: 500; }
  .left { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; font-size: var(--text-base); }
  .low .left { color: var(--color-live); }
  .out .left { color: var(--color-danger); }
  .track { height: 6px; border-radius: var(--radius-sm); background: var(--color-surface-3); overflow: hidden; filter: saturate(1); transition: filter var(--dur-3) var(--ease-out-quint); }
  .out .track { background: color-mix(in srgb, var(--color-danger) 15%, var(--color-surface-3)); }
  .fill { height: 100%; border-radius: var(--radius-sm); background: var(--color-success); transition: width var(--dur-3) var(--ease-out-quint), background-color var(--dur-3) var(--ease-out-quint); }
  .low .fill { background: var(--color-live); }
  small, .muted { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  p { margin: 0; }
  .muted { font-size: var(--text-sm); }
  .error { color: var(--color-danger); font-size: var(--text-sm); }
  /* The reading on screen is the previous one until the new one lands. */
  article[aria-busy='true'] .track { filter: saturate(0.15); }
  /* Dimmed like the tray's stale meters: a reading, but not a fresh one. */
  article.stale .track { opacity: 0.45; }
  @media (prefers-reduced-motion: reduce) {
    .track, .fill { transition: none; }
  }
</style>
