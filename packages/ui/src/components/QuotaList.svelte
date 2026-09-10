<script lang="ts">
  import type { AccountQuota } from '@boite/contracts';
  import { strings } from '../lib/strings';
  let { rows, compact = false }: { rows: AccountQuota[]; compact?: boolean } = $props();
  const date = (at: number) => new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
</script>

<div class="quota-list" class:compact data-testid="quota-list">
  {#if rows.length === 0}<p class="muted">{strings.quotas.empty}</p>{/if}
  {#each rows as row (row.accountId)}
    <article class="quota" data-testid="quota-account" data-account-id={row.accountId}>
      <header><strong>{row.providerName}</strong><span>{row.label}</span></header>
      {#if row.status === 'unsupported'}<p class="muted">{strings.quotas.unsupported}</p>
      {:else if row.status === 'disabled'}<p class="muted">{strings.quotas.disabled}</p>
      {:else}
        {#each row.windows as limit (limit.id)}
          <div class="limit" class:low={limit.usedPercent >= 80} class:exhausted={limit.usedPercent >= 100}>
            <div class="legend"><span>{limit.label}</span><span class="value">{strings.quotas.remaining.replace('{percent}', String(Math.round((100 - limit.usedPercent) * 10) / 10))}</span></div>
            <progress max="100" value={100 - limit.usedPercent} aria-label={`${row.providerName} ${limit.label}`}></progress>
            {#if limit.resetsAt}<small>{strings.quotas.resets.replace('{time}', date(limit.resetsAt))}</small>{/if}
          </div>
        {/each}
        {#if row.error}<p class="error" role="status">{row.error}</p>{/if}
        {#if row.checkedAt}<small>{row.status === 'ready' ? strings.quotas.checked.replace('{time}', date(row.checkedAt)) : `${strings.quotas.stale} · ${date(row.checkedAt)}`}</small>
        {:else if !row.error}<p class="muted">{strings.quotas.unavailable}</p>{/if}
      {/if}
    </article>
  {/each}
</div>
<style>
  .quota-list { display: grid; gap: 12px; }
  .quota { display: grid; gap: 10px; padding: 16px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); }
  header, .legend { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  header span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  strong { font-size: var(--text-base); font-weight: 600; }
  .limit { display: grid; gap: 5px; }
  .legend { font-size: var(--text-sm); }
  .value { font-variant-numeric: tabular-nums; }
  progress { appearance: none; border: 0; width: 100%; height: 5px; border-radius: var(--radius-sm); overflow: hidden; background: var(--color-surface-3); }
  progress::-webkit-progress-bar { background: var(--color-surface-3); }
  progress::-webkit-progress-value { background: var(--color-success); border-radius: var(--radius-sm); }
  progress::-moz-progress-bar { background: var(--color-success); }
  .low progress::-webkit-progress-value { background: var(--color-live); }
  .low progress::-moz-progress-bar { background: var(--color-live); }
  .exhausted .value { color: var(--color-danger); }
  small, .muted { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  p { margin: 0; }
  .error { color: var(--color-danger); font-size: var(--text-sm); }
  .compact .quota { padding: 12px; }
</style>
