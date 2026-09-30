<script lang="ts">
  import type { AccountQuota } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { creditBalance, exactTime, tenth } from '../lib/format';

  let { row, accountLabel = false }: { row: AccountQuota; accountLabel?: boolean } = $props();
  let resets = $derived(row.resetCredits);
  let credits = $derived(row.credits);
  let exhausted = $derived(row.windows.some((window) => window.usedPercent >= 100));
  let showCredits = $derived(row.enabled && row.status === 'ready' && exhausted && credits?.enabled === true &&
    credits.remaining !== null && Number.isFinite(credits.remaining) && credits.remaining > 0 &&
    (credits.kind === 'balance' || (credits.limit !== null && Number.isFinite(credits.limit) && credits.limit > 0)));
  let showResets = $derived(row.enabled && row.status === 'ready' && resets !== undefined && resets.availableCount > 0);
  let percent = $derived(credits?.limit ? Math.max(0, Math.min(100, (credits.remaining ?? 0) / credits.limit * 100)) : null);
  let budgetLabel = $derived(fill(percent !== null && percent > 0 && percent < 0.1 ? strings.quotas.remainingUnder : strings.quotas.remaining,
    { percent: tenth(percent !== null && percent > 0 && percent < 0.1 ? 0.1 : percent ?? 0) }));
</script>

{#if showResets || showCredits}
  <div class="extras" data-testid="quota-extras" data-account-id={row.accountId}>
    {#if accountLabel}<small class="account">{row.label}</small>{/if}
    {#if showResets && resets}
      <div class="resets" data-testid="quota-banked-resets">
        <span>{fill(resets.availableCount === 1 ? strings.quotas.bankedReset : strings.quotas.bankedResets, { count: String(resets.availableCount) })}</span>
        {#if resets.nextExpiresAt !== null}<small>{fill(strings.quotas.resetExpires, { time: exactTime(resets.nextExpiresAt) })}</small>{/if}
      </div>
    {/if}
    {#if showCredits && credits}
      <div class="credits" data-testid="quota-credits">
        <div class="legend">
          <span>{credits.kind === 'budget' ? strings.quotas.budgetRemaining : strings.quotas.creditRemaining}</span>
          <span class="amount">{credits.kind === 'budget' ? budgetLabel : fill(strings.quotas.creditBalance, { count: creditBalance(credits.remaining!) })}</span>
        </div>
        {#if percent !== null}
          <div class="track" role="meter" aria-label={credits.kind === 'budget' ? strings.quotas.budgetRemaining : strings.quotas.creditRemaining} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div class="fill" style:width="{percent}%"></div></div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .extras, .resets, .credits { display: grid; gap: 5px; }
  .extras { gap: 10px; font-size: var(--text-sm); }
  .legend { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .amount { font-variant-numeric: tabular-nums; white-space: nowrap; }
  small { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .track { height: 6px; border-radius: var(--radius-sm); background: var(--color-surface-3); overflow: hidden; }
  .fill { height: 100%; background: var(--color-success); border-radius: var(--radius-sm); }
</style>
