<script lang="ts">
  import { tick } from 'svelte';
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

  let host = $state<HTMLDivElement>();

  /**
   * A fenced block gets a copy button of its own. The markdown is written by
   * `{@html}`, which replaces the whole subtree on every render, so the button
   * is hung again after each one rather than kept: the wrapper and the listener
   * die with the nodes they were on.
   */
  $effect(() => {
    void shown;
    const node = host;
    if (!node) return;
    // The `{@html}` write lands with the rest of the render, so the buttons go
    // on one tick later, once the new blocks are the ones in the document.
    void tick().then(() => {
      for (const pre of node.querySelectorAll('pre')) hangCopy(pre);
    });
  });

  function hangCopy(pre: HTMLPreElement): void {
    if (pre.parentElement?.classList.contains('code-block')) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.replaceWith(wrap);
    wrap.append(pre);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost small copy';
    button.textContent = strings.chat.copy;
    button.title = strings.chat.copy;
    button.setAttribute('data-testid', 'code-copy');
    const reset = () => {
      button.textContent = strings.chat.copy;
    };
    button.addEventListener('click', () => void copy(pre, button));
    button.addEventListener('pointerleave', reset);
    button.addEventListener('blur', reset);
    wrap.append(button);
  }

  /** The label says it landed and goes back on the way out, so nothing times it. */
  async function copy(pre: HTMLPreElement, button: HTMLButtonElement): Promise<void> {
    const code = pre.querySelector('code');
    try {
      await navigator.clipboard.writeText((code ?? pre).textContent ?? '');
      button.textContent = strings.chat.copied;
    } catch {
      button.textContent = strings.chat.copy;
    }
  }
</script>

<div class="prose" data-testid="text-part" bind:this={host}>{@html shown}</div>

<style>
  .prose {
    word-break: break-word;
    line-height: 1.65;
  }

  .prose :global(p) {
    white-space: pre-wrap;
    margin: 0 0 12px;
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
    margin: 0 0 12px;
    padding-left: 22px;
  }

  .prose :global(li) {
    margin: 2px 0;
  }

  .prose :global(code) {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
  }

  .prose :global(pre) {
    margin: 6px 0 10px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    overflow: auto;
  }

  /* The button sits over the block's top right corner and shows for a pointer
     or for the keyboard, never in a capture of the answer at rest. */
  .prose :global(.code-block) {
    position: relative;
  }

  .prose :global(.code-block .copy) {
    position: absolute;
    top: 8px;
    right: 8px;
    opacity: 0;
    transition: opacity var(--dur-2) var(--ease-out-quint);
  }

  .prose :global(.code-block:hover .copy),
  .prose :global(.code-block:focus-within .copy) {
    opacity: 1;
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
