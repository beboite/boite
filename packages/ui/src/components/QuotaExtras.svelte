<script lang="ts">
  import { RotateCcw, Wallet } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import type { AccountQuota } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { creditBalance, exactTime, tenth } from '../lib/format';
  import { quotaCredits } from '../lib/quota-reader.svelte';

  let { row, accountLabel = false, compact = false, resetAction }: { row: AccountQuota; accountLabel?: boolean; compact?: boolean; resetAction?: Snippet } = $props();
  let resets = $derived(row.resetCredits);
  let credits = $derived(quotaCredits(row));
  let showCredits = $derived(credits !== null);
  let showResets = $derived(!compact && row.enabled && row.status === 'ready' && resets !== undefined && resets.availableCount > 0);
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
        <div class="reset-line">
          <span class="reserve"><RotateCcw size={13} aria-hidden="true" /><span class="ui-label">{fill(resets.availableCount === 1 ? strings.quotas.bankedReset : strings.quotas.bankedResets, { count: String(resets.availableCount) })}</span></span>
          {@render resetAction?.()}
        </div>
        {#if resets.nextExpiresAt !== null}<small>{fill(strings.quotas.resetExpires, { time: exactTime(resets.nextExpiresAt) })}</small>{/if}
      </div>
    {/if}
    {#if showCredits && credits}
      <div class="credits" data-testid="quota-credits">
        <div class="legend">
          <span class="heading">{#if !compact}<Wallet size={15} aria-hidden="true" />{/if}<span class="ui-label">{headings[credits.kind]}</span></span>
          <span class="amount ui-label">{credits.kind === 'budget' ? budgetLabel : fill(strings.quotas.creditBalance, { count: creditBalance(credits.remaining!) })}</span>
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
  .reset-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
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
  .compact .credits { padding: 0; border: none; border-radius: 0; background: none; gap: 5px; }
  .compact .legend { gap: 8px; }
  .compact .amount { margin-left: auto; font-size: var(--text-xs); font-weight: 400; color: var(--color-muted-foreground); }
  .compact .track { height: 4px; background: var(--color-surface-3); }
</style>
