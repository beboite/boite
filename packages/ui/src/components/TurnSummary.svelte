<script lang="ts">
  import { Check, Clock, LoaderCircle, Square, CircleAlert } from '@lucide/svelte';
  import type { Message, Turn } from '@boite/contracts';
  import { millis, tokens, cost } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  let { turn, messages, waiting = false }: { turn: Turn; messages: Message[]; waiting?: boolean } = $props();
  let now = $state(Date.now());
  let running = $derived(turn.status === 'running');
  let parts = $derived(messages.filter(m => m.turnId === turn.id && m.role === 'assistant').flatMap(m => m.parts));
  let tools = $derived(parts.filter(p => p.type === 'tool'));
  let activeTool = $derived(tools.findLast(p => p.status === 'running'));
  let last = $derived(parts.at(-1));
  let label = $derived(turn.status === 'done' ? strings.notify.done : turn.status === 'error' ? strings.notify.failed : turn.status === 'stopped' ? strings.chat.stopped : turn.status === 'queued' ? strings.threadStatus.queued : waiting ? strings.notify.needsYou : activeTool ? `${strings.chat.working}: ${activeTool.name}` : last?.type === 'thinking' ? strings.chat.thinking : last?.type === 'text' ? strings.chat.writing : strings.chat.working);
  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
</script>

<div class="summary" class:running class:failed={turn.status === 'error'} data-testid="turn-summary" data-status={turn.status}>
  <span class="state" role="status">
    {#if turn.status === 'done'}<Check size={14} />{:else if turn.status === 'error'}<CircleAlert size={14} />{:else if turn.status === 'stopped'}<Square size={12} />{:else if running}<LoaderCircle size={14} class="spinner" />{:else}<Clock size={14} />{/if}
    {label}
  </span>
  {#if turn.startedAt !== null}<span>{millis(Math.max(0, (turn.finishedAt ?? now) - turn.startedAt))}</span>{/if}
  {#if tools.length}<span>{tools.length === 1 ? strings.chat.toolCall : fill(strings.chat.toolCount, { count: String(tools.length) })}</span>{/if}
  {#if turn.usage}
    <span>{fill(strings.chat.inputTokens, { count: tokens(turn.usage.inputTokens) })}</span>
    <span>{fill(strings.chat.outputTokens, { count: tokens(turn.usage.outputTokens) })}</span>
    {#if turn.usage.costUsdEquivalent !== null}<span>{cost(turn.usage.costUsdEquivalent)}</span>{/if}
  {/if}
</div>

<style>
  .summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin: 12px 0 0 4px; font-size: var(--text-xs); color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  .state { display: inline-flex; align-items: center; gap: 6px; overflow-wrap: anywhere; }
  .state :global(svg) { flex: none; }
  .summary[data-status='done'] .state { color: var(--color-success); }
  .running .state { color: var(--color-accent); }
  .failed .state { color: var(--color-danger); }
  .state :global(.spinner) { animation: spin 1.5s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .state :global(.spinner) { animation: none; } }
</style>
