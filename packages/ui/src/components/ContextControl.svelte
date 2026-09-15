<script lang="ts">
  import { Minimize2 } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { contextPercent, contextLevel, formatTokens } from '../lib/tokens';
  let { store }: { store: Store } = $props();
  let submitting = $state(false);
  const thread = $derived(store.openThread);
  const context = $derived(thread?.context ?? null);
  const percent = $derived(context ? contextPercent(context) : null);
  const protocol = $derived(thread ? store.providerOf(thread.providerId)?.protocol : null);
  const supported = $derived(protocol !== 'acp' || thread?.commands?.some((command) => command.name === 'compact'));
  const reason = $derived(submitting || store.busy ? strings.composer.compactBusy : !thread?.sessionId
    ? strings.composer.compactNoSession : !supported ? strings.composer.compactUnavailable : null);
  const title = $derived(context ? context.window === null || percent === null
    ? strings.thread.contextHintNoWindow.replace('{tokens}', formatTokens(context.tokens))
    : strings.thread.contextHint.replace('{tokens}', formatTokens(context.tokens)).replace('{window}', formatTokens(context.window)).replace('{percent}', String(percent))
    : strings.composer.contextUnknown);
  async function compact() {
    if (reason || submitting) return;
    submitting = true;
    try { await store.compact(); } finally { submitting = false; }
  }
</script>

<div class="context" data-testid="context-meter" data-percent={percent ?? ''} data-level={contextLevel(percent)} title={title}>
  <div class="dial">
    <svg viewBox="0 0 40 40" aria-hidden="true"><circle class="track" cx="20" cy="20" r="17" /><circle class="fill" cx="20" cy="20" r="17" pathLength="100" stroke-dasharray="{percent ?? 0} 100" /></svg>
    <button type="button" class="compact" data-testid="context-compact" disabled={reason !== null} title={reason ?? strings.composer.compact} aria-label={strings.composer.compact} onclick={() => void compact()}><Minimize2 size={15} /></button>
  </div>
  <span class="amount mono">{percent !== null ? `${percent}%` : context ? formatTokens(context.tokens) : '?'}</span>
</div>

<style>
  .context { display: flex; align-items: center; gap: 5px; flex: none; color: var(--color-muted-foreground); }
  .context[data-level='full'] { color: var(--color-danger); }
  .context[data-level='high'] { color: var(--color-foreground); }
  .dial { position: relative; width: 38px; height: 38px; }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); pointer-events: none; }
  circle { fill: none; stroke-width: 2; }
  .track { stroke: var(--color-border); }
  .fill { stroke: currentColor; stroke-linecap: round; transition: stroke-dasharray var(--dur-3); }
  .compact { position: absolute; inset: 5px; display: grid; place-items: center; border: none; border-radius: 50%; padding: 0; background: transparent; color: inherit; }
  .compact:hover:not(:disabled) { background: var(--color-hover); color: var(--color-foreground); }
  .compact:disabled { opacity: .4; }
  .amount { font-size: var(--text-xs); min-width: 2ch; }
</style>
