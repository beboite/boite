<script lang="ts">
  import QuotaExtras from './QuotaExtras.svelte';
  import QuotaWindow from './QuotaWindow.svelte';
  import type { AccountQuota } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { exactTime, weekdayTime } from '../lib/format';
  /** An account's windows, drawn under a row that already names the account. */
  let { rows }: { rows: AccountQuota[] } = $props();
</script>

<div class="quota-list" data-testid="quota-list">
  {#if rows.length === 0}<p class="muted">{strings.quotas.empty}</p>{/if}
  {#each rows as row (row.accountId)}
    <article class="quota" data-testid="quota-account" data-account-id={row.accountId}>
      {#if row.status === 'unsupported'}<p class="muted">{strings.quotas.unsupported}</p>
      {:else if row.status === 'disabled'}<p class="muted">{strings.quotas.disabled}</p>
      {:else}
        {#each row.windows as limit (limit.id)}<QuotaWindow {limit} owner={row.providerName} />{/each}
        <QuotaExtras {row} />
        {#if row.error}<p class="error" role="status">{row.error}</p>{/if}
        {#if row.checkedAt}<small>{row.status === 'ready' ? (row.source === 'observation' ? fill(strings.quotas.observed, { time: exactTime(row.checkedAt) }) : fill(strings.quotas.checked, { time: weekdayTime(row.checkedAt) })) : `${strings.quotas.stale} · ${weekdayTime(row.checkedAt)}`}</small>
        {:else if !row.error}<p class="muted">{strings.quotas.unavailable}</p>{/if}
      {/if}
    </article>
  {/each}
</div>
<style>
  .quota-list { display: grid; gap: 12px; }
  .quota { display: grid; gap: 10px; }
  small, .muted { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  p { margin: 0; }
  .error { color: var(--color-danger); font-size: var(--text-sm); }
</style>
