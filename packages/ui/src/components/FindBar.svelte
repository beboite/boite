<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { ChevronDown, ChevronUp, X } from '@lucide/svelte';
  import type { Message } from '@boite/contracts';
  import { clearFind, findHits, findRanges, paintFind } from '../lib/find';
  import { fill, strings } from '../lib/strings';

  /**
   * Ctrl+F over the open thread. The count comes from the messages, so a match
   * the window has not drawn yet is counted; the arrows jump to its message and
   * the page paints what is drawn. Enter goes down, Shift+Enter up, Escape
   * closes and hands the keyboard back to the composer's side of the page.
   */
  let {
    messages,
    viewport,
    request,
    jump,
    onclose
  }: {
    messages: Message[];
    viewport: HTMLElement | undefined;
    /** Bumped by each Ctrl+F: a second one while open selects the query again. */
    request: number;
    jump: (messageId: string) => void;
    onclose: () => void;
  } = $props();

  let input = $state<HTMLInputElement>();
  let query = $state('');
  let index = $state(0);
  let hits = $derived(findHits(messages, query));
  let current = $derived(hits.length === 0 ? null : hits[Math.min(index, hits.length - 1)]!);

  $effect(() => {
    void request;
    input?.focus();
    input?.select();
  });

  // A new query starts from the newest match: what was just read is usually what is wanted.
  $effect(() => {
    void query;
    index = Math.max(0, untrack(() => hits.length) - 1);
  });

  $effect(() => {
    const hit = current;
    const q = query;
    void messages.length;
    if (!hit) {
      clearFind();
      return;
    }
    void show(hit.messageId, hit.nth, q);
  });

  $effect(() => () => clearFind());

  async function show(messageId: string, nth: number, q: string) {
    const box = viewport;
    if (!box) return;
    let article = box.querySelector<HTMLElement>(`[data-mid="${CSS.escape(messageId)}"]`);
    if (!article) {
      jump(messageId);
      await tick();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      article = box.querySelector<HTMLElement>(`[data-mid="${CSS.escape(messageId)}"]`);
    }
    const mine = article ? findRanges(article, q) : [];
    const target = mine[Math.min(nth, mine.length - 1)] ?? null;
    paintFind(findRanges(box, q), target);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    if (rect.top < view.top + 40 || rect.bottom > view.bottom - 40) box.scrollTop += rect.top - view.top - view.height / 2;
  }

  function step(by: number) {
    if (hits.length === 0) return;
    index = (Math.min(index, hits.length - 1) + by + hits.length) % hits.length;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      // Taken here, so the page's Escape does not stop a running turn.
      event.preventDefault();
      event.stopPropagation();
      onclose();
    }
  }
</script>

<div class="find" role="search" data-testid="find-bar">
  <input
    bind:this={input}
    bind:value={query}
    {onkeydown}
    placeholder={strings.chat.findPlaceholder}
    aria-label={strings.keyboard.commands.find}
    spellcheck="false"
    data-testid="find-input"
  />
  <span class="count" data-testid="find-count" aria-live="polite">
    {#if query.trim()}{hits.length === 0 ? strings.chat.findNone : fill(strings.chat.findCount, { at: String(Math.min(index, hits.length - 1) + 1), total: String(hits.length) })}{/if}
  </span>
  <button type="button" class="ghost small icon" title={strings.chat.findPrevious} aria-label={strings.chat.findPrevious} disabled={hits.length === 0} onclick={() => step(-1)} data-testid="find-previous"><ChevronUp size={14} /></button>
  <button type="button" class="ghost small icon" title={strings.chat.findNext} aria-label={strings.chat.findNext} disabled={hits.length === 0} onclick={() => step(1)} data-testid="find-next"><ChevronDown size={14} /></button>
  <button type="button" class="ghost small icon" title={strings.common.close} aria-label={strings.common.close} onclick={onclose} data-testid="find-close"><X size={14} /></button>
</div>

<style>
  .find {
    position: absolute;
    top: 8px;
    right: 16px;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 4px 4px 10px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    animation: pop var(--dur-2) var(--ease-out-quint);
  }
  input {
    width: 180px;
    height: var(--control-sm);
    padding: 0;
    border: none;
    background: transparent;
    font-size: var(--text-sm);
  }
  input:focus {
    outline: none;
  }
  .count {
    min-width: 48px;
    padding: 0 6px;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  @media (max-width: 720px) {
    .find {
      left: 12px;
      right: 12px;
    }
    input {
      flex: 1;
      width: auto;
      /* An input's own minimum is about twenty characters, which pushed the close button off a phone. */
      min-width: 0;
    }
  }
</style>
