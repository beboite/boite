<script lang="ts">
  import { renderMarkdown, withCaret } from '../lib/markdown';
  import { strings } from '../lib/strings';

  /**
   * Markdown for one text part. While the part streams, the HTML is rebuilt at
   * most every 48 ms instead of on every token: the render is linear in the
   * text, so per-delta rendering was quadratic over a long answer.
   */
  let { text, live = false }: { text: string; live?: boolean } = $props();

  const MIN_GAP_MS = 48;

  /** The caret rides inside the markdown, so it ends the last line rather than starting one. */
  const CARET = `<span class="caret" aria-label="${strings.chat.streaming}"></span>`;

  let html = $state('');
  let timer = 0;
  let renderedAt = 0;

  function render() {
    timer = 0;
    html = renderMarkdown(text);
    renderedAt = performance.now();
  }

  $effect(() => {
    void text;
    if (!live) {
      if (timer) clearTimeout(timer);
      render();
      return;
    }
    if (timer) return;
    const wait = Math.max(0, MIN_GAP_MS - (performance.now() - renderedAt));
    timer = window.setTimeout(render, wait);
  });

  $effect(() => () => {
    if (timer) clearTimeout(timer);
  });

  const shown = $derived(live ? withCaret(html, CARET) : html);
</script>

<div class="prose" data-testid="text-part">{@html shown}</div>

<style>
  .prose {
    word-break: break-word;
    line-height: 1.6;
  }

  .prose :global(p) {
    white-space: pre-wrap;
    margin: 0 0 8px;
  }

  .prose :global(p:last-child) {
    margin-bottom: 0;
  }

  .prose :global(h3),
  .prose :global(h4),
  .prose :global(h5),
  .prose :global(h6) {
    font-size: var(--text-md);
    margin: 12px 0 6px;
  }

  .prose :global(ul),
  .prose :global(ol) {
    margin: 0 0 8px;
    padding-left: 22px;
  }

  .prose :global(li) {
    margin: 2px 0;
  }

  .prose :global(code) {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
  }

  .prose :global(pre) {
    margin: 6px 0 10px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    overflow: auto;
  }

  .prose :global(pre code) {
    padding: 0;
    border: none;
    background: transparent;
    white-space: pre;
  }

  .prose :global(a) {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .prose :global(.caret) {
    display: inline-block;
    width: 7px;
    height: 14px;
    margin-left: 2px;
    vertical-align: -2px;
    background: var(--color-foreground);
    border-radius: 1px;
    animation: blink 1s steps(2, start) infinite;
  }
</style>
