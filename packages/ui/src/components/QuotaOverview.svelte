<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ChevronDown, RotateCcw } from '@lucide/svelte';
  import type { AccountQuota } from '@boite/contracts';
  import ProviderLogo from './ProviderLogo.svelte';
  import QuotaExtras from './QuotaExtras.svelte';
  import { fill, strings } from '../lib/strings';
  import { creditBalance, exactTime, quotaResetTime, quotaWindowName, tenth } from '../lib/format';
  import { quotaAccountName, quotaCredits } from '../lib/quota-reader.svelte';
  import { shownWindows } from '../lib/quota-display';

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
  let candidate: string | null = null;
  let pressedAt = { x: 0, y: 0 };
  let suppressClick = false;
  let clickTimer = 0;
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
  onDestroy(() => { cancelAnimationFrame(scrolling); clearTimeout(clickTimer); });
  function trackDrag(node: HTMLDivElement) {
    const end = (event: PointerEvent) => finish(event);
    const cancel = (event: PointerEvent) => finish(event, true);
    const lost = (event: PointerEvent) => { if (event.target === node) cancel(event); };
    const click = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    node.addEventListener('lostpointercapture', lost);
    node.addEventListener('click', click, true);
    return { destroy() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      node.removeEventListener('lostpointercapture', lost);
      node.removeEventListener('click', click, true);
    } };
  }
  function start(event: PointerEvent, id: string) {
    if (!onreorder || event.button !== 0 || !event.isPrimary || saving) return;
    // Touch drags start on the name; swiping the bars keeps the list's native scrolling.
    if (event.pointerType === 'touch' && !(event.target as Element).closest('.name')) return;
    (event.currentTarget as HTMLButtonElement).focus({ preventScroll: true });
    pointer = event.pointerId;
    candidate = id;
    original = ordered.map((row) => row.accountId);
    pressedAt = { x: event.clientX, y: event.clientY };
  }
  function move(event: PointerEvent) {
    if (event.pointerId !== pointer || !candidate) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) < 6) return;
      // Capture only an actual drag, keeping a click or tap available for expanding details.
      overview.setPointerCapture(event.pointerId);
      dragging = candidate;
      draft = [...original];
      suppressClick = true;
      scrolling = requestAnimationFrame(scroll);
    }
    event.preventDefault();
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
    candidate = null;
    dragging = null;
    clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => { suppressClick = false; }, 0);
    if (!cancel && ids && ids.some((id, index) => id !== original[index])) void save(ids);
    else draft = null;
  }
  function keyboard(event: KeyboardEvent, id: string) {
    if (!onreorder) return;
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
      <button class="small" onclick={connect}><span class="ui-label">{strings.settings.connectProvider}</span></button>
    </div>
  {/if}
  <!-- The headline is the primary window, never the lowest one; credits still take over once any window runs dry. -->
  {#each ordered as row (row.accountId)}
    {@const name = quotaAccountName(row)}
    {@const shown = shownWindows(row)}
    {@const windows = shown.primary ? [shown.primary, ...shown.others] : []}
    {@const used = shown.primary?.usedPercent ?? null}
    {@const drained = row.windows.some((limit) => limit.usedPercent >= 100)}
    {@const stale = row.status === 'unavailable'}
    {@const resets = windows.flatMap((limit) => limit.resetsAt === null ? [] : [limit.resetsAt])}
    {@const reset = shown.primary?.resetsAt ?? (resets.length ? Math.min(...resets) : null)}
    {@const credits = quotaCredits(row)}
    {@const paid = credits !== null && drained}
    {@const percent = credits?.kind === 'budget' ? Math.max(0, Math.min(100, credits.remaining! / credits.limit! * 100)) : null}
    <article data-testid="quota-provider" data-provider={row.providerId} data-account-id={row.accountId} class:expanded={expanded === row.accountId} class:dragging={dragging === row.accountId}>
      <div class="account-heading">
        <button class="summary ghost" class:reorderable={!!onreorder && !saving} data-testid={onreorder ? 'quota-reorder' : undefined}
          aria-expanded={expanded === row.accountId} aria-controls={`usage-${row.accountId}`} aria-keyshortcuts={onreorder ? 'ArrowUp ArrowDown Home End' : undefined}
          title={onreorder ? fill(strings.quotas.reorder, { name }) : undefined} disabled={saving || (windows.length === 0 && !onreorder)}
          onpointerdown={(event) => start(event, row.accountId)} onkeydown={(event) => keyboard(event, row.accountId)}
          onclick={() => { if (windows.length) expanded = expanded === row.accountId ? null : row.accountId; }}>
          <span class="logo" title={row.providerName}><ProviderLogo providerId={row.providerId} size={20} /></span>
          <span class="summary-content">
            <span class="headline">
              <span class="name ui-label" title={name}>{name}</span>
              {#if !paid && (used !== null || row.windows.length === 0)}<span class="amount ui-label" class:low={used !== null && used >= 80} title={shown.primary ? quotaWindowName(shown.primary.label) : undefined} data-testid="quota-headline">{used === null ? strings.quotas.noReading : `${Math.round(remaining(used))}%`}</span>{/if}
              {#if windows.length}<ChevronDown size={12} />{/if}
            </span>
            {#if paid && credits}
              <span class="paid" data-testid="quota-credits">
                <span class="paid-label ui-label">{credits.enabled === true ? strings.quotas.usingCredits : strings.quotas.creditRemaining}</span>
                <strong class="paid-amount ui-label">{credits.kind === 'balance' ? fill(strings.quotas.creditBalance, { count: creditBalance(credits.remaining!) }) : percent! < 0.1 ? `<${tenth(0.1)}%` : `${tenth(percent!)}%`}</strong>
                {#if percent !== null}<span class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-busy={loading && !completed.includes(row.accountId)} aria-label={strings.quotas.budgetRemaining}><span class="fill" style:width="{percent}%"></span></span>{/if}
              </span>
            {:else if windows.length && expanded !== row.accountId}
              <span class="meters" class:stale>
                {#each windows as limit, index (limit.id)}
                  <span class="mini-window" class:lead={index === 0 && windows.length > 1} title={`${quotaWindowName(limit.label)}: ${left(limit.usedPercent)}`}>
                    <span class="mini-label ui-label">{miniName(limit.label)}</span>
                    <span class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining(limit.usedPercent)} aria-busy={loading && !completed.includes(row.accountId)} class:low={limit.usedPercent >= 80} class:drained={limit.usedPercent >= 100} aria-label={`${name} ${quotaWindowName(limit.label)}: ${left(limit.usedPercent)}`}><span class="fill" style:width="{remaining(limit.usedPercent)}%"></span></span>
                  </span>
                {/each}
              </span>
            {/if}
            {#if stale}<span class="caption">{strings.quotas.stale}</span>
            {:else if reset !== null && expanded !== row.accountId}
              <span class="caption reset" title={fill(strings.quotas.resets, { time: exactTime(reset) })}><RotateCcw size={12} aria-hidden="true" /><span class="ui-label">{quotaResetTime(reset)}</span></span>
            {/if}
          </span>
        </button>
      </div>
      {#if row.source === 'observation' && row.checkedAt !== null}<p class="caption">{fill(strings.quotas.observed, { time: exactTime(row.checkedAt) })}</p>{/if}
      {#if !paid}<div class="extras"><QuotaExtras {row} compact /></div>{/if}
      {#if row.error}<p class="error" role="status">{row.error}</p>{/if}
      {#if expanded === row.accountId}
        <div class="details" id={`usage-${row.accountId}`}>
          {#each windows as limit (limit.id)}
            <div class="window" class:low={limit.usedPercent >= 80}>
              <span class="window-name">{quotaWindowName(limit.label)}</span>
              <span class="window-left">{left(limit.usedPercent)}</span>
              <span class="track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining(limit.usedPercent)} aria-label={`${name} ${quotaWindowName(limit.label)}`} aria-busy={loading && !completed.includes(row.accountId)} class:low={limit.usedPercent >= 80} class:drained={limit.usedPercent >= 100}><span class="fill" style:width="{remaining(limit.usedPercent)}%"></span></span>
              {#if limit.resetsAt !== null}<span class="caption reset" title={fill(strings.quotas.resets, { time: exactTime(limit.resetsAt) })}><RotateCcw size={13} aria-hidden="true" /><span class="ui-label">{quotaResetTime(limit.resetsAt)}</span></span>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </article>
  {/each}
</div>

<style>
  .overview { display: grid; grid-template-columns: minmax(0, 1fr); }
  article { min-width: 0; padding: 4px 0; }
  article + article { border-top: 1px solid var(--color-border); }
  article.dragging { background: var(--color-accent-soft); outline: 1px solid var(--color-accent); }
  .account-heading { display: flex; align-items: stretch; gap: 2px; }
  .summary { flex: 1; min-width: 0; width: 100%; height: auto; min-height: 44px; padding: 2px 4px; line-height: 1.2; display: flex; align-items: start; gap: 8px; text-align: left; border-radius: var(--radius-md); white-space: normal; }
  .summary:disabled { opacity: 1; cursor: default; }
  .logo { flex: none; width: 20px; height: 20px; display: grid; place-items: center; }
  .summary-content { flex: 1; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .headline { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 20px; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-base); font-weight: 600; color: var(--color-foreground); }
  .amount { flex: none; color: var(--color-foreground); font-size: var(--text-md); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .amount.low { color: var(--color-live); }
  .headline > :global(svg) { flex: none; color: var(--color-subtle); transition: transform var(--dur-2); }
  .expanded .headline > :global(svg) { transform: rotate(180deg); }
  .summary.reorderable { cursor: grab; }
  .summary.reorderable .name { touch-action: none; }
  .dragging .summary { cursor: grabbing; }
  .meters { display: flex; flex-wrap: wrap; gap: 3px 8px; }
  .mini-window { flex: 1 1 84px; min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px; align-items: center; }
  .mini-label { max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 400; }
  .meters.stale { opacity: 0.45; }
  /* The window the headline reads. */
  .mini-window.lead .mini-label { color: var(--color-foreground); font-weight: 500; }
  .track { display: block; width: 100%; min-width: 0; height: 7px; border-radius: var(--radius-sm); overflow: hidden; background: var(--color-surface-3); filter: saturate(1); transition: filter var(--dur-3) var(--ease-out-quint); }
  .fill { display: block; height: 100%; background: var(--color-success); border-radius: var(--radius-sm); transition: width var(--dur-3) var(--ease-out-quint), background-color var(--dur-3) var(--ease-out-quint); }
  .track.low .fill { background: var(--color-live); }
  .track.drained { background: color-mix(in srgb, var(--color-danger) 35%, var(--color-surface-3)); }
  .caption { display: block; margin: 0; font-size: var(--text-xs); color: var(--color-muted-foreground); font-weight: 400; overflow-wrap: anywhere; }
  article > .caption { margin: 4px 4px 0 32px; }
  .reset { display: flex; align-items: center; gap: 5px; }
  .reset :global(svg) { flex: none; }
  .paid { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 3px 8px; }
  .paid-label { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .paid-amount { color: var(--color-success); font-size: var(--text-lg); font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .paid .track { grid-column: 1 / -1; }
  .extras { padding: 4px 4px 0 32px; }
  .extras:not(:has(> :global(*))) { display: none; }
  .error { margin: 4px 4px 0 32px; color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .details { margin: 6px 4px 0 32px; display: grid; gap: 10px; animation: rise var(--dur-2) var(--ease-out-quint); }
  .window { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 8px; font-size: var(--text-sm); }
  .window .track, .window .caption { grid-column: 1 / -1; }
  .window .caption { margin: 0; }
  .window-left { font-variant-numeric: tabular-nums; color: var(--color-muted-foreground); }
  .window.low .window-left { color: var(--color-live); }
  .empty { display: grid; justify-items: start; gap: 10px; padding: 16px 4px; }
  .empty p { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  /* The reading on screen is the previous one until the new one lands: grey, breathing. */
  .track[aria-busy='true'] { filter: saturate(0.15); }
  .track[aria-busy='true'] .fill { animation: breathe 1.1s ease-in-out infinite alternate; }
  @keyframes rise { from { opacity: 0; transform: translateY(-4px); } }
  @keyframes breathe { to { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .details, .track[aria-busy='true'] .fill { animation: none; } .track, .fill { transition: none; } }
  :global(html[data-motion='reduced']) .track[aria-busy='true'] .fill { animation: none; }
</style>
