<script lang="ts">
  import { RotateCcw, Wallet } from '@lucide/svelte';
  import type { AccountQuota } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { creditBalance, exactTime, tenth, weekdayTime } from '../lib/format';

  let { row, accountLabel = false, compact = false }: { row: AccountQuota; accountLabel?: boolean; compact?: boolean } = $props();
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
  let headings = $derived(compact ? { budget: strings.quotas.budgetCompact, balance: strings.quotas.creditCompact } :
    { budget: strings.quotas.budgetRemaining, balance: strings.quotas.creditRemaining });
</script>

{#if showResets || showCredits}
  <div class="extras" class:compact data-testid="quota-extras" data-account-id={row.accountId}>
    {#if accountLabel}<small class="account">{row.label}</small>{/if}
    {#if showResets && resets}
      <div class="resets" data-testid="quota-banked-resets">
        <span class="reserve"><RotateCcw size={13} aria-hidden="true" />{fill(resets.availableCount === 1 ? strings.quotas.bankedReset : strings.quotas.bankedResets, { count: String(resets.availableCount) })}</span>
        {#if resets.nextExpiresAt !== null}<small title={fill(strings.quotas.resetExpires, { time: exactTime(resets.nextExpiresAt) })} aria-label={compact ? fill(strings.quotas.resetExpires, { time: exactTime(resets.nextExpiresAt) }) : undefined}>{compact ? weekdayTime(resets.nextExpiresAt) : fill(strings.quotas.resetExpires, { time: exactTime(resets.nextExpiresAt) })}</small>{/if}
      </div>
    {/if}
    {#if showCredits && credits}
      <div class="credits" data-testid="quota-credits">
        <div class="legend">
          <span class="heading"><Wallet size={15} aria-hidden="true" />{headings[credits.kind]}</span>
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
  .extras, .resets, .credits { display: grid; gap: 7px; min-width: 0; }
  .extras { gap: 12px; font-size: var(--text-sm); }
  .reserve { display: inline-flex; align-items: center; gap: 6px; justify-self: start; padding: 5px 9px; border-radius: var(--radius-md); background: var(--color-accent-soft); color: var(--color-foreground); font-weight: 550; }
  .reserve :global(svg) { flex: none; color: var(--color-accent); }
  .credits { padding: 12px; border: 1px solid color-mix(in srgb, var(--color-success) 20%, var(--color-border)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-success) 5%, var(--color-surface-2)); gap: 10px; }
  .legend { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .heading { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .heading :global(svg) { flex: none; color: var(--color-success); }
  .amount { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; color: var(--color-success); }
  small { color: var(--color-muted-foreground); font-size: var(--text-xs); overflow-wrap: anywhere; }
  .track { height: 6px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--color-success) 12%, var(--color-surface-3)); overflow: hidden; }
  .fill { height: 100%; background: var(--color-success); border-radius: var(--radius-sm); }
  .compact { gap: 9px; }
  .compact .resets { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 7px; }
  .compact .resets small { font-size: calc(var(--text-xs) - 1px); }
  .compact .reserve { padding: 3px 6px; font-size: calc(var(--text-xs) - 1px); line-height: 1.2; }
  .compact .credits { padding: 8px; gap: 7px; }
  .compact .legend { gap: 8px; }
  .compact .heading { gap: 5px; }
  .compact .amount { margin-left: auto; font-size: var(--text-xs); }
  .compact .track { height: 4px; }
</style>
