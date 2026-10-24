<script lang="ts">
  import { untrack } from 'svelte';
  import { Gauge, MoveUpLeft, MoveUpRight, MoveDownLeft, MoveDownRight, PanelBottom, PinOff, RefreshCw, Move } from '@lucide/svelte';
  import { chipChoice } from '../lib/composer-target';
  import { quotaReader, shownQuotas, quotaAccountName, quotaCredits, remainingPercent, quotaTone } from '../lib/quota-reader.svelte';
  import { pinnedQuotaRows } from '../lib/pinned-quota-target';
  import { pinnedQuotas, QUOTA_POSITIONS, type QuotaPosition } from '../lib/pinned-quotas.svelte';
  import { fill, strings } from '../lib/strings';
  import { quotaWindowName, quotaResetTime, tenth } from '../lib/format';
  import type { Store } from '../lib/store.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import Menu from './Menu.svelte';
  import QuotaExtras from './QuotaExtras.svelte';

  let { store, dock = false }: { store: Store; dock?: boolean } = $props();
  const glyphs = { 'top-left': MoveUpLeft, 'top-right': MoveUpRight, 'bottom-left': MoveDownLeft, 'bottom-right': MoveDownRight, dock: PanelBottom };
  let position = $derived(pinnedQuotas.current.position === 'dock' && !dock ? 'bottom-left' : pinnedQuotas.current.position);
  let places = $derived(QUOTA_POSITIONS.map(id => ({ id, label: strings.quotas.positions[id], glyph: glyphs[id], active: pinnedQuotas.current.position === id })));
  let choice = $derived(chipChoice(store, store.openThread, null));
  let provider = $derived(choice ? store.providerOf(choice.providerId) : null);
  let reader = $derived(quotaReader(store.endpointUrl ?? 'here', store.core));
  let rows = $derived(pinnedQuotaRows(shownQuotas(reader.rows ?? [], store.accounts, store.providers), choice, provider, store.settings));
  let ordered = $derived.by(() => {
    const priority = new Map((store.settings?.quotaOrder ?? []).map((id, index) => [id, index]));
    return [...rows].sort((a, b) => (priority.get(a.accountId) ?? Infinity) - (priority.get(b.accountId) ?? Infinity));
  });
  let connected = $derived(store.connection === 'ready');

  function refresh(force = false) {
    if (store.client && connected && !reader.loading) void reader.read(store.client, force && store.owner).catch(() => {});
  }

  $effect(() => {
    const client = store.client;
    const current = reader;
    // Changing the gateway changes the source, even when the machine stays the same.
    void store.settings?.subscriptionProxy;
    if (!client || !connected) return;
    const off = client.on('quotas.updated', value => current.accept(value));
    untrack(() => refresh());
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && store.visible) untrack(() => refresh());
    }, 60_000);
    return () => { off(); clearInterval(timer); };
  });
</script>

