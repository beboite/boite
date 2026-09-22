<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import type { AccountQuota } from '@boite/contracts';
  import ProviderLogo from './ProviderLogo.svelte';
  import QuotaList from './QuotaList.svelte';
  import { strings } from '../lib/strings';
  import { weekdayTime } from '../lib/format';
  let { rows, busy = false, configure, connect }: { rows: AccountQuota[]; busy?: boolean; configure: (id: string, enabled: boolean) => void; connect: () => void } = $props();
  const providers = ['claude', 'codex', 'antigravity', 'grok', 'opencode'] as const;
  let expanded = $state<string | null>(null);
  const remaining = (used: number) => strings.quotas.remaining.replace('{percent}', String(Math.round(100 - used)));
  const reset = (at: number) => strings.quotas.resets.replace('{time}', weekdayTime(at));
  const name = (provider: typeof providers[number]) => strings.quotas.names[provider];
</script>

<div class="overview" data-testid="quota-overview">
  {#each providers as provider (provider)}
    {@const accounts = rows.filter((row) => row.providerId === provider && row.status !== 'unsupported')}
    {@const windows = accounts.filter((row) => row.enabled).flatMap((row) => row.windows)}
    {@const used = windows.length ? Math.max(...windows.map((limit) => limit.usedPercent)) : null}
    {@const stale = accounts.some((row) => row.enabled && row.status === 'unavailable')}
    {@const resets = windows.flatMap((limit) => limit.resetsAt === null ? [] : [limit.resetsAt])}
    {@const disabled = accounts.length > 0 && accounts.every((row) => !row.enabled)}
    <article data-testid="quota-provider" data-provider={provider} class:expanded={expanded === provider}>
      <button class="summary ghost" aria-expanded={expanded === provider} aria-controls={`usage-${provider}`} onclick={() => expanded = expanded === provider ? null : provider}>
        <span class="logo"><ProviderLogo providerId={provider} size={19} /></span>
        <span class="content">
          <span class="headline"><span class="name">{name(provider)}</span><span class="amount" class:low={used !== null && used >= 80}>{used !== null ? remaining(used) : disabled ? strings.quotas.off : accounts.length ? strings.quotas.noReading : strings.quotas.notConnected}</span></span>
          {#if windows.length}
            <span class="meters" class:stale>
              {#each windows as limit, index (`${index}:${limit.id}`)}
                <progress max="100" value={100 - limit.usedPercent} class:low={limit.usedPercent >= 80} class:empty={limit.usedPercent >= 100} aria-label={`${name(provider)} ${limit.label}: ${remaining(limit.usedPercent)}`} title={`${limit.label}: ${remaining(limit.usedPercent)}`}></progress>
              {/each}
            </span>
            <span class="caption">{stale ? strings.quotas.stale : resets.length ? reset(Math.min(...resets)) : strings.quotas.noReset}</span>
          {:else}<span class="caption">{provider === 'antigravity' ? strings.quotas.cliSource : strings.quotas.autoConnect}</span>{/if}
        </span>
        <ChevronDown size={13} />
      </button>
      {#if expanded === provider}
        <div class="details" id={`usage-${provider}`}>
          {#if accounts.length === 0}
            <p>{strings.quotas.connectHint.replace('{provider}', name(provider))}</p>
            <button class="small" onclick={connect}>{strings.quotas.connect}</button>
          {:else}
            {#if provider === 'antigravity'}<p>{strings.quotas.cliHint}</p>{/if}
            {#each accounts as account (account.accountId)}
              <label class="monitor"><span>{account.label}</span><input type="checkbox" role="switch" aria-label={`${strings.quotas.monitor}: ${account.label}`} checked={account.enabled} disabled={busy} onchange={(event) => configure(account.accountId, event.currentTarget.checked)} /></label>
            {/each}
            {#if !disabled}<QuotaList rows={accounts} compact />{/if}
            {#if stale}<button class="small ghost" onclick={connect}>{strings.quotas.providers}</button>{/if}
          {/if}
        </div>
      {/if}
    </article>
  {/each}
</div>
<style>
  .overview { display: grid; grid-template-columns: minmax(0, 1fr); }
  article { min-width: 0; }
  article + article { border-top: 1px solid var(--color-border); }
  .summary { width: 100%; height: auto; min-height: 60px; padding: 6px 4px; display: flex; gap: 10px; text-align: left; border-radius: var(--radius-md); white-space: normal; }
  .logo { flex: none; width: 26px; display: grid; place-items: center; }
  .content { flex: 1; min-width: 0; display: grid; gap: 3px; }
  .headline { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .name { font-size: var(--text-base); font-weight: 550; color: var(--color-foreground); }
  .amount { color: var(--color-muted-foreground); font-size: var(--text-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .amount.low { color: var(--color-live); }
  .caption { font-size: var(--text-xs); color: var(--color-muted-foreground); font-weight: 400; }
  .meters { display: flex; gap: 4px; }
  .meters.stale { opacity: 0.45; }
  progress { flex: 1; width: 0; min-width: 0; appearance: none; border: 0; height: 4px; border-radius: var(--radius-sm); overflow: hidden; background: var(--color-surface-3); }
  progress::-webkit-progress-bar { background: var(--color-surface-3); }
  progress::-webkit-progress-value { background: var(--color-success); border-radius: var(--radius-sm); }
  progress::-moz-progress-bar { background: var(--color-success); }
  progress.low::-webkit-progress-value { background: var(--color-live); }
  progress.low::-moz-progress-bar { background: var(--color-live); }
  progress.empty { background: color-mix(in srgb, var(--color-danger) 35%, var(--color-surface-3)); }
  progress.empty::-webkit-progress-bar { background: color-mix(in srgb, var(--color-danger) 35%, var(--color-surface-3)); }
  .summary :global(svg:last-child) { flex: none; color: var(--color-subtle); transition: transform var(--dur-2); }
  .expanded .summary > :global(svg) { transform: rotate(180deg); }
  .details { padding: 0 4px 12px; display: grid; gap: 10px; }
  p { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .monitor { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--text-sm); }
</style>
