<script lang="ts">
  import { Clock3, Pin, PinOff, RotateCcw, Wallet } from '@lucide/svelte';
  import QuotaExtras from './QuotaExtras.svelte';
  import QuotaReset from './QuotaReset.svelte';
  import type { Store } from '../lib/store.svelte';
  import type { AccountQuota } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { creditBalance, exactTime, quotaWindowName, tenth, weekdayTime } from '../lib/format';
  import { quotaAccountName } from '../lib/quota-reader.svelte';
  import { pinnedWindow, shownWindows } from '../lib/quota-display';
  import ProviderLogo from './ProviderLogo.svelte';

  /**
   * One card per signed-in account, named by its label beside the provider's
   * logo. Its primary window comes first and largest, with its reset; the
   * other shown windows follow, each one pinnable as the primary. While a new
   * reading loads, the old one stays desaturated until that account answers.
   */
  let { rows, loading = false, completed = [], store }: { rows: AccountQuota[]; loading?: boolean; completed?: string[]; store?: Store } = $props();

  const remaining = (used: number) => Math.max(0, Math.round((100 - used) * 10) / 10);
  let saving = $state(false);

  /** Pins `windowId` as the account's primary window, or drops the pin when null. */
  async function pin(accountId: string, windowId: string | null) {
    if (!store?.owner || saving) return;
    const next = { ...(store.settings?.quotaPrimary ?? {}) };
    if (windowId === null) delete next[accountId];
    else next[accountId] = windowId;
    saving = true;
    try { await store.saveSettings({ quotaPrimary: next }); }
    finally { saving = false; }
  }
</script>

<div class="limits" class:loading data-testid="usage-limits">
  {#each rows as row (row.accountId)}
    {@const name = quotaAccountName(row)}
    {@const at = row.checkedAt}
    {@const observed = row.source === 'observation'}
    {@const pending = loading && !completed.includes(row.accountId)}
    {@const stale = row.windows.length > 0 && (row.error !== null || row.status === 'unavailable')}
    {@const shown = shownWindows(row, store?.settings)}
    {@const pinned = pinnedWindow(row, store?.settings)}
    {@const canPin = !!store?.owner}
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
        {#if shown.primary}
          {@const limit = shown.primary}
          {@const left = remaining(limit.usedPercent)}
          <div class="primary" class:low={limit.usedPercent >= 80} class:out={limit.usedPercent >= 100} data-testid="usage-limit-primary" data-window-id={limit.id}>
            <div class="primary-line">
              <span class="primary-name">
                <span class="ui-label">{quotaWindowName(limit.label)}</span>
                {#if canPin && pinned === limit.id}
                  <button type="button" class="quiet icon pin" aria-label={strings.quotas.unpin} title={strings.quotas.unpin} disabled={saving} data-testid="usage-limit-unpin" onclick={() => void pin(row.accountId, null)}><PinOff size={13} /></button>
                {/if}
              </span>
              <span class="primary-left">{tenth(left)}<span class="unit">%</span></span>
            </div>
            <div class="track big" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label="{name} {quotaWindowName(limit.label)}: {fill(strings.quotas.remaining, { percent: tenth(left) })}">
              <div class="fill" style:width="{left}%"></div>
            </div>
            <p class="primary-reset" title={limit.resetsAt ? exactTime(limit.resetsAt) : undefined}><RotateCcw size={13} aria-hidden="true" /><span class="ui-label">{limit.resetsAt ? fill(strings.quotas.resets, { time: weekdayTime(limit.resetsAt) }) : strings.quotas.noReset}</span></p>
          </div>
        {:else if row.windows.length > 0}
          <p class="muted" data-testid="usage-limit-all-hidden">{strings.quotas.allHidden}</p>
        {/if}
        {#if shown.others.length}
          <div class="others">
            {#each shown.others as limit (limit.id)}
              {@const left = remaining(limit.usedPercent)}
              <div class="window" class:low={limit.usedPercent >= 80} class:out={limit.usedPercent >= 100} data-window-id={limit.id}>
                <span class="name">{quotaWindowName(limit.label)}</span>
                <span class="left">{fill(strings.quotas.remaining, { percent: tenth(left) })}</span>
                {#if canPin}
                  <button type="button" class="quiet icon pin" aria-label={fill(strings.quotas.makePrimary, { window: quotaWindowName(limit.label) })}
                    title={fill(strings.quotas.makePrimary, { window: quotaWindowName(limit.label) })} disabled={saving} data-testid="usage-limit-pin"
                    onclick={() => void pin(row.accountId, limit.id)}><Pin size={13} /></button>
                {/if}
                <div class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label="{name} {quotaWindowName(limit.label)}">
                  <div class="fill" style:width="{left}%"></div>
                </div>
                {#if limit.resetsAt}<small class="reset"><Clock3 size={11} aria-hidden="true" /><span class="ui-label">{fill(strings.quotas.resets, { time: weekdayTime(limit.resetsAt) })}</span></small>{/if}
              </div>
            {/each}
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
  .primary { display: grid; gap: 8px; }
  .primary-line { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
  .primary-name { display: flex; align-items: center; gap: 4px; min-width: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); font-weight: 500; }
  .primary-left { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 650; font-size: var(--text-lg); line-height: 1; }
  .primary-left .unit { margin-left: 1px; font-size: var(--text-sm); font-weight: 500; color: var(--color-muted-foreground); }
  .primary.low .primary-left { color: var(--color-live); }
  .primary.out .primary-left { color: var(--color-danger); }
  .primary-reset { display: flex; align-items: center; gap: 6px; color: var(--color-foreground); font-size: var(--text-sm); }
  .primary-reset :global(svg) { flex: none; color: var(--color-muted-foreground); }
  .others { display: grid; gap: 14px; padding-top: 14px; border-top: 1px solid var(--color-border); }
  .window { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 6px 8px; font-size: var(--text-sm); }
  .window .track, .window .reset { grid-column: 1 / -1; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .left { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; }
  .pin { width: 24px; height: 24px; min-height: 0; padding: 0; color: var(--color-muted-foreground); }
  .pin:hover { color: var(--color-foreground); }
  .low .left { color: var(--color-live); }
  .out .left { color: var(--color-danger); }
  .track { height: 5px; border-radius: var(--radius-sm); background: var(--color-surface-3); overflow: hidden; filter: saturate(1); transition: filter var(--dur-3) var(--ease-out-quint); }
  .track.big { height: 10px; }
  .out .track { background: color-mix(in srgb, var(--color-danger) 15%, var(--color-surface-3)); }
  .fill { height: 100%; border-radius: var(--radius-sm); background: var(--color-success); transition: width var(--dur-3) var(--ease-out-quint), background-color var(--dur-3) var(--ease-out-quint); }
  .low .fill { background: var(--color-live); }
  small, .muted { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  p { margin: 0; }
  .muted { font-size: var(--text-sm); }
  .error { color: var(--color-danger); font-size: var(--text-sm); }
  /* The reading on screen is the previous one until the new one lands. */
  article[aria-busy='true'] .track { filter: saturate(0.15); }
  article[aria-busy='true'] .fill { animation: breathe 1.1s ease-in-out infinite alternate; }
  @keyframes breathe { to { opacity: 0.45; } }
  /* Dimmed like the tray's stale meters: a reading, but not a fresh one. */
  article.stale .track { opacity: 0.45; }
  @media (prefers-reduced-motion: reduce) {
    .track, .fill { transition: none; }
    article[aria-busy='true'] .fill { animation: none; }
  }
  :global(html[data-motion='reduced']) article[aria-busy='true'] .fill { animation: none; }
</style>
