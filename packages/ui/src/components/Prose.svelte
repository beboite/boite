<script lang="ts">
  import { tick } from 'svelte';
  import { renderMarkdown } from '../lib/markdown';
  import { paragraphBlocks, answerText } from '../lib/message-display';
  import { strings } from '../lib/i18n.svelte';

  let { text, live = false }: { text: string; live?: boolean } = $props();
  let blocks = $derived(paragraphBlocks(answerText(text, live), live));

  let host = $state<HTMLDivElement>();

  // Attach copy buttons once the final paragraph has reached the DOM.
  $effect(() => {
    void blocks;
    if (live) return;
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

<div class="prose" data-testid="text-part" bind:this={host}>
  {#each blocks as block, index (index)}
    <div class="paragraph" data-testid="paragraph">{@html renderMarkdown(block)}</div>
  {/each}
</div>

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

  .prose :global(ul ul),
  .prose :global(ol ol),
  .prose :global(ul ol),
  .prose :global(ol ul) {
    margin: 2px 0 0;
  }

  /* A task box reads as a mark, never as a control: it takes no pointer. */
  .prose :global(li.task) {
    list-style: none;
    margin-left: -18px;
  }

  .prose :global(li.task input) {
    width: 13px;
    height: 13px;
    margin: 0 4px 0 0;
    vertical-align: -2px;
    accent-color: var(--color-foreground);
    pointer-events: none;
  }

  .prose :global(blockquote) {
    margin: 0 0 12px;
    padding: 2px 0 2px 12px;
    border-left: 2px solid var(--color-edge);
    color: var(--color-muted-foreground);
  }

  .prose :global(blockquote > :last-child) {
    margin-bottom: 0;
  }

  .prose :global(hr) {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: 14px 0;
  }

  .prose :global(del) {
    color: var(--color-muted-foreground);
  }

  /* A table is a code well's cousin: the surface-2 ground, hairlines, the head one step up. */
  .prose :global(table) {
    width: 100%;
    margin: 6px 0 12px;
    border-collapse: separate;
    border-spacing: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
    overflow: hidden;
  }

  .prose :global(th),
  .prose :global(td) {
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--color-border);
  }

  .prose :global(th) {
    font-weight: 600;
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
  }

  .prose :global(tbody tr:last-child td) {
    border-bottom: none;
  }

  .paragraph + .paragraph { margin-top: 12px; }
  .paragraph { animation: paragraph-in var(--dur-3) var(--ease-out-quint); }
  @keyframes paragraph-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { .paragraph { animation: none; } }
</style>
