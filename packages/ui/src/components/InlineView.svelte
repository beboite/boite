<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Download, Maximize2, RotateCcw, X } from '@lucide/svelte';
  import { VIEW_DEFAULT_HEIGHT, VIEW_SANDBOX, readViewMessage, viewFrameHeight, viewThemeFragment, type InlineView as ViewInfo, type MessagePart, type ViewHostMessage } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { onView } from '../lib/on-view';
  import { openExternal } from '../lib/links';
  import { browserDownload, saveAttachmentUrl } from '../lib/attachment-save';
  import { rememberViewHeight, viewFonts, viewHeights, viewTheme, watchViewTheme } from '../lib/inline-view';
  import ChatFile from './ChatFile.svelte';

  /**
   * A page the agent published with `boite view`, drawn as part of its answer:
   * no card and no border, on the conversation's own background, at the height
   * the page needs. It runs in a sandboxed frame on an opaque origin and is
   * handed the app's theme, motion setting and faces. Nothing here ever says a
   * page failed: one that cannot be loaded, or that left its own address,
   * becomes the plain file card, which still downloads it.
   */
  let { part, store, threadId, messageId, partIndex }: {
    part: Extract<MessagePart, { type: 'artifact' }>; store: Store; threadId: string; messageId: string; partIndex: number;
  } = $props();

  /** How long a loaded frame has to say it is the page: a ticket the core no longer knows answers with a sentence instead. */
  const READY_MS = 2000;
  /** How long a frame has to load at all, on a slow link or behind a policy that refuses it without a word. */
  const LOAD_MS = 20_000;

  const view = $derived<ViewInfo>(part.view ?? { title: part.name, height: VIEW_DEFAULT_HEIGHT });
  let box = $state<HTMLDivElement>();
  let stage = $state<HTMLDivElement>();
  let frame = $state<HTMLIFrameElement>();
  let width = $state(0);
  let near = $state(false);
  let src = $state('');
  let failed = $state(false);
  let ready = $state(false);
  let expanded = $state(false);
  /** Bumped by Play again: a new frame on a ticket of its own. */
  let run = $state(0);
  let reported = $state<number | undefined>(untrack(() => viewHeights.get(part.id)));
  let theme = $state.raw(viewTheme());
  let waiting: ReturnType<typeof setTimeout> | undefined;
  let loads = 0;

  const height = $derived(viewFrameHeight(view, width, reported));
  const families = $derived(`${theme.vars['--font-sans'] ?? ''}|${theme.vars['--font-mono'] ?? ''}`);
  const canExpand = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

  $effect(() => {
    void run;
    if (!near) return;
    let stale = false;
    untrack(() => { ready = false; src = ''; loads = 0; clearTimeout(waiting); });
    void store.readArtifact(threadId, messageId, part.id, undefined, true).then((result) => {
      if (stale) return;
      if (!result.ok) { failed = true; return; }
      // The theme rides in the address, so the first paint is already the app's.
      src = `${result.value.url}${viewThemeFragment(untrack(() => theme))}`;
      waiting = setTimeout(() => { if (!ready) failed = true; }, LOAD_MS);
    });
    return () => { stale = true; };
  });

  // A theme, an accent or a motion setting changed under a mounted page.
  $effect(() => {
    const message: ViewHostMessage = { boiteView: 1, type: 'theme', theme };
    if (ready) frame?.contentWindow?.postMessage(message, '*');
  });

  // The page cannot fetch the app's faces: they are handed over as bytes once it is up, and again when the reader picks another.
  $effect(() => {
    void families;
    if (!ready) return;
    const target = frame?.contentWindow;
    void viewFonts(untrack(() => theme)).then((messages) => { for (const message of messages) target?.postMessage(message, '*'); }, () => {});
  });

  function loaded(): void {
    // A second load is the page leaving its own address: it is closed rather than left showing another site.
    if (++loads > 1) { failed = true; return; }
    clearTimeout(waiting);
    waiting = setTimeout(() => { if (!ready) failed = true; }, READY_MS);
  }

  onMount(() => {
    const heard = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow) return;
      const message = readViewMessage(event.data);
      if (message === null) return;
      if (message.type === 'ready') ready = true;
      // Full size, the frame is the screen's and not the page's: only the size in the thread is kept.
      else if (message.type === 'size') { if (!expanded) { reported = message.height; rememberViewHeight(part.id, message.height); } }
      // A page can post without a click: the link opens only from the frame the reader just acted in.
      else if (document.activeElement === frame && navigator.userActivation?.isActive !== false) void openExternal(message.url).catch(() => {});
    };
    window.addEventListener('message', heard);
    const unwatch = watchViewTheme(() => { theme = viewTheme(); });
    const sized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(([entry]) => { if (entry) width = entry.contentRect.width; });
    if (box) { width = box.clientWidth; sized?.observe(box); }
    return () => { window.removeEventListener('message', heard); unwatch(); sized?.disconnect(); clearTimeout(waiting); };
  });

  /** The top layer takes the stage without moving it in the document, so the page keeps running where it is. */
  function expand(): void {
    if (!stage || !canExpand) return;
    stage.setAttribute('popover', 'auto');
    try { stage.showPopover(); } catch { stage.removeAttribute('popover'); }
  }
  function collapse(): void {
    try { stage?.hidePopover(); } catch { /* already closed */ }
  }
  function toggled(event: ToggleEvent): void {
    expanded = event.newState === 'open';
    if (!expanded) stage?.removeAttribute('popover');
  }

  async function download(): Promise<void> {
    const result = await store.readArtifact(threadId, messageId, part.id);
    if (!result.ok) return;
    try { if ((await saveAttachmentUrl(part.name, result.value.url, false)) === null) browserDownload(result.value.url, part.name); } catch { /* the reader can try again */ }
  }
