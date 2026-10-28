<script lang="ts">
  import { tick } from 'svelte';
  import { renderBlock } from '../lib/markdown';
  import { hasFence } from '../lib/fences';
  import { workspace } from '../lib/workspace.svelte';
  import { ParagraphScan, answerText } from '../lib/message-display';
  import { strings } from '../lib/strings';
  import { featureOn } from '../lib/features.svelte';
  import type { Store } from '../lib/store.svelte';
  import ChatFile from './ChatFile.svelte';
  import { executableLink, localFileDirectory, openLocalFile, openChatFile } from '../lib/local-files';
  import { glides } from '../lib/motion';
  import TypingIndicator from './TypingIndicator.svelte';
  import { selectionClicks } from '../lib/selection-clicks';
  import { longPress } from '../lib/long-press';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { fullPath } from '../lib/chat-links';
  import { writeClipboardLater } from '../lib/live-input';
  import type { Message } from '@boite/contracts';
  import { answerPieces, viewAt, viewPart, type AnswerPiece } from '../lib/inline-view';
  import InlineView from './InlineView.svelte';
  import { richMarkdown } from '../lib/rich-markdown';
  import { viewerHost, type Gallery, type MediaItem } from '../lib/media-gallery';
  import Deferred, { parts } from './Deferred.svelte';

  /**
   * `views` are the pages the answer's turn published (`turnViews`): a line
   * of the answer that names one (`answerPieces`) draws it there, and the
   * text around it becomes a bubble above it and another under it.
   */
  let { text, live = false, typing = false, bubble = false, store, threadId, views }: {
    text: string; live?: boolean; typing?: boolean; bubble?: boolean; store?: Store; threadId?: string; views?: readonly Message[];
  } = $props();
  let selected = $state<{ path: string; line?: number } | null>(null);
  const directLinks = $derived(featureOn('open-chat-links'));
  const rich = $derived(featureOn('chat-artifacts') || directLinks);
  let opening = false;
  function follow(event: MouseEvent): void {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor || workspace.followThreadLink(event, store, threadId)) return;
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
    openFile(anchor.dataset.filePath, anchor.dataset.fileLine);
  }
  function openFile(written: string, line: string | undefined): void {
    if (opening) return;
    opening = true;
    void located(written).then(path => {
      const directory = localFileDirectory(store, threadId);
      if (directory && (directLinks || (executableLink(path) && !line))) return (directLinks ? openChatFile : openLocalFile)(directory, path);
      selected = { path, ...(line ? { line: Number(line) } : {}) };
    }).catch(reason => {
      store?.reportError(reason, 'minor');
    }).finally(() => { opening = false; });
  }
  /**
   * A file or thread link's own menu, in place of the webview's: its "Copy
   * link" gave the `#file` placeholder, never the path (#779). The path goes
   * on the clipboard whole, joined to the thread's folder.
   */
  const MENU_LINK = 'a[data-file-path], a[data-thread-address]';
  const hasMenu = (target: Element) => target.closest(MENU_LINK) !== null;
  function linkMenu(event: MouseEvent): void {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(MENU_LINK) : null;
    if (!anchor) return;
    const thread = anchor.dataset.threadAddress;
    if (thread) {
      contextMenu.open(event, [{ id: 'copy', label: strings.chat.copyThreadAddress }], () => void copyText(thread));
      return;
    }
    const written = anchor.dataset.filePath!;
    const line = anchor.dataset.fileLine;
    contextMenu.open(event, [{ id: 'open', label: strings.chat.openLink }, { id: 'copy', label: strings.chat.copyPath }], id => {
      if (id === 'open') openFile(written, line);
      else void copyText(located(written).then(path => fullPath(path, store?.threads.find(item => item.id === threadId)?.cwd)));
    });
  }
  /** The path is looked up after the pick: the write starts within the gesture, which Safari's clipboard requires. */
  async function copyText(text: string | Promise<string>): Promise<void> {
    try { await writeClipboardLater(Promise.resolve(text)); } catch (reason) { store?.reportError(reason, 'minor'); }
  }
  /**
   * The path a file link names in its thread. An agent often writes a file by
   * its name alone (`core.md` for `.local/core.md`): a relative path that is not
   * there as written becomes the file the core finds by that tail. Several at
   * the same depth are reported rather than guessed.
   */
  async function located(path: string): Promise<string> {
    if (!store?.owner || !threadId || /^(?:[a-z]:)?[\\/]/i.test(path)) return path;
    const found = await store.locateFile(threadId, path);
    if (!found.ok || found.value.length === 0) return path;
    if (found.value.length > 1) throw new Error(strings.artifacts.ambiguous(path, found.value.join(', ')));
    return found.value[0]!;
  }
  // The scan resumes where the last delta stopped instead of reading the answer again.
  const scan = new ParagraphScan();
  let blocks = $derived(scan.blocks(answerText(text, live), live));
  // Completed blocks keep their DOM; only the unfinished paragraph changes on a delta.
  // It stays plain text until complete, so partial Markdown cannot rebuild earlier blocks.
  let pending = $derived.by(() => { void blocks; return live ? scan.pending(answerText(text, live)) : ''; });

  type Group = { kind: 'text'; key: string; blocks: Array<{ key: string; block: string }> } | { kind: 'view'; key: string; message: Message };
  /**
   * The answer cut at the pages it places: runs of text, each its own bubble,
   * and the views between them. A line naming no view of the turn stays text.
   * Null when the turn published no page. Otherwise the answer is drawn this
   * way from its first word, so the line that places a page, once written,
   * adds the page and a bubble under it without drawing again what is above.
   */
  const groups = $derived.by((): Group[] | null => {
    if (!views?.length || !store || !threadId) return null;
    const pieces = answerPieces(blocks) ?? blocks.map((block, index): AnswerPiece => ({ kind: 'text', key: String(index), block }));
    const out: Group[] = [];
    for (const piece of pieces) {
      const message = piece.kind === 'view' ? viewAt(views, piece.path) : null;
      if (message) { out.push({ kind: 'view', key: `${piece.key}:${message.id}`, message }); continue; }
      const block = piece.kind === 'text' ? piece.block : piece.line;
      const last = out.at(-1);
      if (last?.kind === 'text') last.blocks.push({ key: piece.key, block });
      else out.push({ kind: 'text', key: piece.key, blocks: [{ key: piece.key, block }] });
    }
    return out;
  });
  /** A line being written that may yet place a page is not shown as its raw link: the page or the paragraph replaces it once complete. */
  const tail = $derived(views?.length && /^ {0,3}!\[[^\n]*$/.test(pending) ? '' : pending);

  let host = $state<HTMLDivElement>();

  /**
   * A drawn diagram opens in the timeline's viewer, or in one of its own where
   * there is none (a file preview, a plan). Its picture is an object URL the
   * viewer gives back once closed.
   */
  const viewers = viewerHost();
  let viewing = $state<Gallery | null>(null);
  function enlarge(item: MediaItem): void {
    if (viewers) { viewers.open({ items: [item], index: 0 }); viewers.release(item.src); return; }
    if (viewing) URL.revokeObjectURL(viewing.items[0]!.src);
    viewing = { items: [item], index: 0 };
  }
  function closeViewer(): void {
    if (viewing) URL.revokeObjectURL(viewing.items[0]!.src);
    viewing = null;
  }

  // Attach copy buttons once the final paragraph has reached the DOM.
  $effect(() => {
    void blocks;
    if (live) return;
    const node = host;
    if (!node) return;
    // Only a fenced block draws a `pre`: most paragraphs have no button to hang and wait for nothing.
    if (!blocks.some(hasFence)) return;
    // The `{@html}` write lands with the rest of the render, so the buttons go
    // on one tick later, once the new blocks are the ones in the document.
    void tick().then(() => {
      for (const pre of node.querySelectorAll('pre')) hangCopy(pre);
    });
  });

  function hangCopy(pre: HTMLPreElement): void {
    // A diagram's code has the diagram's own buttons.
    if (pre.parentElement?.classList.contains('code-block') || pre.parentElement?.classList.contains('md-mermaid')) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.replaceWith(wrap);
    wrap.append(pre);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost small copy';
    button.textContent = strings.common.copy;
    button.title = strings.common.copy;
    button.setAttribute('data-testid', 'code-copy');
    const reset = () => {
      button.textContent = strings.common.copy;
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
      button.textContent = strings.common.copy;
    }
  }
</script>

{#snippet writing()}{#if tail}<p class="pending" data-testid="paragraph-pending">{tail}</p>{/if}{#if typing && text.trim().length > 0}<TypingIndicator />{/if}{/snippet}

{#if groups && store && threadId}
  {@const end = groups.at(-1)}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="flow" data-testid="text-part" bind:this={host} use:selectionClicks use:longPress={hasMenu} use:richMarkdown={{ onenlarge: enlarge }} onclick={follow} oncontextmenu={linkMenu}>
    {#each groups as group (group.key)}
      {#if group.kind === 'view'}
        <InlineView part={viewPart(group.message)!} {store} {threadId} messageId={group.message.id} partIndex={0} />
      {:else}
        <div class="prose" class:live class:answer-bubble={bubble} data-testid="text-run">
          {#each group.blocks as piece (piece.key)}
            <div class="paragraph" data-testid="paragraph">{@html renderBlock(piece.block, rich)}</div>
          {/each}{#if group === end}{@render writing()}{/if}
        </div>
      {/if}
    {/each}
    {#if end?.kind !== 'text' && (tail || (typing && text.trim().length > 0))}
      <div class="prose" class:live class:answer-bubble={bubble && tail.length > 0} data-testid="text-run">{@render writing()}</div>
    {/if}
  </div>
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="prose" class:live class:answer-bubble={bubble && (blocks.length > 0 || tail.length > 0)} data-testid="text-part" bind:this={host} use:selectionClicks use:longPress={hasMenu} use:richMarkdown={{ onenlarge: enlarge }} onclick={follow} oncontextmenu={linkMenu}>
    {#each blocks as block, index (index)}
      <!-- Completed Markdown blocks stay mounted while the pending paragraph changes. -->
      <div class="paragraph" data-testid="paragraph">{@html renderBlock(block, rich)}</div>
    {/each}{@render writing()}
  </div>
{/if}
{#if selected && rich}
  {#key `${threadId}:${selected.path}:${selected.line}`}
    <ChatFile {store} {threadId} path={selected.path} line={selected.line} onclose={() => selected = null} />
  {/key}
{/if}
{#if viewing}{@const view = viewing}<Deferred part={parts.ImageViewer} floating>{#snippet children(ImageViewer)}<ImageViewer items={view.items} index={view.index} onclose={closeViewer} />{/snippet}</Deferred>{/if}

<style>
  .prose {
    word-break: break-word;
    font-size: var(--text-reading);
    line-height: var(--leading-reading);
  }

  /* An answer cut by the pages it places: its text keeps the reading measure,
     each page takes the whole column, as far from the text as two messages are. */
  .flow {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--chat-message-gap);
  }

  .flow > .prose { max-width: min(100%, var(--prose)); }

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
  /* A long press opens the link's own menu, not the phone's preview of `#file`. */
  .prose :global(a[data-file-path]), .prose :global(a[data-thread-address]) { -webkit-touch-callout: none; }

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
     It takes its content's width up to the column's and its cells wrap their text
     to stay inside it. Only what cannot break, a long path or too many columns,
     scrolls inside the table: a table box ignores overflow, so it is a block here,
     or a wide one pans the whole conversation on a phone. */
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
    /* The app's data tables keep a row on one line; an answer's table wraps at
       spaces. Not inside a word: the reading text's break-word would let the
       table split a short one to narrow a column, so a path too long for the
       column scrolls instead. */
    white-space: normal;
    word-break: normal;
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
