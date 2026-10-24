<script lang="ts">
  import { untrack } from 'svelte';
  import { Gauge, PinOff, RefreshCw } from '@lucide/svelte';
  import { chipChoice } from '../lib/composer-target';
  import { startPointerDrag } from '../lib/pointer-drag';
  import { quotaReader, shownQuotas, quotaAccountName, quotaCredits, remainingPercent, quotaTone } from '../lib/quota-reader.svelte';
  import { pinnedQuotaRows } from '../lib/pinned-quota-target';
  import { pinnedQuotas, PINNED_QUOTA_WIDTH, type QuotaPosition } from '../lib/pinned-quotas.svelte';
  import { fill, strings } from '../lib/strings';
  import { quotaWindowName, quotaResetTime, tenth } from '../lib/format';
  import type { Store } from '../lib/store.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import QuotaExtras from './QuotaExtras.svelte';

  let { store, dock = false, inline = false, area }: { store: Store; dock?: boolean; inline?: boolean; area?: HTMLElement } = $props();
  let position = $derived(dock ? 'dock' : pinnedQuotas.current.position === 'dock' ? 'bottom-left' : pinnedQuotas.current.position);
  let card: HTMLElement;
  const hintId = $props.id();
  let drag = $state<{ dx: number; dy: number; box: DOMRect } | null>(null);

  // The top layer lets the dragged card cross the chat and rail clipping boundaries.
  $effect(() => {
    if (!drag) return;
    card.setAttribute('popover', 'manual');
    card.showPopover();
    return () => { if (card.isConnected) card.hidePopover(); card.removeAttribute('popover'); };
  });

  function startDrag(event: PointerEvent) {
    if ((event.target as Element).closest('button, a, input, textarea, [role="button"]')) return;
    const x = event.clientX, y = event.clientY;
    startPointerDrag(event, {
      rootClass: 'quota-dragging', hold: 250,
      begin() { drag = { dx: 0, dy: 0, box: card.getBoundingClientRect() }; },
      aim(xNow, yNow) { if (drag) { drag.dx = xNow - x; drag.dy = yNow - y; } },
      end(drop) { drag = null; if (drop && card.isConnected) finishDrag(drop.x, drop.y); },
    });
  }

  function finishDrag(x: number, y: number) {
    const rail = [...document.querySelectorAll<HTMLElement>('[data-quota-dock-target]')].find(element => {
      const box = element.getBoundingClientRect();
      return element.checkVisibility() && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    });
    const discussion = area ?? [...document.querySelectorAll<HTMLElement>('[data-testid="chat"] .discussion')].find(element => element.checkVisibility());
    if (rail) pinnedQuotas.set(true, 'dock');
    else if (discussion) {
      const box = discussion.getBoundingClientRect();
      pinnedQuotas.set(true, `${y < box.top + box.height / 2 ? 'top' : 'bottom'}-${x < box.left + box.width / 2 ? 'left' : 'right'}` as QuotaPosition);
    }
  }

  function moveWithKeys(event: KeyboardEvent) {
    if (event.target !== card) return;
    let next: QuotaPosition;
    const current = position === 'dock' ? 'bottom-left' : position;
    if (event.key === 'Home') next = 'dock';
    else if (event.key === 'ArrowLeft') next = current.startsWith('top') ? 'top-left' : 'bottom-left';
    else if (event.key === 'ArrowRight') next = current.startsWith('top') ? 'top-right' : 'bottom-right';
    else if (event.key === 'ArrowUp') next = current.endsWith('left') ? 'top-left' : 'top-right';
    else if (event.key === 'ArrowDown') next = current.endsWith('left') ? 'bottom-left' : 'bottom-right';
    else if (event.key === 'Escape') { drag = null; return; }
    else return;
    event.preventDefault();
    pinnedQuotas.set(true, next);
  }
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

