<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Minimize2 } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { contextPercent, contextLevel, formatTokens } from '../lib/tokens';
  import { count, time } from '../lib/format';
  import { Closing } from '../lib/closing.svelte';
  let { store }: { store: Store } = $props();
  let submitting = $state(false);
  let root = $state<HTMLDivElement>();
  const popup = new Closing();
  let left = $state(0);
  let top = $state(0);
  let leave: ReturnType<typeof setTimeout> | undefined;
  const thread = $derived(store.openThread);
  const context = $derived(thread?.context ?? null);
  const percent = $derived(context ? contextPercent(context) : null);
  const protocol = $derived(thread ? store.providerOf(thread.providerId)?.protocol : null);
  const supported = $derived(protocol !== 'agy' && (protocol !== 'acp' || thread?.commands?.some(command => command.name === 'compact')));
  const reason = $derived(submitting || store.busy ? strings.composer.compactBusy : !thread?.sessionId
    ? strings.composer.compactNoSession : !supported ? strings.composer.compactUnavailable : null);
  const exact = (n: number) => count(n);
  const segments = $derived(context?.breakdown ? [
    {name: strings.thread.contextInput, count: context.breakdown.input, kind: 'input'},
    {name: strings.thread.contextCache, count: context.breakdown.cache, kind: 'cache'},
    {name: strings.thread.contextOutput, count: context.breakdown.output, kind: 'output'}
  ] : [{name: strings.thread.contextUsed, count: context?.tokens ?? 0, kind: 'input'}]);
  function place() {
    const box = root?.getBoundingClientRect();
    if (!box) return;
    left = Math.max(12, Math.min(box.right - 290, innerWidth - 302));
    top = box.bottom + 8;
  }
  function show() { clearTimeout(leave); place(); popup.show(); }
  function hideLater() { clearTimeout(leave); leave = setTimeout(() => { if (!root?.contains(document.activeElement)) popup.hide(); }, 180); }
  onDestroy(() => clearTimeout(leave));
  async function compact() {
    if (reason || submitting) return;
    submitting = true;
    try { await store.compact(); popup.hide(); } finally { submitting = false; }
  }
</script>

<svelte:window onresize={() => { if (popup.open) place(); }} onpointerdown={event => { if (event.target instanceof Node && !root?.contains(event.target)) popup.hide(); }} onkeydown={event => { if (event.key === 'Escape' && popup.open) { popup.hide(); event.stopPropagation(); } }} />
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="context" bind:this={root} data-testid="context-meter" data-percent={percent ?? ''} data-level={contextLevel(percent)} onmouseenter={show} onmouseleave={hideLater} onfocusin={show} onfocusout={hideLater}>
  <button type="button" class="trigger ghost" data-testid="context-trigger" aria-label={strings.thread.contextDetails} aria-expanded={popup.open} aria-haspopup="dialog" onclick={show}>
    <svg viewBox="0 0 40 40" aria-hidden="true"><circle class="track" cx="20" cy="20" r="17" /><circle class="fill" cx="20" cy="20" r="17" pathLength="100" stroke-dasharray="{percent ?? 0} 100" /></svg>
    {#if context}<span class="amount mono">{percent !== null ? `${percent}%` : formatTokens(context.tokens)}</span>{/if}
  </button>
  {#if popup.shown}
    <div class="popup" style:left={`${left}px`} style:top={`${top}px`} class:closing={popup.closing} role="dialog" aria-label={strings.thread.contextDetails} tabindex="-1" data-testid="context-popup" use:popup.attach onanimationend={popup.end}>
      <div class="heading"><span>{strings.thread.contextDetails}</span>{#if percent !== null}<span class="mono">{percent}%</span>{/if}</div>
      {#if context}
        <p class="total mono">{exact(context.tokens)}{#if context.window !== null}{' / '}{exact(context.window)}{/if}</p>
        <div class="bar" aria-hidden="true">
          {#each segments as segment (segment.kind)}<span class={segment.kind} style:width={`${Math.min(100, segment.count / Math.max(1, context.window ?? context.tokens) * 100)}%`}></span>{/each}
        </div>
        <dl>{#each segments as segment (segment.kind)}<div><dt><i class={segment.kind}></i>{segment.name}</dt><dd class="mono">{exact(segment.count)}</dd></div>{/each}
          {#if context.window !== null}<div><dt><i class="free"></i>{strings.thread.contextFree}</dt><dd class="mono">{exact(Math.max(0, context.window - context.tokens))}</dd></div>{/if}
        </dl>
        {#if !context.breakdown}<p class="note">{strings.thread.contextNoBreakdown}</p>{/if}
        <p class="note">{strings.thread.contextMeasured} · {time(context.at)}</p>
      {:else}<p class="note">{strings.thread.contextNoReading}</p>{/if}
      <button type="button" class="compact" data-testid="context-compact" disabled={reason !== null} title={reason ?? strings.composer.compact} onclick={() => void compact()}><Minimize2 size={14} />{strings.composer.compact}</button>
      {#if reason}<p class="note">{reason}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .context { position: relative; flex: none; color: var(--color-muted-foreground); }
  .trigger { display: flex; align-items: center; gap: 5px; padding: 4px; }
  svg { width: 24px; height: 24px; transform: rotate(-90deg); }
  circle { fill: none; stroke-width: 3; }
  .track { stroke: var(--color-border); }
  .fill { stroke: var(--color-accent); stroke-linecap: round; transition: stroke-dasharray var(--dur-3); }
  .amount { font-size: var(--text-xs); }
  .popup { position: fixed; width: min(290px, calc(100vw - 24px)); z-index: 60; padding: 16px; border-radius: var(--radius-lg); background: var(--color-surface-2); box-shadow: var(--shadow-e3); animation: pop var(--dur-2) var(--ease-out-quint); color: var(--color-foreground); }
  .popup.closing { animation: pop-out var(--dur-2) var(--ease-out-quint); pointer-events: none; }
  .heading { display: flex; justify-content: space-between; font-size: var(--text-sm); font-weight: 600; }
  .total { margin: 8px 0 12px; font-size: var(--text-sm); }
  .bar { display: flex; height: 7px; overflow: hidden; background: var(--color-border); border-radius: var(--radius-sm); }
  .input { background: var(--color-accent); }
  .cache { background: var(--color-success); }
  .output { background: var(--color-live); }
  .free { background: var(--color-border); }
  dl { margin: 12px 0; font-size: var(--text-xs); }
  dl div { display: flex; justify-content: space-between; gap: 16px; margin: 6px 0; }
  dt { display: flex; align-items: center; gap: 7px; color: var(--color-muted-foreground); }
  dd { margin: 0; }
  i { width: 7px; height: 7px; border-radius: var(--radius-sm); }
  .note { font-size: var(--text-xs); line-height: 1.5; color: var(--color-muted-foreground); margin: 8px 0 0; }
  .compact { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; margin-top: 14px; font-size: var(--text-sm); }
</style>
