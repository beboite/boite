<script lang="ts">
  import { slide } from 'svelte/transition';
  import { Plus } from '@lucide/svelte';
  import { QUOTA_ALERT_MAX, QUOTA_ALERT_PERIODS, QUOTA_ALERT_PRESETS, quotaAlertPeriod, type AccountQuota, type QuotaAlertPeriod } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { glides } from '../lib/motion';
  import InfoTip from './InfoTip.svelte';

  /**
   * The alerts of one card: per period the account reports, 5 hours and
   * weekly, the shares left that each notify. Any of `QUOTA_ALERT_PRESETS`
   * toggles on or off, and Custom adds another whole percentage, shown as a
   * chip of its own that a click removes. The bell in the card's header opens
   * it; `open` is that bell's state.
   */
  let { row, name, open, onalert }: {
    row: AccountQuota; name: string; open: boolean;
    onalert: (accountId: string, period: QuotaAlertPeriod, thresholds: number[]) => Promise<void>;
  } = $props();
  const uid = $props.id();
  let saving = $state<QuotaAlertPeriod | null>(null);
  /** The period whose custom field is open, and what it holds. */
  let editing = $state<QuotaAlertPeriod | null>(null);
  let draft = $state('');

  /** The periods with a window to watch, and any already set whose window the last reading lacks. */
  let periods = $derived(alertPeriods(row));

  async function save(period: QuotaAlertPeriod, thresholds: number[]) {
    if (saving) return;
    saving = period;
    try { await onalert(row.accountId, period, thresholds); }
    finally { saving = null; }
  }

  function toggle(period: QuotaAlertPeriod, left: number) {
    const chosen = row.alerts?.[period] ?? [];
    void save(period, chosen.includes(left) ? chosen.filter((value) => value !== left) : [...chosen, left]);
  }

  /** A whole percentage from 0 to 99 joins the list; anything else closes the field and saves nothing. */
  function commit(period: QuotaAlertPeriod) {
    if (editing !== period) return;
    editing = null;
    const left = Number(draft.trim());
    const chosen = row.alerts?.[period] ?? [];
    if (draft.trim() === '' || !Number.isInteger(left) || left < 0 || left > 99 || chosen.includes(left)) return;
    void save(period, [...chosen, left]);
  }

  function focus(node: HTMLInputElement) { node.focus(); }
</script>

<script lang="ts" module>
  export function alertPeriods(row: AccountQuota): QuotaAlertPeriod[] {
    return QUOTA_ALERT_PERIODS.filter((period) => row.alerts?.[period] !== undefined || row.windows.some((window) => quotaAlertPeriod(window) === period));
  }
</script>

{#if open && periods.length > 0}
  <div class="alerts" id="{uid}-alerts" role="group" aria-label={fill(strings.quotas.alertsOf, { account: name })} data-testid="quota-alerts" transition:slide={{ duration: glides() ? 160 : 0 }}>
    <p class="heading ui-label-box"><span class="ui-label">{strings.quotas.alerts}</span><span class="ui-label unit">{strings.quotas.alertsLeft}</span><InfoTip topic={strings.quotas.alerts} text={strings.quotas.alertsHint} /></p>
    {#each periods as period (period)}
      {@const chosen = row.alerts?.[period] ?? []}
      {@const shown = [...new Set([...QUOTA_ALERT_PRESETS, ...chosen])].sort((a, b) => b - a)}
      <div class="line">
        <span class="period ui-label" id="{uid}-{period}">{strings.quotas.alertPeriods[period]}</span>
        <div class="chips" role="group" aria-labelledby="{uid}-{period}" aria-busy={saving === period}>
          {#each shown as left (left)}
            {@const on = chosen.includes(left)}
            <button type="button" class="chip" class:on class:custom={!QUOTA_ALERT_PRESETS.includes(left)} aria-pressed={on} disabled={saving !== null}
              title={QUOTA_ALERT_PRESETS.includes(left) ? undefined : fill(strings.quotas.alertRemove, { percent: String(left) })}
              data-testid="quota-alert-{period}-{left}" onclick={() => toggle(period, left)}>
              <span class="ui-label">{fill(strings.quotas.alertAt, { percent: String(left) })}</span>
            </button>
          {/each}
          {#if editing === period}
            <input class="field" type="text" inputmode="numeric" pattern="[0-9]*" bind:value={draft} use:focus
              aria-label={strings.quotas.alertCustomLabel} placeholder={strings.quotas.alertCustomPlaceholder} data-testid="quota-alert-{period}-input"
              onkeydown={(event) => { if (event.key === 'Enter') commit(period); else if (event.key === 'Escape') { event.stopPropagation(); editing = null; } }}
              onblur={() => commit(period)} />
          {:else if chosen.length < QUOTA_ALERT_MAX}
            <button type="button" class="chip add" disabled={saving !== null} data-testid="quota-alert-{period}-custom" onclick={() => { draft = ''; editing = period; }}>
              <Plus size={13} aria-hidden="true" /><span class="ui-label">{strings.quotas.alertCustom}</span>
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .alerts { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-3); }
  .heading { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 500; }
  .heading .unit { margin-left: 6px; opacity: 0.75; }
  .line { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .period { font-size: var(--text-sm); }
  /* Each share its own toggle, filled with the accent when on; several may be. */
  .chips { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; height: var(--control-sm); min-width: 44px; justify-content: center; padding: 0 9px; border: 1px solid var(--color-edge); border-radius: var(--radius-md);
    background: var(--color-surface-2); color: var(--color-muted-foreground); font-size: var(--text-sm); font-variant-numeric: tabular-nums;
    transition: background-color var(--dur-2) var(--ease-out-quint), color var(--dur-2) var(--ease-out-quint), border-color var(--dur-2) var(--ease-out-quint); }
  .chip:hover:not(.on):not(:disabled) { background: var(--color-surface-3); color: var(--color-foreground); }
  .chip.on { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-accent-ink); }
  .chip.add { border-style: dashed; }
  .field { width: 64px; height: var(--control-sm); padding: 0 8px; border: 1px solid var(--color-accent); border-radius: var(--radius-md); background: var(--color-surface-2); color: var(--color-foreground); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .chips[aria-busy='true'] { opacity: 0.7; }
  @media (max-width: 720px) {
    .chips { flex: 1 1 100%; justify-content: flex-start; }
    .chip { flex: 1 0 auto; }
  }
</style>
