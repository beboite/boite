<script lang="ts">
  import { tick } from 'svelte';
  import { renderBlock } from '../lib/markdown';
  import { ParagraphScan, answerText } from '../lib/message-display';
  import { strings } from '../lib/strings';
  import { experimentOn } from '../lib/experiments.svelte';
  import type { Store } from '../lib/store.svelte';
  import ChatFile from './ChatFile.svelte';
  import { executableLink, localFileDirectory, openLocalFile, openChatFile } from '../lib/local-files';
  import { glides } from '../lib/motion';
  import TypingIndicator from './TypingIndicator.svelte';

  let { text, live = false, typing = false, bubble = false, store, threadId }: { text: string; live?: boolean; typing?: boolean; bubble?: boolean; store?: Store; threadId?: string } = $props();
  let selected = $state<{ path: string; line?: number } | null>(null);
  const directLinks = $derived(experimentOn('open-chat-links'));
  const rich = $derived(experimentOn('chat-artifacts') || directLinks);
  let opening = false;
  function follow(event: MouseEvent): void {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor) return;
    if (!anchor.dataset.filePath) {
      const href = anchor.getAttribute('href');
      if (href?.startsWith('#')) {
        try {
          const heading = host?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
          if (heading) { event.preventDefault(); heading.scrollIntoView({ block: 'nearest', behavior: glides() ? 'smooth' : 'auto' }); }
        } catch { /* A malformed fragment is not a local file. */ }
      }
      return;
    }
    event.preventDefault();
    const directory = localFileDirectory(store, threadId);
    if (directory && (directLinks || (executableLink(anchor.dataset.filePath) && !anchor.dataset.fileLine))) {
      if (opening) return;
      opening = true;
      void (directLinks ? openChatFile : openLocalFile)(directory, anchor.dataset.filePath).catch(reason => {
        if (store) store.error = reason instanceof Error ? reason.message : String(reason);
      }).finally(() => { opening = false; });
      return;
    }
    selected = { path: anchor.dataset.filePath!, ...(anchor.dataset.fileLine ? { line: Number(anchor.dataset.fileLine) } : {}) };
  }
  // The scan resumes where the last delta stopped instead of reading the answer again.
  const scan = new ParagraphScan();
  let blocks = $derived(scan.blocks(answerText(text, live), live));

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

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="prose" class:live class:answer-bubble={bubble && (blocks.length > 0 || typing)} data-testid="text-part" bind:this={host} onclick={follow}>
  {#each blocks as block, index (index)}
    <!-- A streaming answer shows finished paragraphs only (`ParagraphScan`): every block here is final and kept. -->
    <div class="paragraph" data-testid="paragraph">{@html renderBlock(block, rich)}</div>
  {/each}{#if typing}<TypingIndicator />{/if}
</div>
{#if selected && rich}
  {#key `${threadId}:${selected.path}:${selected.line}`}
    <ChatFile {store} {threadId} path={selected.path} line={selected.line} onclose={() => selected = null} />
  {/key}
{/if}

<style>
  .prose {
    word-break: break-word;
    font-size: var(--text-reading);
    line-height: var(--leading-reading);
  }

  .answer-bubble {
    width: fit-content;
    max-width: 100%;
    min-width: 0;
    padding: 12px 16px;
    background: var(--color-chat-reply);
    border: 1px solid var(--color-chat-reply-edge);
    border-radius: var(--radius-chat-bubble);
    border-bottom-left-radius: var(--radius-sm);
  }

  @media (max-width: 720px) { .answer-bubble { padding: 10px 14px; } }

  /* `pretty` keeps a paragraph from ending on one stranded word. */
  .prose :global(p) {
    white-space: pre-wrap;
    text-wrap: pretty;
    margin: 0 0 12px;
  }

  .prose :global(p:last-child) {
    margin-bottom: 0;
  }

  /* `#` to `####` arrive as h3 to h6 (lib/markdown.ts) and step down in size,
     so a section reads above its subsections. A heading sits closer to what it
     names than to what it follows. */
  .prose :global(h3),
  .prose :global(h4),
  .prose :global(h5),
  .prose :global(h6) {
    font-size: 1em;
    line-height: 1.35;
    letter-spacing: -0.005em;
    margin: 22px 0 8px;
  }

  .prose :global(h3) { font-size: 1.3em; letter-spacing: -0.015em; }
  .prose :global(h4) { font-size: 1.15em; letter-spacing: -0.01em; }
  .prose :global(h6) { color: var(--color-muted-foreground); }

  /* A heading alone in its block: its own bottom margin replaces the block gap under it. */
  .paragraph > :global(:is(h3, h4, h5, h6):last-child) { margin-bottom: -4px; }
  .paragraph:first-child > :global(:is(h3, h4, h5, h6):first-child) { margin-top: 0; }

  .prose :global(ul),
  .prose :global(ol) {
    margin: 0 0 12px;
    padding-left: 24px;
  }

  .prose :global(li) {
    text-wrap: pretty;
    margin: 4px 0;
  }

  .prose :global(li::marker) { color: var(--color-muted-foreground); }

  .prose :global(code) {
    font-family: var(--font-mono);
    font-size: 0.875em;
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--color-code-background);
    color: var(--color-code-foreground);
    border: 1px solid var(--color-border);
  }

  .prose :global(pre) {
    margin: 6px 0 10px;
    padding: 12px 14px;
    font-size: var(--text-sm);
    line-height: 1.6;
    border-radius: var(--radius-md);
    background: var(--color-code-background);
    color: var(--color-code-foreground);
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
    font-size: inherit;
    padding: 0;
    border: none;
    background: transparent;
    white-space: pre;
  }

  .prose :global(a) {
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-decoration-color: color-mix(in oklch, currentColor 45%, transparent);
    text-underline-offset: 3px;
    transition: text-decoration-color var(--dur-2) var(--ease-out-quint);
  }

  .prose :global(a:hover) { text-decoration-color: currentColor; }

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

  /* A table is a code well's cousin: the surface-2 ground, hairlines, the head one step up.
     It takes its content's width up to the column's and scrolls inside itself past
     that, like a code well: a table box ignores overflow, so it is a block here, or
     a wide one pans the whole conversation on a phone. */
  .prose :global(table) {
    display: block;
    width: max-content;
    max-width: 100%;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    margin: 6px 0 12px;
    border-collapse: separate;
    border-spacing: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
    line-height: 1.5;
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
  /* Only a paragraph the answer is writing now eases in. One mounted from the
     history, as a scroll brings its message back into the window, is already
     there: animating it made every scroll restyle each paragraph it reached. */
  .live .paragraph { animation: paragraph-in var(--dur-3) var(--ease-out-quint); }
  @keyframes paragraph-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { .live .paragraph { animation: none; } }
</style>