{#if drag && (dock || inline)}<div aria-hidden="true" style:height={`${drag.box.height}px`} style:flex="none"></div>{/if}
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<aside bind:this={card} class="pinned-quota" class:docked={dock} class:inline class:dragging={!!drag}
  style:--quota-width={`${PINNED_QUOTA_WIDTH}px`} style:transform={drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined}
  style:position={drag ? 'fixed' : undefined} style:top={drag ? `${drag.box.top}px` : undefined}
  style:left={drag ? `${drag.box.left}px` : undefined} style:right={drag ? 'auto' : undefined} style:bottom={drag ? 'auto' : undefined}
  style:width={drag ? `${drag.box.width}px` : undefined} style:margin={drag ? '0' : undefined}
  data-position={position} data-testid="pinned-quota" aria-label={strings.quotas.pinnedTitle} aria-describedby={hintId} tabindex="0"
  onpointerdown={startDrag} onkeydown={moveWithKeys}>
  <header>
    <span id={hintId} class="sr-only">{strings.quotas.dragHint}</span>
    <Gauge size={14} />
    <strong title={store.modelOf(choice)?.name ?? choice?.model ?? ''}>{rows[0]?.providerName ?? strings.quotas.pinnedTitle}</strong>
    <button type="button" class="ghost icon" aria-label={strings.quotas.refresh} title={strings.quotas.refresh} data-testid="pinned-quota-refresh" aria-busy={reader.busy} disabled={!connected || reader.busy} onclick={() => refresh(true)}><RefreshCw size={13} class={reader.busy ? 'spinning' : ''} /></button>
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
  .pinned-quota { position: absolute; z-index: 5; width: min(var(--quota-width), calc(100% - 24px)); max-height: min(320px, calc(100% - 24px)); display: flex; flex-direction: column; overflow: hidden; color: var(--color-foreground); background: color-mix(in srgb, var(--color-surface-2) 92%, transparent); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); box-shadow: var(--shadow-e1); opacity: 0.7; transition: opacity var(--dur-2), background-color var(--dur-2); cursor: grab; touch-action: pan-y; }
  .pinned-quota.dragging { z-index: 100; cursor: grabbing; user-select: none; opacity: 1; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .pinned-quota:hover, .pinned-quota:focus-within { opacity: 1; background: var(--color-surface-2); }
  .pinned-quota[data-position='top-left'] { top: 12px; left: 12px; }
  .pinned-quota[data-position='top-right'] { top: 12px; right: 12px; }
  .pinned-quota[data-position='bottom-left'] { bottom: 12px; left: 12px; }
  .pinned-quota[data-position='bottom-right'] { bottom: 12px; right: 12px; }
  .pinned-quota.docked { position: relative; inset: auto; flex: 0 1 auto; width: auto; min-height: 0; max-height: min(320px, 40%); margin: 6px 10px 0; box-shadow: none; }
  .pinned-quota.inline { position: relative; inset: auto; flex: none; align-self: flex-start; max-height: min(200px, 30%); margin: 4px 12px; }
  header { touch-action: none; display: flex; flex: none; align-items: center; gap: 2px; padding: 1px 4px 1px 8px; border-bottom: 1px solid var(--color-border); }
  header > :global(svg) { flex: none; color: var(--color-muted-foreground); margin-right: 4px; }
  strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 600; }
  header button { width: var(--control-sm); height: var(--control-sm); padding: 0; }
  header :global(.spinning) { animation: spin 900ms linear infinite var(--loops); }
  .body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 0 8px; touch-action: pan-y; }
  article { padding: 4px 0; display: grid; gap: 2px; line-height: 1.25; }
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
  p { margin: 4px 0; font-size: var(--text-xs); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  p.error { color: var(--color-danger); }
  @media (hover: none) { .pinned-quota { opacity: 1; } header button { width: var(--control); height: var(--control); } }
  @media (max-width: 720px) { .pinned-quota { max-height: min(240px, 45%); } }
  @media (prefers-reduced-motion: reduce) { .pinned-quota, .fill { transition: none; } header :global(.spinning) { animation: none; } }
</style>
