<script lang="ts">
  import { slide } from 'svelte/transition';
  import { QUOTA_ALERT_PERIODS, QUOTA_ALERT_THRESHOLDS, quotaAlertPeriod, type AccountQuota, type QuotaAlertPeriod } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { glides } from '../lib/motion';
  import InfoTip from './InfoTip.svelte';

  /**
   * The alerts of one card: a choice per period the account reports, 5 hours
   * and weekly, between none and the shares of `QUOTA_ALERT_THRESHOLDS`. The
   * bell in the card's header opens it; `open` is that bell's state.
   */
  let { row, name, open, onalert }: {
    row: AccountQuota; name: string; open: boolean;
    onalert: (accountId: string, period: QuotaAlertPeriod, threshold: number | null) => Promise<void>;
  } = $props();
  const uid = $props.id();
  let saving = $state<QuotaAlertPeriod | null>(null);

  /** The periods with a window to watch, and any already set whose window the last reading lacks. */
  let periods = $derived(alertPeriods(row));

  async function choose(period: QuotaAlertPeriod, threshold: number | null) {
    if (saving || (row.alerts?.[period] ?? null) === threshold) return;
    saving = period;
    try { await onalert(row.accountId, period, threshold); }
    finally { saving = null; }
  }
</script>

<script lang="ts" module>
  export function alertPeriods(row: AccountQuota): QuotaAlertPeriod[] {
    return QUOTA_ALERT_PERIODS.filter((period) => row.alerts?.[period] !== undefined || row.windows.some((window) => quotaAlertPeriod(window) === period));
  }
</script>

{#if open && periods.length > 0}
  <div class="alerts" id="{uid}-alerts" role="group" aria-label={fill(strings.quotas.alertsOf, { account: name })} data-testid="quota-alerts" transition:slide={{ duration: glides() ? 160 : 0 }}>
    <p class="heading ui-label-box"><span class="ui-label">{strings.quotas.alerts}</span><InfoTip topic={strings.quotas.alerts} text={strings.quotas.alertsHint} /></p>
    {#each periods as period (period)}
      {@const chosen = row.alerts?.[period] ?? null}
      <div class="line">
        <span class="period ui-label" id="{uid}-{period}">{strings.quotas.alertPeriods[period]}</span>
        <div class="segmented" role="radiogroup" aria-labelledby="{uid}-{period}" aria-busy={saving === period}>
          {#each [null, ...QUOTA_ALERT_THRESHOLDS] as threshold (threshold ?? 'off')}
            <button type="button" role="radio" class:on={chosen === threshold} aria-checked={chosen === threshold} disabled={saving !== null}
              data-testid="quota-alert-{period}-{threshold ?? 'off'}" onclick={() => void choose(period, threshold)}>
              <span class="ui-label">{threshold === null ? strings.quotas.alertOff : fill(strings.quotas.alertAt, { percent: String(threshold) })}</span>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .alerts { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-3); }
  .heading { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 500; }
  .line { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .period { font-size: var(--text-sm); }
  /* The options in one track, the chosen one filled with the accent, as the usage page's filters. */
  .segmented { display: inline-flex; flex: none; gap: 2px; padding: 2px; border: 1px solid var(--color-edge); border-radius: var(--radius-md); background: var(--color-surface-2); }
  .segmented button { height: var(--control-sm); min-width: 44px; padding: 0 9px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--color-muted-foreground); font-size: var(--text-sm); font-variant-numeric: tabular-nums;
    transition: background-color var(--dur-2) var(--ease-out-quint), color var(--dur-2) var(--ease-out-quint); }
  .segmented button:hover:not(.on):not(:disabled) { background: var(--color-surface-3); color: var(--color-foreground); }
  .segmented button.on { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-accent-ink); }
  .segmented[aria-busy='true'] { opacity: 0.7; }
  @media (max-width: 720px) {
    .segmented { flex: 1 1 100%; }
    .segmented button { flex: 1; min-width: 0; }
  }
</style>
