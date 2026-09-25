<script lang="ts">
  import {
    Activity,
    ChevronLeft,
    ChevronRight,
    FileText,
    FolderTree,
    GitCompare,
    Globe,
    ListChecks,
    Maximize2,
    Minimize2,
    Plus,
    UsersRound,
    X
  } from '@lucide/svelte';
  import { browserBridge } from '../lib/browser-bridge';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { separator } from '../lib/menu';
  import { closeTabs } from '../lib/panel-close';
  import { PANEL_DEFAULT, baseName, clampPanel, rightPanel } from '../lib/right-panel.svelte';
  import type { BoundPanel, Surface, SurfaceKind } from '../lib/right-panel.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import BrowserSurface from './BrowserSurface.svelte';
  import DelegationSurface from './DelegationSurface.svelte';
  import ChangesSurface from './ChangesSurface.svelte';
  import FileSurface from './FileSurface.svelte';
  import FilesSurface from './FilesSurface.svelte';
  import Menu from './Menu.svelte';
  import TasksSurface from './TasksSurface.svelte';
  import TraceSurface from './TraceSurface.svelte';

  let {
    store,
    panel,
    closing = false,
    attach,
    onexit
  }: {
    store: Store;
    panel: BoundPanel;
    /** Set by `App.svelte` while the panel plays its exit, just before it unmounts. */
    closing?: boolean;
    attach: (node: HTMLElement) => { destroy: () => void };
    onexit: (event: AnimationEvent) => void;
  } = $props();

  const inShell = window.__TAURI_INTERNALS__ !== undefined;

  let tabs = $state<HTMLDivElement | undefined>(undefined);
  let root = $state<HTMLElement | undefined>(undefined);
  let overflowing = $state(false);
  let dragging = $state(false);
  let near = $state(false);

  let surfaces = $derived(panel.surfaces);
  let active = $derived(panel.active);
  let empty = $derived(surfaces.length === 0);

  /**
   * The launcher's five cards, in the order they are drawn. Each carries the
   * letter its card shows, which is also the key the launcher answers to.
   */
  const CARDS: { kind: SurfaceKind; key: string }[] = [
    { kind: 'agents', key: 'A' },
    { kind: 'browser', key: 'B' },
    { kind: 'changes', key: 'C' },
    { kind: 'files', key: 'F' },
    { kind: 'tasks', key: 'K' },
    { kind: 'trace', key: 'T' }
  ];

  /** The name of a kind, which a card, a tab and the new-surface menu all read. */
  function kindName(kind: SurfaceKind): string {
    if (kind === 'agents') return strings.delegation.heading;
    if (kind === 'browser') return strings.rightPanel.browser;
    if (kind === 'changes') return strings.rightPanel.changes;
    if (kind === 'files') return strings.rightPanel.files;
    if (kind === 'file') return strings.rightPanel.file;
    if (kind === 'tasks') return strings.rightPanel.tasks;
    return strings.rightPanel.trace;
  }

  function kindHint(kind: SurfaceKind): string {
    if (kind === 'agents') return strings.delegation.panelHint;
    if (kind === 'browser') return strings.rightPanel.browserHint;
    if (kind === 'changes') return strings.rightPanel.changesHint;
    if (kind === 'files') return strings.rightPanel.filesHint;
    if (kind === 'tasks') return strings.rightPanel.tasksHint;
    return strings.rightPanel.traceHint;
  }

  /** A page needs a webview; everything else reads what only the owner may ask for. */
  function available(kind: SurfaceKind): boolean {
    if (kind === 'agents') return true;
    return kind === 'browser' ? inShell : store.owner;
  }

  function unavailable(kind: SurfaceKind): string {
    return kind === 'browser' ? strings.rightPanel.desktopOnly : strings.rightPanel.ownerOnly;
  }

  function label(surface: Surface): string {
    // A file tab reads as its name; the whole path is its tooltip.
    if (surface.kind === 'file') return surface.path ? baseName(surface.path) : strings.rightPanel.file;
    if (surface.kind !== 'browser') return kindName(surface.kind);
    if (surface.title) return surface.title;
    if (surface.url) {
      try {
        return new URL(surface.url).host || strings.rightPanel.untitled;
      } catch {
        return surface.url;
      }
    }
    return strings.rightPanel.untitled;
  }

  function tooltip(surface: Surface): string {
    return surface.kind === 'file' && surface.path ? surface.path : label(surface);
  }

  // What the pages report. Only the thread showing has browser views, because a
  // thread that leaves takes them with it in the effect below, so one listener
  // on the bound panel is the whole story.
  $effect(() => {
    const bound = panel;
    return browserBridge.on((event) => {
      if (event.type === 'new-window') {
        // A page asked for a window of its own and was refused one: it opens
        // beside the tab that asked, which is where the user is looking.
        bound.open('browser', event.url);
      } else if (event.type === 'url') {
        // A blank tab is a tab with no address, not one pointed at `about:blank`.
        if (event.url !== 'about:blank') bound.update(event.id, { url: event.url });
      } else if (event.type === 'title') {
        bound.update(event.id, { title: event.title });
      } else if (event.type === 'failed') {
        console.warn(`[browser] the surface ${event.id} refused: ${event.reason}`);
      }
    });
  });

  // A browser tab that left the strip takes its view with it. The surface's own
  // teardown only parks the view, because a tab keeps its page while it is hidden.
  let known = new Set<string>();
  $effect(() => {
    const live = new Set(
      surfaces.filter((surface) => surface.kind === 'browser').map((surface) => surface.id)
    );
    for (const id of known) if (!live.has(id)) browserBridge.destroy(id);
    known = live;
  });

  function measure(): void {
    const node = tabs;
    if (!node) return;
    overflowing = node.scrollWidth - node.clientWidth > 1;
  }

  $effect(() => {
    const node = tabs;
    if (!node) return;
    // The strip is remeasured when its width or its content changes.
    void surfaces.length;
    measure();
    // jsdom lays nothing out and ships no ResizeObserver: the strip still renders.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  });

  // The tab that is showing is always the one in view.
  $effect(() => {
    const id = panel.activeSurfaceId;
    if (!id || !tabs) return;
    const tab = tabs.querySelector<HTMLElement>(`[data-surface-id="${CSS.escape(id)}"]`);
    // jsdom has no layout, so it has no `scrollIntoView` either.
    tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });

  function scrollBy(direction: -1 | 1): void {
    const node = tabs;
    if (!node) return;
    const step = Math.max(120, Math.round(node.clientWidth * 0.75));
    node.scrollBy({ left: step * direction, behavior: 'smooth' });
  }

  function onwheel(event: WheelEvent): void {
    const node = tabs;
    if (!node || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    node.scrollLeft += event.deltaY;
  }

  function openTabMenu(event: MouseEvent, surface: Surface): void {
    const index = surfaces.findIndex((one) => one.id === surface.id);
    contextMenu.open(
      event,
      [
        { id: 'close', label: strings.rightPanel.close },
        { id: 'others', label: strings.rightPanel.closeOthers, disabled: surfaces.length < 2 },
        {
          id: 'right',
          label: strings.rightPanel.closeToRight,
          disabled: index < 0 || index === surfaces.length - 1
        },
        separator(),
        { id: 'all', label: strings.rightPanel.closeAll }
      ],
      (action) => {
        if (action === 'close' || action === 'others' || action === 'right' || action === 'all') {
          void closeTabs(panel, action, surface.id);
        }
      }
    );
  }

  function onTabPointerDown(event: MouseEvent, surface: Surface): void {
    if (event.button !== 1) return;
    // The middle button scrolls by default; the tab closes instead.
    event.preventDefault();
    void closeTabs(panel, 'close', surface.id);
  }

  function onTabKey(event: KeyboardEvent, surface: Surface): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      panel.activate(surface.id);
    }
  }

  /** The arrows walk the strip, the way a tablist is expected to answer them. */
  function onTabsKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const node = tabs;
    if (!node) return;
    const list = Array.from(node.querySelectorAll<HTMLElement>('[role="tab"]'));
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (list.length === 0 || index < 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    list[(index + step + list.length) % list.length]?.focus();
  }

  function launch(kind: SurfaceKind): void {
    // A key reaches this with no card to disable, and a surface a paired device
    // may not read would open empty.
    if (!available(kind)) return;
    panel.open(kind);
  }

  /** A card's letter while the launcher shows and the panel has the pointer or the focus. */
  function onWindowKey(event: KeyboardEvent): void {
    if (!empty || !near) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    const card = CARDS.find((one) => one.key.toLowerCase() === key);
    if (!card) return;
    event.preventDefault();
    launch(card.kind);
  }

  // ---------------------------------------------------------------- the drag

  function sibling(): number {
    if (window.innerWidth <= 720 || store.sidebarCollapsed) return 0;
    return store.sidebarWidth;
  }

  function onHandleDown(event: PointerEvent): void {
    event.preventDefault();
    dragging = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onHandleMove(event: PointerEvent): void {
    if (!dragging) return;
    rightPanel.width = clampPanel(window.innerWidth - event.clientX, window.innerWidth, sibling());
  }

  function onHandleUp(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    // The width reaches localStorage once, on the drag's end.
    rightPanel.saveWidth();
  }

  function onHandleKey(event: KeyboardEvent): void {
    const step = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0;
    if (step === 0) return;
    event.preventDefault();
    rightPanel.width = clampPanel(rightPanel.width + step, window.innerWidth, sibling());
    rightPanel.saveWidth();
  }

  function reset(): void {
    rightPanel.width = clampPanel(PANEL_DEFAULT, window.innerWidth, sibling());
    rightPanel.saveWidth();
  }

  let menuItems = $derived(
    CARDS.map((card) => ({
      id: card.kind,
      label: kindName(card.kind),
      disabled: !available(card.kind),
      ...(available(card.kind) ? {} : { hint: unavailable(card.kind) })
    }))
  );
</script>

<svelte:window onkeydown={onWindowKey} />

<button
  type="button"
  class="sheet-scrim"
  aria-label={strings.common.close}
  onclick={() => panel.toggle()}
></button>

<aside
  class="panel"
  class:maximized={rightPanel.maximized}
  class:dragging
  class:closing
  style="--panel-width: {rightPanel.width}px"
  data-testid="right-panel"
  bind:this={root}
  use:attach
  onanimationend={onexit}
  onpointerenter={() => (near = true)}
  onpointerleave={() => (near = false)}
  onfocusin={() => (near = true)}
  onfocusout={(event) => {
    if (!root?.contains(event.relatedTarget as Node | null)) near = false;
  }}
>
  <button
    type="button"
    class="handle"
    aria-label={strings.rightPanel.resize}
    title={strings.rightPanel.resize}
    data-testid="panel-resize"
    onpointerdown={onHandleDown}
    onpointermove={onHandleMove}
    onpointerup={onHandleUp}
    onpointercancel={onHandleUp}
    ondblclick={reset}
    onkeydown={onHandleKey}
  ></button>

  <header class="strip">
    {#if overflowing}
      <button
        type="button"
        class="ghost small icon chev"
        title={strings.rightPanel.scrollLeft}
        aria-label={strings.rightPanel.scrollLeft}
        onclick={() => scrollBy(-1)}
      >
        <ChevronLeft size={14} strokeWidth={1.75} />
      </button>
    {/if}

    <div
      class="tabs"
      role="tablist"
      tabindex="-1"
      bind:this={tabs}
      {onwheel}
      onkeydown={onTabsKey}
      data-testid="panel-tabs"
    >
      {#each surfaces as surface (surface.id)}
        <div
          class="tab"
          class:active={surface.id === panel.activeSurfaceId}
          role="tab"
          tabindex="0"
          aria-selected={surface.id === panel.activeSurfaceId}
          data-surface-id={surface.id}
          data-kind={surface.kind}
          data-testid="panel-tab"
          title={tooltip(surface)}
          onclick={() => panel.activate(surface.id)}
          onkeydown={(event) => onTabKey(event, surface)}
          onmousedown={(event) => onTabPointerDown(event, surface)}
          oncontextmenu={(event) => openTabMenu(event, surface)}
        >
          <button
            type="button"
            class="closer"
            aria-label={fill(strings.rightPanel.closeTab, { title: label(surface) })}
            data-testid="panel-tab-close"
            onclick={(event) => {
              event.stopPropagation();
              void closeTabs(panel, 'close', surface.id);
            }}
          >
            <span class="glyph">
              {#if surface.kind === 'trace'}
                <Activity size={14} strokeWidth={1.75} />
              {:else if surface.kind === 'agents'}
                <UsersRound size={14} strokeWidth={1.75} />
              {:else if surface.kind === 'changes'}
                <GitCompare size={14} strokeWidth={1.75} />
              {:else if surface.kind === 'files'}
                <FolderTree size={14} strokeWidth={1.75} />
              {:else if surface.kind === 'file'}
                <FileText size={14} strokeWidth={1.75} />
              {:else if surface.kind === 'tasks'}
                <ListChecks size={14} strokeWidth={1.75} />
              {:else}
                <Globe size={14} strokeWidth={1.75} />
              {/if}
            </span>
            <span class="cross"><X size={14} strokeWidth={2} /></span>
          </button>
          <span class="name">{label(surface)}</span>
        </div>
      {/each}
    </div>

    {#if overflowing}
      <button
        type="button"
        class="ghost small icon chev"
        title={strings.rightPanel.scrollRight}
        aria-label={strings.rightPanel.scrollRight}
        onclick={() => scrollBy(1)}
      >
        <ChevronRight size={14} strokeWidth={1.75} />
      </button>
    {/if}

    {#if !empty}
      <Menu
        items={menuItems}
        onpick={(id) => launch(id as SurfaceKind)}
        placement="bottom"
        variant="ghost"
        label={strings.rightPanel.newSurface}
        testid="panel-add"
      >
        <Plus size={14} strokeWidth={1.75} />
      </Menu>
    {/if}

    <span class="spacer"></span>

    <button
      type="button"
      class="ghost small icon"
      title={rightPanel.maximized ? strings.rightPanel.restore : strings.rightPanel.maximize}
      aria-label={rightPanel.maximized ? strings.rightPanel.restore : strings.rightPanel.maximize}
      aria-pressed={rightPanel.maximized}
      data-testid="panel-maximize"
      onclick={() => (rightPanel.maximized = !rightPanel.maximized)}
    >
      {#if rightPanel.maximized}
        <Minimize2 size={14} strokeWidth={1.75} />
      {:else}
        <Maximize2 size={14} strokeWidth={1.75} />
      {/if}
    </button>
    <button
      type="button"
      class="ghost small icon"
      title={strings.common.close}
      aria-label={strings.common.close}
      data-testid="panel-close"
      onclick={() => panel.toggle()}
    >
      <X size={14} strokeWidth={1.75} />
    </button>
  </header>

  <div class="body">
    {#if active?.kind === 'agents'}
      <DelegationSurface {store} />
    {:else if active?.kind === 'trace'}
      <TraceSurface {store} />
    {:else if active?.kind === 'browser'}
      {#key active.id}
        <BrowserSurface surface={active} {panel} {store} />
      {/key}
    {:else if active?.kind === 'changes'}
      <ChangesSurface {store} surface={active} {panel} />
    {:else if active?.kind === 'files'}
      <FilesSurface {store} surface={active} {panel} />
    {:else if active?.kind === 'file'}
      {#key active.id}
        <FileSurface {store} surface={active} {panel} />
      {/key}
    {:else if active?.kind === 'tasks'}
      <TasksSurface {store} />
    {:else}
      <div class="launcher" data-testid="panel-launcher">
        <p class="section-label">{strings.rightPanel.launcher}</p>
        <div class="cards">
          <!-- A card that cannot open stays and says why: a page needs the
               desktop shell's webview, and the rest read what a paired device
               is refused. -->
          {#each CARDS as card (card.kind)}
            <button
              type="button"
              class="card"
              disabled={!available(card.kind)}
              data-testid="launch-{card.kind}"
              onclick={() => launch(card.kind)}
            >
              {#if card.kind === 'browser'}
                <Globe size={16} strokeWidth={1.75} />
              {:else if card.kind === 'agents'}
                <UsersRound size={16} strokeWidth={1.75} />
              {:else if card.kind === 'changes'}
                <GitCompare size={16} strokeWidth={1.75} />
              {:else if card.kind === 'files'}
                <FolderTree size={16} strokeWidth={1.75} />
              {:else if card.kind === 'tasks'}
                <ListChecks size={16} strokeWidth={1.75} />
              {:else}
                <Activity size={16} strokeWidth={1.75} />
              {/if}
              <span class="card-name">{kindName(card.kind)}</span>
              <span class="card-hint">{available(card.kind) ? kindHint(card.kind) : unavailable(card.kind)}</span>
              <span class="kbd">{card.key}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</aside>

<style>
  .panel {
    position: relative;
    width: var(--panel-width);
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    border-left: 1px solid var(--color-border);
    background: var(--color-surface);
    /* Only the first open travels: a drag and a maximize are instant. */
    animation: panel-in var(--dur-3) var(--ease-out-quint);
  }

  .panel.maximized {
    width: auto;
    flex: 1;
  }

  /* The exit is opacity alone: the width would be horizontal travel on the way out. */
  .panel.closing {
    animation-name: fade-out;
    pointer-events: none;
  }

  @keyframes panel-in {
    from {
      width: 0;
      opacity: 0;
    }
  }

  .handle {
    position: absolute;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    left: -4px;
    top: 0;
    bottom: 0;
    width: 8px;
    z-index: 10;
    cursor: col-resize;
    touch-action: none;
  }

  .handle::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: transparent;
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .handle:hover:not(:disabled),
  .handle:active:not(:disabled) {
    background: transparent;
    transform: none;
  }

  .handle:hover::after,
  .handle:focus-visible::after {
    background: var(--color-border);
  }

  .panel.dragging .handle::after {
    background: color-mix(in srgb, var(--color-foreground) 60%, transparent);
  }

  .strip {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 44px;
    padding: 0 8px 0 8px;
    border-bottom: 1px solid var(--color-border);
    flex: none;
    min-width: 0;
  }

  /* The strip's controls are as tall as its tabs. */
  .strip button.small.icon,
  .strip :global(.trigger.ghost) {
    height: var(--control-sm);
    width: var(--control-sm);
  }

  .tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 2px;
    height: var(--control-sm);
    max-width: 144px;
    flex: none;
    padding: 0 8px 0 5px;
    border-radius: var(--radius-md);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    cursor: pointer;
    user-select: none;
    animation: rise var(--dur-3) var(--ease-out-quint);
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  .tab:hover {
    background: var(--color-hover);
    color: var(--color-foreground);
  }

  .tab.active {
    background: var(--color-active);
    color: var(--color-foreground);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .closer {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    flex: none;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
  }

  .closer:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-foreground) 12%, transparent);
  }

  .closer:active:not(:disabled) {
    transform: none;
    background: color-mix(in srgb, var(--color-foreground) 22%, transparent);
  }

  .cross {
    display: none;
  }

  .glyph,
  .cross {
    align-items: center;
    justify-content: center;
  }

  /* The surface's own icon is the close target: it turns into an X under the
     pointer, and under the keyboard too as soon as the tab holds the focus. */
  .tab:hover .glyph,
  .tab:focus-within .glyph,
  .closer:focus-visible .glyph {
    display: none;
  }

  .tab:hover .cross,
  .tab:focus-within .cross,
  .closer:focus-visible .cross {
    display: inline-flex;
  }

  .chev {
    flex: none;
  }

  .spacer {
    flex: 1;
    min-width: 4px;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .launcher {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .cards {
    display: grid;
    /* Five cards now, on a panel dragged to any width: the row fills with what
       fits instead of staying at two columns. */
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }

  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    height: auto;
    padding: 12px 12px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    color: var(--color-muted-foreground);
    text-align: left;
    white-space: normal;
  }

  .card:hover:not(:disabled) {
    border-color: var(--color-edge);
    background: var(--color-surface-3);
  }

  .card-name {
    color: var(--color-foreground);
    font-weight: 600;
    margin-top: 6px;
  }

  .card-hint {
    font-size: var(--text-sm);
    line-height: 1.4;
  }

  .card .kbd {
    position: absolute;
    top: 8px;
    right: 8px;
  }

  .sheet-scrim {
    display: none;
  }

  /* Under 981 px the panel stops being a column and lies over the chat. */
  @media (max-width: 980px) {
    .panel,
    .panel.maximized {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      z-index: 30;
      width: min(42vw, 448px);
      min-width: 320px;
      flex: none;
      box-shadow: var(--shadow-e3);
    }

    .sheet-scrim {
      display: block;
      position: absolute;
      inset: 0;
      z-index: 29;
      height: auto;
      padding: 0;
      border: none;
      border-radius: 0;
      background: var(--color-scrim);
    }

    .handle {
      display: none;
    }
  }

  @media (max-width: 720px) {
    .panel,
    .panel.maximized {
      position: fixed;
      inset: 0;
      width: auto;
      min-width: 0;
      border-left: none;
      box-shadow: none;
      /* The sheet covers the whole screen, the status bar and the home indicator included. */
      box-sizing: border-box;
      padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    }

    .sheet-scrim {
      display: none;
    }
  }
</style>