<aside class="pinned-quota" class:docked={dock} data-position={position} data-testid="pinned-quota" aria-label={strings.quotas.pinnedTitle}>
  <header>
    <Gauge size={14} />
    <strong title={store.modelOf(choice)?.name ?? choice?.model ?? ''}>{rows[0]?.providerName ?? strings.quotas.pinnedTitle}</strong>
    <button type="button" class="ghost icon" aria-label={strings.quotas.refresh} title={strings.quotas.refresh} data-testid="pinned-quota-refresh" aria-busy={reader.busy} disabled={!connected || reader.busy} onclick={() => refresh(true)}><RefreshCw size={13} class={reader.busy ? 'spinning' : ''} /></button>
    <Menu items={places} onpick={id => pinnedQuotas.set(true, id as QuotaPosition)} variant="ghost" label={strings.quotas.position} testid="pinned-quota-position">
      <Move size={14} />
    </Menu>
    <button type="button" class="ghost icon" aria-label={strings.quotas.unpin} title={strings.quotas.unpin} data-testid="pinned-quota-unpin" onclick={() => pinnedQuotas.set(false)}><PinOff size={14} /></button>
  </header>
  <div class="body">
    {#if !connected}<p role="status">{strings.connection.unavailable}</p>{/if}
    {#if reader.error}<p class="error" role="alert">{fill(strings.quotas.readFailed, { error: reader.error })}</p>{/if}
    {#if reader.outdated}<p>{strings.quotas.outdated}</p>
    {:else if reader.rows === null}<p role="status">{strings.quotas.loading}</p>
    {:else if rows.length === 0}<p>{strings.quotas.pinnedEmpty}</p>{/if}
    {#each ordered as row (row.accountId)}
      <article data-testid="pinned-quota-account" data-account-id={row.accountId} data-provider={row.providerId} class:stale={row.status === 'unavailable'}>
        <div class="account"><ProviderLogo providerId={row.providerId} size={14} /><span class="ui-label" title={quotaAccountName(row)}>{quotaAccountName(row)}</span></div>
        {#each row.windows as window (window.id)}
          {@const left = remainingPercent(window.usedPercent)}
          <div class="window" title={window.resetsAt === null ? strings.quotas.noReset : fill(strings.quotas.resets, { time: quotaResetTime(window.resetsAt) })}>
            <span class="name ui-label" title={quotaWindowName(window.label)}>{quotaWindowName(window.label)}</span>
            <span class="track" role="meter" aria-label={`${quotaAccountName(row)} ${quotaWindowName(window.label)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-busy={reader.busy && !reader.landed.includes(row.accountId)} data-tone={quotaTone(window.usedPercent)}><span class="fill" style:width={`${left}%`}></span></span>
            <span class="amount" data-tone={quotaTone(window.usedPercent)}>{tenth(left)}%</span>
          </div>
        {/each}
        <QuotaExtras {row} compact />
        {#if row.error}<p class="error" role="status">{row.error}</p>
        {:else if row.windows.length === 0 && quotaCredits(row) === null}<p>{strings.quotas.noReading}</p>{/if}
      </article>
    {/each}
  </div>
</aside>

<style>
  .pinned-quota { position: absolute; z-index: 5; width: min(280px, calc(100% - 24px)); max-height: min(320px, calc(100% - 24px)); display: flex; flex-direction: column; overflow: hidden; color: var(--color-foreground); background: color-mix(in srgb, var(--color-surface-2) 92%, transparent); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); box-shadow: var(--shadow-e1); opacity: 0.7; transition: opacity var(--dur-2), background-color var(--dur-2); }
  .pinned-quota:hover, .pinned-quota:focus-within { opacity: 1; background: var(--color-surface-2); }
  .pinned-quota[data-position='top-left'] { top: 12px; left: 12px; }
  .pinned-quota[data-position='top-right'] { top: 12px; right: 12px; }
  .pinned-quota[data-position='bottom-left'] { bottom: 12px; left: 12px; }
  .pinned-quota[data-position='bottom-right'] { bottom: 12px; right: 12px; }
  .pinned-quota.docked { position: relative; inset: auto; flex: 0 1 auto; width: auto; min-height: 0; max-height: min(320px, 40%); margin: 6px 10px 0; box-shadow: none; }
  header { display: flex; flex: none; align-items: center; gap: 2px; padding: 4px 6px 4px 10px; border-bottom: 1px solid var(--color-border); }
  header > :global(svg) { flex: none; color: var(--color-muted-foreground); margin-right: 4px; }
  strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 600; }
  header button, header :global(.trigger) { width: var(--control-sm); height: var(--control-sm); padding: 0; }
  header :global(.spinning) { animation: spin 900ms linear infinite var(--loops); }
  .body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 2px 10px; }
  article { padding: 7px 0; display: grid; gap: 5px; }
  article + article { border-top: 1px solid var(--color-border); }
  .account { display: flex; gap: 6px; align-items: center; font-size: var(--text-sm); font-weight: 500; }
  .account :global(svg) { flex: none; }
  .account span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .window { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1fr) 3.3em; align-items: center; gap: 8px; font-size: var(--text-xs); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); }
  .amount { text-align: right; font-variant-numeric: tabular-nums; }
  .amount[data-tone='low'], .amount[data-tone='out'] { color: var(--color-live); }
  .track { height: 4px; overflow: hidden; background: var(--color-surface-3); border-radius: var(--radius-sm); }
  .fill { display: block; height: 100%; background: var(--color-success); border-radius: inherit; transition: width var(--dur-3); }
  .track[data-tone='low'] .fill { background: var(--color-live); }
  .track[data-tone='out'] { background: color-mix(in srgb, var(--color-danger) 35%, var(--color-surface-3)); }
  .track[aria-busy='true'] { filter: saturate(0.15); }
  .stale .track { opacity: 0.45; }
  p { margin: 8px 0; font-size: var(--text-xs); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  p.error { color: var(--color-danger); }
  @media (hover: none) { .pinned-quota { opacity: 1; } header button, header :global(.trigger) { width: var(--control); height: var(--control); } }
  @media (max-width: 720px) { .pinned-quota { max-height: min(240px, 45%); } }
  @media (prefers-reduced-motion: reduce) { .pinned-quota, .fill { transition: none; } header :global(.spinning) { animation: none; } }
</style>
