<script lang="ts">
  import { CalendarClock, ChevronRight, Zap } from '@lucide/svelte';
  import type { Message, MessagePart } from '@boite/contracts';
  import { clockTime, fullTime } from '../lib/format';
  import { promptText } from '../lib/message-display';
  import { strings } from '../lib/strings';

  /**
   * A turn the core started on a persistent agent's thread by itself: a
   * routine came due, or something happened on its desk or in its projects.
   * It opens with one thin divider across the column, the label the core
   * gave it, its icon and its time on it, in place of a prompt bubble the
   * user never wrote. The prompt the agent read unfolds under it.
   */
  let { message, kind }: { message: Message; kind: 'routine' | 'event' } = $props();
  let open = $state(false);
  const part = $derived(message.parts.find((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text'));
  const label = $derived(part ? promptText(part).trim() || strings.chat.wake[kind] : strings.chat.wake[kind]);
  /** What the agent read, when it says more than the label. */
  const prompt = $derived(part && part.text.trim() !== label ? part.text.trim() : '');
</script>

<div class="wake" data-kind={kind} data-testid="wake-marker">
  <span class="rule"></span>
  <button type="button" class="ghost small label" aria-expanded={prompt ? open : undefined} disabled={!prompt} title={prompt ? (open ? strings.chat.wakeHide : strings.chat.wakeShow) : undefined} onclick={() => (open = !open)}>
    {#if kind === 'routine'}<CalendarClock size={13} strokeWidth={1.75} />{:else}<Zap size={13} strokeWidth={1.75} />{/if}
    <span class="ui-label text">{label}</span>
    <time datetime={new Date(message.createdAt).toISOString()} title={fullTime(message.createdAt)}>{clockTime(message.createdAt)}</time>
    {#if prompt}<span class="fold-caret" class:open aria-hidden="true"><ChevronRight size={12} /></span>{/if}
  </button>
  <span class="rule"></span>
</div>
{#if prompt}
  <div class="fold" class:open>
    <div class="inner"><p class="prompt" data-testid="wake-prompt">{prompt}</p></div>
  </div>
{/if}

<style>
  .wake {
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 4px 0;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .rule { flex: 1; min-width: 12px; height: 1px; background: var(--color-border); }
  .label {
    flex: 0 1 auto;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: auto;
    min-height: var(--control-sm);
    padding: 2px 4px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .label:disabled { opacity: 1; cursor: default; }
  .label:hover:not(:disabled), .label:focus-visible { background: none; }
  .label:hover:not(:disabled) .text, .label:focus-visible .text { color: var(--color-foreground); }
  .label :global(svg) { color: var(--color-subtle); }
  .wake[data-kind='event'] .label :global(svg) { color: var(--color-live); }
  .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); transition: color var(--dur-2) var(--ease-out-quint); }
  time { flex: none; color: var(--color-subtle); font-variant-numeric: tabular-nums; }
  .fold { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dur-3) var(--ease-out-quint); }
  .fold.open { grid-template-rows: 1fr; }
  .inner { min-height: 0; overflow: hidden; }
  .prompt {
    margin: 0 0 8px;
    padding: 8px 12px;
    border-left: 2px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
