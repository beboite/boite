<script lang="ts">
  import { Gauge, RefreshCw, Settings2, X } from '@lucide/svelte';
  import type { AccountQuota } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import QuotaOverview from './QuotaOverview.svelte';

  let { rows, loading, completed, error = '', owner = true, order = [], reorder, refresh, connect, settings, close, testPrefix = 'quota' }: {
    rows: AccountQuota[] | null;
    loading: boolean;
    completed: string[];
    error?: string;
    owner?: boolean;
    order?: string[];
    reorder?: (order: string[]) => Promise<boolean>;
    refresh: () => void;
    connect: () => void;
    settings: () => void;
    close: () => void;
    testPrefix?: string;
  } = $props();
</script>

<div class="quota-popup" data-testid="quota-panel">
  <header>
    <h2><Gauge size={17} />{strings.quotas.glance}</h2>
    <div class="actions">
      {#if owner}
        <button type="button" class="ghost icon" aria-label={strings.quotas.refresh} title={strings.quotas.refresh} aria-busy={loading} data-testid={`${testPrefix}-refresh`} onclick={refresh}><RefreshCw size={16} class={loading ? 'spinning' : ''} /></button>
      {/if}
      <button type="button" class="ghost icon" aria-label={strings.common.close} title={strings.common.close} onclick={close}><X size={17} /></button>
    </div>
  </header>
  <section class="body">
    {#if !owner}
      <p class="muted">{strings.usage.limitsOwner}</p>
    {:else}
      {#if error}
        <div class="failed" role="alert" data-testid={`${testPrefix}-error`}>
          <p>{fill(strings.quotas.readFailed, { error })}</p>
          <button type="button" class="ghost small" disabled={loading} data-testid={`${testPrefix}-retry`} onclick={refresh}>{strings.quotas.retry}</button>
        </div>
      {/if}
      {#if rows === null}
        <p class="muted" role="status">{strings.quotas.loading}</p>
      {:else if !(error && rows.length === 0)}
        <QuotaOverview {rows} {loading} {completed} {connect} {order} onreorder={reorder} />
      {/if}
    {/if}
  </section>
  <footer>
    <button type="button" class="ghost" data-testid={`${testPrefix}-page`} onclick={settings}><Settings2 size={15} />{strings.quotas.allLimits}</button>
  </footer>
</div>

<style>
  .quota-popup { display: flex; flex-direction: column; min-height: 0; height: 100%; color: var(--color-foreground); background: var(--color-surface-2); }
  header, footer { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 10px 4px 12px; }
  header { border-bottom: 1px solid var(--color-border); }
  footer { border-top: 1px solid var(--color-border); }
  h2 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: var(--text-sm); font-weight: 600; }
  h2 :global(svg) { color: var(--color-muted-foreground); }
  .actions { display: flex; gap: 2px; }
  .body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 8px; }
  footer button { font-size: var(--text-sm); }
  .failed { display: grid; justify-items: start; gap: 8px; padding: 12px 4px; color: var(--color-danger); font-size: var(--text-sm); }
  .failed p { margin: 0; overflow-wrap: anywhere; }
  .muted { margin: 0; padding: 14px 4px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .actions :global(.spinning) { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .actions :global(.spinning) { animation: none; } }
</style>
