<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ChevronDown, GripVertical, RotateCcw } from '@lucide/svelte';
  import type { AccountQuota } from '@boite/contracts';
  import ProviderLogo from './ProviderLogo.svelte';
  import QuotaExtras from './QuotaExtras.svelte';
  import { fill, strings } from '../lib/strings';
  import { creditBalance, exactTime, quotaResetTime, quotaWindowName, tenth } from '../lib/format';
  import { quotaAccountName, quotaCredits } from '../lib/quota-reader.svelte';

  let { rows, loading = false, completed = [], connect, order = [], onreorder }: {
    rows: AccountQuota[]; loading?: boolean; completed?: string[]; connect: () => void;
    order?: string[]; onreorder?: (order: string[]) => Promise<boolean>;
  } = $props();

  let expanded = $state<string | null>(null);
  let overview: HTMLDivElement;
  let draft = $state<string[] | null>(null);
  let dragging = $state<string | null>(null);
  let saving = $state(false);
  let pointer: number | null = null;
  let original: string[] = [];
  let lastPoint = { x: 0, y: 0 };
  let scrolling = 0;
  let ordered = $derived.by(() => {
    const priority = new Map((draft ?? order).map((id, index) => [id, index]));
    return [...rows].sort((a, b) => (priority.get(a.accountId) ?? Infinity) - (priority.get(b.accountId) ?? Infinity));
  });
  const left = (used: number) => fill(strings.quotas.remaining, { percent: String(Math.max(0, Math.round(100 - used))) });
  const miniName = (label: string) => label.includes(' · ') ? label.split(' · ').slice(1).join(' · ') :
    label === 'Weekly' ? strings.quotas.windowWeeklyCompact : label === 'Monthly' ? strings.quotas.windowMonthlyCompact : quotaWindowName(label);
  const remaining = (used: number) => Math.max(0, Math.min(100, 100 - used));

  async function save(ids: string[]) {
    if (!onreorder) return;
    saving = true;
    try { await onreorder([...ids, ...order.filter((id) => !ids.includes(id))]); }
    finally { saving = false; draft = null; }
  }
  function scroll() {
    if (!dragging) return;
    const body = overview.closest<HTMLElement>('.body');
    if (body) {
      const box = body.getBoundingClientRect();
      const delta = lastPoint.y < box.top + 32 ? -8 : lastPoint.y > box.bottom - 32 ? 8 : 0;
      if (delta) { body.scrollTop += delta; place(lastPoint.x, lastPoint.y); }
    }
    scrolling = requestAnimationFrame(scroll);
  }
  onDestroy(() => cancelAnimationFrame(scrolling));
  function trackDrag(node: HTMLDivElement) {
    const end = (event: PointerEvent) => finish(event);
    const cancel = (event: PointerEvent) => finish(event, true);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', cancel);
    node.addEventListener('lostpointercapture', cancel);
    return { destroy() {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('lostpointercapture', cancel);
    } };
  }
  function start(event: PointerEvent, id: string) {
    if (event.button !== 0 || !event.isPrimary || saving) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLButtonElement;
    handle.focus({ preventScroll: true });
    // The list stays mounted while keyed rows move, so the capture survives reordering and scrolling.
    overview.setPointerCapture(event.pointerId);
    pointer = event.pointerId;
    dragging = id;
    original = ordered.map((row) => row.accountId);
    draft = [...original];
    lastPoint = { x: event.clientX, y: event.clientY };
    scrolling = requestAnimationFrame(scroll);
  }
  function move(event: PointerEvent) {
    if (event.pointerId !== pointer || !dragging || !draft) return;
    lastPoint = { x: event.clientX, y: event.clientY };
    place(event.clientX, event.clientY);
  }
  function place(x: number, y: number) {
    if (!dragging || !draft) return;
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-testid="quota-provider"]');
    if (!target || !overview.contains(target) || target.dataset.accountId === dragging) return;
    const ids = draft.filter((id) => id !== dragging);
    const index = ids.indexOf(target.dataset.accountId!);
    if (index < 0) return;
    const box = target.getBoundingClientRect();
    ids.splice(index + (y > box.top + box.height / 2 ? 1 : 0), 0, dragging);
    draft = ids;
  }
  function finish(event: PointerEvent, cancel = false) {
    if (event.pointerId !== pointer) return;
    cancelAnimationFrame(scrolling);
    const ids = draft;
    pointer = null;
    dragging = null;
    if (!cancel && ids && ids.some((id, index) => id !== original[index])) void save(ids);
    else draft = null;
  }
  function keyboard(event: KeyboardEvent, id: string) {
    const ids = ordered.map((row) => row.accountId);
    const from = ids.indexOf(id);
    const to = event.key === 'ArrowUp' ? from - 1 : event.key === 'ArrowDown' ? from + 1 :
      event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : -1;
    if (to < 0 || to >= ids.length || saving) return;
    event.preventDefault();
    event.stopPropagation();
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    draft = ids;
    void save(ids);
  }