</script>

{#if failed}
  <ChatFile file={part} {store} {threadId} {messageId} {partIndex} />
{:else}
  <div class="inline-view" role="group" aria-label={view.title} bind:this={box} style:min-height={expanded ? `${height}px` : undefined} use:onView={() => { near = true; }} data-testid="inline-view" data-ready={ready}>
    <div class="stage" bind:this={stage} style:height={expanded ? undefined : `${height}px`} ontoggle={toggled} data-testid="inline-view-stage">
      {#if expanded}
        <header>
          <span class="title">{view.title}</span>
          <button type="button" class="ghost small icon" onclick={collapse} title={strings.artifacts.viewCollapse} aria-label={strings.artifacts.viewCollapse} data-testid="inline-view-collapse"><X size={16} /></button>
        </header>
      {/if}
      {#if src}
        {#key src}
          <iframe bind:this={frame} {src} title={view.title} sandbox={VIEW_SANDBOX} referrerpolicy="no-referrer" class:ready style:color-scheme={theme.scheme} onload={loaded} data-testid="inline-view-frame"></iframe>
        {/key}
      {/if}
    </div>
    {#if ready && !expanded}
      <div class="tools">
        <button type="button" class="ghost small icon" onclick={() => run++} title={strings.artifacts.viewReplay} aria-label={strings.artifacts.viewReplay} data-testid="inline-view-replay"><RotateCcw size={15} /></button>
        {#if canExpand}<button type="button" class="ghost small icon" onclick={expand} title={strings.artifacts.viewExpand} aria-label={strings.artifacts.viewExpand} data-testid="inline-view-expand"><Maximize2 size={15} /></button>{/if}
        <button type="button" class="ghost small icon" onclick={() => void download()} title={strings.artifacts.download} aria-label={strings.artifacts.download} data-testid="inline-view-download"><Download size={15} /></button>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Part of the answer: the whole column, no surface and no edge of its own. */
  .inline-view { position: relative; width: 100%; min-width: 0; }
  .stage { position: relative; width: 100%; }
  /* Hidden until the page says it is up, so a frame never shows anything but the page. */
  iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; visibility: hidden; opacity: 0; transition: opacity var(--dur-2); }
  iframe.ready { visibility: visible; opacity: 1; }

  /* Over the page's corner, and only while the pointer is on the view. */
  .tools { position: absolute; top: 0; right: 0; display: flex; gap: 2px; padding: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); opacity: 0; transition: opacity var(--dur-1); }
  .inline-view:hover .tools, .tools:focus-within { opacity: 1; }
  /* Nothing hovers on a phone, and the page is narrow: the actions take a row of their own under it. */
  @media (hover: none) {
    .tools { position: static; justify-content: flex-end; padding: 0; border: 0; background: none; opacity: 1; color: var(--color-muted-foreground); }
  }

  .stage:popover-open { position: fixed; inset: 0; display: flex; flex-direction: column; gap: 12px; width: auto; height: auto; max-width: none; max-height: none; margin: 0; padding: 12px clamp(12px, 4vw, 48px) clamp(12px, 4vw, 48px); border: 0; background: var(--color-background); color: var(--color-foreground); }
  .stage:popover-open iframe { flex: 1; min-height: 0; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--control); }
  .title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--text-sm); color: var(--color-muted-foreground); }
</style>
