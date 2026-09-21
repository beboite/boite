<script lang="ts">
  // One file per tab: a text editor with a gutter and a save, a picture with
  // zoom and pan, the native player for a sound or a video, and a download for
  // anything else. Everything reaches the disk through the core, never through
  // the browser's own file system.
  import { tick, untrack } from 'svelte';
  import { Download, Maximize2, Minus, Plus, Save, Scan } from '@lucide/svelte';
  import type { FileContent } from '@boite/contracts';
  import { bytes } from '../lib/format';
  import { baseName } from '../lib/right-panel.svelte';
  import type { BoundPanel, Surface } from '../lib/right-panel.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store, surface, panel }: { store: Store; surface: Surface; panel: BoundPanel } = $props();

  /** The editor's own line box, in pixels: the gutter and the highlight do this maths. */
  const LINE = 20;
  /** The padding both the gutter and the text start under. */
  const PAD = 6;
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 20;
  const STEP = 1.25;

  let content = $state<FileContent | null>(null);
  let problem = $state<string | null>(null);
  let loading = $state(false);

  // The editor
  let draft = $state('');
  /** What the disk last answered with: the dirty dot is the distance to it. */
  let stored = $state('');
  let saving = $state(false);
  let area = $state<HTMLTextAreaElement | undefined>(undefined);
  let offset = $state(0);

  // The image viewer
  let natural = $state<{ width: number; height: number } | null>(null);
  let scale = $state(1);
  let left = $state(0);
  let top = $state(0);
  let fitted = $state(true);
  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let dragFrom: { x: number; y: number } | null = null;

  let threadId = $derived(store.openThread?.id ?? null);
  let path = $derived(surface.path ?? null);
  let dirty = $derived(content?.kind === 'text' && draft !== stored);
  let readOnly = $derived(content?.kind === 'text' && (content.truncated || !store.owner));
  let lineCount = $derived(content?.kind === 'text' ? draft.split('\n').length : 0);
  /** A line the file does not have draws no band: an agent can name one past the end. */
  let highlight = $derived(
    surface.line !== undefined && surface.line >= 1 && surface.line <= lineCount ? surface.line : null
  );

  function directory(full: string): string {
    const cut = full.lastIndexOf('/');
    return cut < 0 ? '' : full.slice(0, cut + 1);
  }

  async function load(id: string, wanted: string): Promise<void> {
    loading = true;
    const answer = await store.readFile(id, wanted);
    loading = false;
    // The tab may have been asked for another file while the call was out.
    if (threadId !== id || path !== wanted) return;
    if (!answer.ok) {
      content = null;
      problem = fill(strings.files.readFailed, { reason: answer.error });
      return;
    }
    problem = null;
    content = answer.value;
    if (answer.value.kind === 'text') {
      stored = answer.value.text;
      // An edit made before this tab was last unmounted comes back over the
      // disk's text, and the dirty dot with it.
      draft = panel.draft(surface.id) ?? answer.value.text;
      offset = 0;
    } else {
      natural = null;
      fitted = true;
    }
  }

  async function save(): Promise<void> {
    const id = threadId;
    const wanted = path;
    const file = content;
    if (id === null || wanted === null || file?.kind !== 'text' || readOnly || !dirty || saving) return;
    saving = true;
    const answer = await store.writeFile(id, wanted, draft);
    saving = false;
    if (!answer.ok) {
      problem = fill(strings.files.writeFailed, { reason: answer.error });
      return;
    }
    problem = null;
    stored = draft;
    keep();
    content = { ...file, text: draft, bytes: answer.value.bytes, modifiedAt: answer.value.modifiedAt };
  }

  /**
   * The edit, held by the panel rather than by this component: a tab switch, a
   * hidden panel or another thread unmounts the editor, and the text typed
   * since the last save used to go with it.
   */
  function keep(): void {
    panel.keepDraft(surface.id, draft === stored ? null : draft);
  }

  function edit(text: string): void {
    draft = text;
    keep();
  }

  /** Tab writes two spaces rather than leaving the editor for the next control. */
  function onEditorKey(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    const node = area;
    if (!node || readOnly) return;
    event.preventDefault();
    const start = node.selectionStart;
    const end = node.selectionEnd;
    edit(`${draft.slice(0, start)}  ${draft.slice(end)}`);
    void tick().then(() => node.setSelectionRange(start + 2, start + 2));
  }

  /** The platform's save chord, while this surface is the one showing. */
  function onWindowKey(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() !== 's') return;
    if (content?.kind !== 'text' || readOnly) return;
    event.preventDefault();
    void save();
  }

  function clamp(value: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  }

  function box(): { width: number; height: number } {
    const rect = viewport?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }

  /** The whole picture inside the surface, measured rather than left to `object-fit`. */
  function fit(): void {
    const size = natural;
    if (!size || size.width === 0 || size.height === 0) return;
    const { width, height } = box();
    // jsdom lays nothing out, so a box of nothing keeps the picture at its size.
    const next = width > 0 && height > 0 ? Math.min(width / size.width, height / size.height) : 1;
    scale = clamp(next);
    left = (width - size.width * scale) / 2;
    top = (height - size.height * scale) / 2;
    fitted = true;
  }

  /** A new scale with one point of the viewport held still under it. */
  function zoomAt(next: number, x: number, y: number): void {
    const to = clamp(next);
    if (to === scale) return;
    left = x - (x - left) * (to / scale);
    top = y - (y - top) * (to / scale);
    scale = to;
    fitted = false;
  }

  function zoomBy(factor: number): void {
    const { width, height } = box();
    zoomAt(scale * factor, width / 2, height / 2);
  }

  function actual(): void {
    const { width, height } = box();
    zoomAt(1, width / 2, height / 2);
    fitted = false;
  }

  function onImageLoad(event: Event): void {
    const node = event.currentTarget as HTMLImageElement;
    natural = { width: node.naturalWidth, height: node.naturalHeight };
    fit();
  }

  function onWheel(event: WheelEvent): void {
    if (!natural) return;
    event.preventDefault();
    const rect = viewport?.getBoundingClientRect();
    zoomAt(scale * Math.pow(0.999, event.deltaY), event.clientX - (rect?.left ?? 0), event.clientY - (rect?.top ?? 0));
  }

  function onPointerDown(event: PointerEvent): void {
    if (!natural || event.button !== 0) return;
    event.preventDefault();
    dragFrom = { x: event.clientX - left, y: event.clientY - top };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (dragFrom === null) return;
    left = event.clientX - dragFrom.x;
    top = event.clientY - dragFrom.y;
    fitted = false;
  }

  function onPointerUp(event: PointerEvent): void {
    if (dragFrom === null) return;
    dragFrom = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }

  // On mount, and again whenever the tab is asked for another path.
  $effect(() => {
    const id = threadId;
    const wanted = path;
    if (id === null || wanted === null) return;
    untrack(() => void load(id, wanted));
  });

  // The line whoever opened the tab named, brought to the middle of the view.
  // It runs again when the same tab is asked for another line.
  $effect(() => {
    const line = highlight;
    const node = area;
    if (line === null || !node || content?.kind !== 'text') return;
    const wanted = Math.max(0, PAD + (line - 1) * LINE - node.clientHeight / 2);
    node.scrollTop = wanted;
    offset = node.scrollTop;
  });

  // The picture follows the panel's width: a fitted one is fitted again.
  $effect(() => {
    const node = viewport;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (fitted) fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  });
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="file-surface" data-testid="file-panel" data-path={path ?? ''} data-kind={content?.kind ?? ''}>
  <div class="bar">
    <span class="path" title={path ?? ''} data-testid="file-path">
      <span class="dir">{directory(path ?? '')}</span><span class="base">{baseName(path ?? '')}</span>
    </span>
    {#if dirty}
      <span class="dot" title={strings.files.unsaved} aria-label={strings.files.unsaved} data-testid="file-dirty"></span>
    {/if}
    <span class="spacer"></span>

    {#if content?.kind === 'image'}
      <button
        type="button"
        class="ghost small icon"
        title={strings.files.zoomOut}
        aria-label={strings.files.zoomOut}
        data-testid="file-zoom-out"
        onclick={() => zoomBy(1 / STEP)}
      >
        <Minus size={13} strokeWidth={1.75} />
      </button>
      <span class="percent" data-testid="file-zoom">{Math.round(scale * 100)}%</span>
      <button
        type="button"
        class="ghost small icon"
        title={strings.files.zoomIn}
        aria-label={strings.files.zoomIn}
        data-testid="file-zoom-in"
        onclick={() => zoomBy(STEP)}
      >
        <Plus size={13} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        class="ghost small icon"
        title={strings.files.fit}
        aria-label={strings.files.fit}
        data-testid="file-fit"
        onclick={fit}
      >
        <Maximize2 size={13} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        class="ghost small icon"
        title={strings.files.actual}
        aria-label={strings.files.actual}
        data-testid="file-actual"
        onclick={actual}
      >
        <Scan size={13} strokeWidth={1.75} />
      </button>
      {#if natural}
        <span class="meta" data-testid="file-natural">
          {fill(strings.files.natural, { width: String(natural.width), height: String(natural.height) })}
        </span>
      {/if}
    {/if}

    {#if content?.kind === 'text' && content.language}
      <span class="meta" data-testid="file-language">{content.language}</span>
    {/if}
    <span class="meta" data-testid="file-size">{bytes(content?.bytes ?? null)}</span>

    {#if content?.kind === 'text' && !readOnly}
      <button
        type="button"
        class="small"
        data-testid="file-save"
        disabled={!dirty || saving}
        onclick={() => void save()}
      >
        <Save size={13} strokeWidth={1.75} />
        {saving ? strings.files.saving : strings.files.save}
      </button>
    {/if}
  </div>

  {#if problem !== null}
    <p class="notice bad" data-testid="file-error">{problem}</p>
  {:else if path === null}
    <p class="notice">{strings.files.noFile}</p>
  {:else if content === null}
    <p class="notice">{loading ? strings.files.readingFile : strings.files.noFile}</p>
  {:else if content.kind === 'text'}
    {#if content.truncated}
      <p class="notice" data-testid="file-truncated">{strings.files.truncated}</p>
    {:else if readOnly}
      <p class="notice" data-testid="file-readonly">{strings.files.readOnly}</p>
    {/if}
    <div class="code" data-testid="file-editor" style="--line: {LINE}px; --pad: {PAD}px">
      <div class="gutter" aria-hidden="true">
        <div class="numbers" style="transform: translateY({-offset}px)">
          {#each Array.from({ length: lineCount }, (_, index) => index + 1) as at (at)}
            <span class="num" class:on={at === highlight} data-testid="file-line" data-line={at}>{at}</span>
          {/each}
        </div>
      </div>
      {#if highlight !== null}
        <div
          class="band"
          data-testid="file-highlight"
          data-line={highlight}
          style="top: calc(var(--pad) + {(highlight - 1) * LINE - offset}px)"
        ></div>
      {/if}
      <textarea
        class="text mono"
        wrap="off"
        spellcheck="false"
        aria-label={strings.files.editorLabel}
        data-testid="file-text"
        readonly={readOnly}
        bind:this={area}
        bind:value={() => draft, edit}
        onkeydown={onEditorKey}
        onscroll={() => (offset = area?.scrollTop ?? 0)}
      ></textarea>
    </div>
  {:else if content.kind === 'image'}
    <!-- The picture is placed by hand: `object-fit` would hide the numbers the
         zoom, the pan and the 1:1 button all work on. -->
    <div
      class="viewport"
      data-testid="file-viewport"
      bind:this={viewport}
      onwheel={onWheel}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      ondblclick={() => (fitted ? actual() : fit())}
      role="presentation"
    >
      <img
        class="picture"
        src={content.url}
        alt={strings.files.picture}
        data-testid="file-image"
        draggable="false"
        style="left: {left}px; top: {top}px; width: {(natural?.width ?? 0) * scale}px; height: {(natural?.height ?? 0) * scale}px"
        onload={onImageLoad}
      />
    </div>
  {:else if content.kind === 'video'}
    <div class="player">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video class="media" controls preload="metadata" src={content.url} data-testid="file-video"></video>
    </div>
  {:else if content.kind === 'audio'}
    <div class="player">
      <audio class="media sound" controls preload="metadata" src={content.url} data-testid="file-audio"></audio>
    </div>
  {:else}
    <div class="blob" data-testid="file-binary">
      <p class="notice">{strings.files.binary}</p>
      <p class="meta mono">{content.mime}</p>
      <a class="download" href={content.url} download={baseName(content.path)} data-testid="file-download">
        <Download size={13} strokeWidth={1.75} />
        {strings.files.download}
      </a>
    </div>
  {/if}
</div>

<style>
  .file-surface {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    height: var(--row);
    padding: 0 6px 0 12px;
    flex: none;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .path {
    min-width: 0;
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }

  /* `direction: rtl` keeps the file name in view when the path is cut; each
     span reads left to right again so the text itself is not reversed. */
  .dir,
  .base {
    direction: ltr;
    unicode-bidi: embed;
  }

  .dir {
    color: var(--color-subtle);
  }

  .base {
    color: var(--color-foreground);
  }

  .dot {
    width: 6px;
    height: 6px;
    flex: none;
    border-radius: 50%;
    background: var(--color-live);
  }

  .spacer {
    flex: 1;
    min-width: 4px;
  }

  .meta,
  .percent {
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  .percent {
    min-width: 40px;
    text-align: center;
  }

  .bar button.small {
    gap: 4px;
    display: inline-flex;
    align-items: center;
    flex: none;
  }

  .notice {
    margin: 0;
    padding: 6px 12px;
    flex: none;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .notice.bad {
    color: var(--color-danger);
  }

  /* -------------------------------------------------------------- the editor */

  .code {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    border-top: 1px solid var(--color-border);
    background: var(--color-surface-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--line);
  }

  .gutter {
    flex: none;
    width: 44px;
    padding: var(--pad) 8px var(--pad) 0;
    overflow: hidden;
    border-right: 1px solid var(--color-border);
    background: var(--color-surface-2);
    color: var(--color-subtle);
    text-align: right;
    user-select: none;
    z-index: 2;
  }

  .num {
    display: block;
    height: var(--line);
    font-variant-numeric: tabular-nums;
  }

  .num.on {
    color: var(--color-accent);
    font-weight: 600;
  }

  /* The band sits under the transparent text, so the highlighted line reads
     without a second copy of the file drawn over it. */
  .band {
    position: absolute;
    left: 44px;
    right: 0;
    height: var(--line);
    background: color-mix(in srgb, var(--color-accent) 16%, transparent);
    border-left: 2px solid var(--color-accent);
    pointer-events: none;
    z-index: 0;
  }

  .text {
    flex: 1;
    min-width: 0;
    height: auto;
    padding: var(--pad) 10px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--color-foreground);
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    /* Soft wrap off: a long line scrolls sideways rather than folding, which is
       what keeps a line number honest. */
    white-space: pre;
    overflow: auto;
    resize: none;
    z-index: 1;
  }

  .text:focus-visible {
    outline: none;
  }

  /* ------------------------------------------------------------- the picture */

  .viewport {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    border-top: 1px solid var(--color-border);
    touch-action: none;
    cursor: grab;
    /* The checkerboard is what tells a transparent picture from a white one. */
    background-color: var(--color-surface-2);
    background-image:
      linear-gradient(45deg, var(--color-surface-3) 25%, transparent 25%),
      linear-gradient(-45deg, var(--color-surface-3) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--color-surface-3) 75%),
      linear-gradient(-45deg, transparent 75%, var(--color-surface-3) 75%);
    background-size: 16px 16px;
    background-position:
      0 0,
      0 8px,
      8px -8px,
      -8px 0;
  }

  .viewport:active {
    cursor: grabbing;
  }

  .picture {
    position: absolute;
    /* The size is the one the zoom computed, never the browser's own fit. */
    image-rendering: auto;
    user-select: none;
  }

  /* --------------------------------------------------------- the two players */

  .player {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
    border-top: 1px solid var(--color-border);
    background: var(--color-surface-2);
  }

  .media {
    max-width: 100%;
    max-height: 100%;
  }

  .sound {
    width: 100%;
  }

  .blob {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 10px 12px;
    border-top: 1px solid var(--color-border);
  }

  .blob .meta {
    margin: 0;
    padding: 0 0 4px;
    color: var(--color-muted-foreground);
  }

  .download {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--control-sm);
    padding: 0 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    color: var(--color-foreground);
    font-size: var(--text-xs);
    text-decoration: none;
  }

  .download:hover {
    background: var(--color-surface-3);
  }
</style>