</script>

<div class="overview" class:loading bind:this={overview} use:trackDrag data-testid="quota-overview">
  {#if rows.length === 0}
    <div class="empty" data-testid="quota-empty">
      <p>{strings.quotas.empty}</p>
      <button class="small" onclick={connect}>{strings.settings.connectProvider}</button>
    </div>
  {/if}
  {#each ordered as row (row.accountId)}
    {@const name = quotaAccountName(row)}
    {@const used = row.windows.length ? Math.max(...row.windows.map((limit) => limit.usedPercent)) : null}
    {@const stale = row.status === 'unavailable'}
    {@const resets = row.windows.flatMap((limit) => limit.resetsAt === null ? [] : [limit.resetsAt])}
    {@const credits = quotaCredits(row)}
    {@const paid = credits !== null && used !== null && used >= 100}
    {@const percent = credits?.kind === 'budget' ? Math.max(0, Math.min(100, credits.remaining! / credits.limit! * 100)) : null}
    <article data-testid="quota-provider" data-provider={row.providerId} data-account-id={row.accountId} class:expanded={expanded === row.accountId} class:dragging={dragging === row.accountId}>
      <div class="account-heading">
        <button class="summary ghost" aria-expanded={expanded === row.accountId} aria-controls={`usage-${row.accountId}`} disabled={row.windows.length === 0} onclick={() => (expanded = expanded === row.accountId ? null : row.accountId)}>
          <span class="logo" title={row.providerName}><ProviderLogo providerId={row.providerId} size={23} /></span>
          <span class="name" title={name}>{name}</span>
          {#if !paid}<span class="amount" class:low={used !== null && used >= 80}>{used === null ? strings.quotas.noReading : `${Math.round(remaining(used))}%`}</span>{/if}
          {#if row.windows.length}<ChevronDown size={14} />{/if}
        </button>
        {#if onreorder}
          <button type="button" class="ghost reorder" data-testid="quota-reorder" aria-label={fill(strings.quotas.reorder, { name })} title={fill(strings.quotas.reorder, { name })} disabled={saving} aria-pressed={dragging === row.accountId}
            onpointerdown={(event) => start(event, row.accountId)} onkeydown={(event) => keyboard(event, row.accountId)}><GripVertical size={16} /></button>
        {/if}
      </div>
      {#if paid && credits}
        <div class="paid" data-testid="quota-credits">
          <span class="paid-label">{credits.enabled === true ? strings.quotas.usingCredits : strings.quotas.creditRemaining}</span>
          <strong class="paid-amount">{credits.kind === 'balance' ? fill(strings.quotas.creditBalance, { count: creditBalance(credits.remaining!) }) : percent! < 0.1 ? `<${tenth(0.1)}%` : `${tenth(percent!)}%`}</strong>
          {#if percent !== null}<span class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-busy={loading && !completed.includes(row.accountId)} aria-label={strings.quotas.budgetRemaining}><span class="fill" style:width="{percent}%"></span></span>{/if}
        </div>
      {:else if row.windows.length && expanded !== row.accountId}
        <div class="meters" class:stale>
          {#each row.windows as limit (limit.id)}
            <div class="mini-window" title={`${quotaWindowName(limit.label)}: ${left(limit.usedPercent)}`}>
              <span class="mini-label">{miniName(limit.label)}</span>
              <span class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining(limit.usedPercent)} aria-busy={loading && !completed.includes(row.accountId)} class:low={limit.usedPercent >= 80} class:drained={limit.usedPercent >= 100} aria-label={`${name} ${quotaWindowName(limit.label)}: ${left(limit.usedPercent)}`}><span class="fill" style:width="{remaining(limit.usedPercent)}%"></span></span>
            </div>
          {/each}
        </div>
      {/if}
      {#if stale}<p class="caption">{strings.quotas.stale}</p>
      {:else if resets.length && expanded !== row.accountId}
        <span class="caption reset" title={fill(strings.quotas.resets, { time: exactTime(Math.min(...resets)) })}><RotateCcw size={13} aria-hidden="true" />{quotaResetTime(Math.min(...resets))}</span>
      {/if}
      {#if row.source === 'observation' && row.checkedAt !== null}<p class="caption">{fill(strings.quotas.observed, { time: exactTime(row.checkedAt) })}</p>{/if}
      {#if !paid}<div class="extras"><QuotaExtras {row} compact /></div>{/if}
      {#if row.error}<p class="error" role="status">{row.error}</p>{/if}
      {#if expanded === row.accountId}
        <div class="details" id={`usage-${row.accountId}`}>
          {#each row.windows as limit (limit.id)}
            <div class="window" class:low={limit.usedPercent >= 80}>
              <span class="window-name">{quotaWindowName(limit.label)}</span>
              <span class="window-left">{left(limit.usedPercent)}</span>
              <span class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining(limit.usedPercent)} aria-label={`${name} ${quotaWindowName(limit.label)}`} aria-busy={loading && !completed.includes(row.accountId)} class:low={limit.usedPercent >= 80} class:drained={limit.usedPercent >= 100}><span class="fill" style:width="{remaining(limit.usedPercent)}%"></span></span>
              {#if limit.resetsAt !== null}<span class="caption reset" title={fill(strings.quotas.resets, { time: exactTime(limit.resetsAt) })}><RotateCcw size={13} aria-hidden="true" />{quotaResetTime(limit.resetsAt)}</span>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </article>
  {/each}
</div>

<style>
  .overview { display: grid; grid-template-columns: minmax(0, 1fr); }
  article { min-width: 0; padding: 12px 0; border-radius: var(--radius-md); }
  article + article { border-top: 1px solid var(--color-border); }
  article.dragging { background: var(--color-accent-soft); outline: 1px solid var(--color-accent); }
  .account-heading { display: flex; align-items: center; gap: 2px; }
  .summary { flex: 1; min-width: 0; width: 100%; height: auto; min-height: 36px; padding: 2px 4px; line-height: 1.2; display: flex; gap: 10px; text-align: left; border-radius: var(--radius-md); white-space: normal; }
  .summary:disabled { opacity: 1; cursor: default; }
  .logo { flex: none; width: 26px; display: grid; place-items: center; }
  .name { flex: 1; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow-wrap: anywhere; font-size: var(--text-base); font-weight: 600; color: var(--color-foreground); }
  .amount { flex: none; color: var(--color-foreground); font-size: calc(var(--text-base) * 1.5); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .amount.low { color: var(--color-live); }
  .summary > :global(svg) { flex: none; color: var(--color-subtle); transition: transform var(--dur-2); }
  .expanded .summary > :global(svg) { transform: rotate(180deg); }
  .reorder { flex: none; width: 24px; min-width: 24px; padding: 0; height: 36px; color: var(--color-subtle); cursor: grab; touch-action: none; }
  .reorder:active { cursor: grabbing; }
  .meters, .details, .paid { margin: 6px 4px 0 40px; display: grid; gap: 8px; }
  .mini-window { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; align-items: center; }
  .mini-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 400; }
  .meters.stale { opacity: 0.45; }
  .track { display: block; width: 100%; min-width: 0; height: 10px; border-radius: var(--radius-sm); overflow: hidden; background: var(--color-surface-3); filter: saturate(1); transition: filter var(--dur-3) var(--ease-out-quint); }
  .fill { display: block; height: 100%; background: var(--color-success); border-radius: var(--radius-sm); transition: width var(--dur-3) var(--ease-out-quint), background-color var(--dur-3) var(--ease-out-quint); }
  .track.low .fill { background: var(--color-live); }
  .track.drained { background: color-mix(in srgb, var(--color-danger) 35%, var(--color-surface-3)); }
  .caption { display: block; margin: 8px 4px 0 40px; font-size: var(--text-xs); color: var(--color-muted-foreground); font-weight: 400; overflow-wrap: anywhere; }
  .reset { display: flex; align-items: center; gap: 6px; }
  .reset :global(svg) { flex: none; }
  .paid { gap: 5px; }
  .paid-label { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .paid-amount { color: var(--color-success); font-size: calc(var(--text-base) * 1.5); font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .paid .track { margin-top: 3px; }
  .extras { padding: 8px 4px 0 40px; }
  .extras:not(:has(> :global(*))) { display: none; }
  .error { margin: 8px 4px 0 40px; color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .details { margin-top: 12px; gap: 14px; animation: rise var(--dur-2) var(--ease-out-quint); }
  .window { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 8px; font-size: var(--text-sm); }
  .window .track, .window .caption { grid-column: 1 / -1; }
  .window .caption { margin: 0; }
  .window-left { font-variant-numeric: tabular-nums; color: var(--color-muted-foreground); }
  .window.low .window-left { color: var(--color-live); }
  .empty { display: grid; justify-items: start; gap: 10px; padding: 16px 4px; }
  .empty p { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .track[aria-busy='true'] { filter: saturate(0.15); }
  @keyframes rise { from { opacity: 0; transform: translateY(-4px); } }
  @media (pointer: coarse) { .reorder { width: 36px; min-width: 36px; height: 44px; } }
  @media (prefers-reduced-motion: reduce) { .details { animation: none; } .track, .fill { transition: none; } }
</style>
