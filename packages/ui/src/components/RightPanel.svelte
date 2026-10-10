<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Plus, X, GripHorizontal, PanelsTopLeft } from '@lucide/svelte';
  import { floatingPanel, RESIZE_DIRECTIONS } from '../lib/floating-panel';
  import { DEFAULT_BROWSER_PROFILE, PRIVATE_BROWSER_PROFILE } from '@boite/contracts';
  import { browserBridge } from '../lib/browser-bridge';
  import { browserProfiles } from '../lib/browser-profiles.svelte';
  import { stripOverflows } from '../lib/strip-overflow';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { controlMenu, CONTROLS_SECTION } from '../lib/controls';
  import type { ControlId } from '../lib/work-prefs.svelte';
  import { separator } from '../lib/menu';
  import { closeTabs } from '../lib/panel-close';
  import { rightPanel } from '../lib/right-panel.svelte';
  import type { BoundPanel, Surface, SurfaceKind } from '../lib/right-panel.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { offeredCards, available as availableTo, kindName, label, tooltip, unavailable } from '../lib/surface-labels';
  import BrowserSurface from './BrowserSurface.svelte';
  import AgentBrowserSurface from './AgentBrowserSurface.svelte';
  import DelegationSurface from './DelegationSurface.svelte';
  import AgentMessagesSurface from './AgentMessagesSurface.svelte';
  import ChangesSurface from './ChangesSurface.svelte';
  import DeviceSurface from './DeviceSurface.svelte';
  import FileSurface from './FileSurface.svelte';
  import FilesSurface from './FilesSurface.svelte';
  import Menu from './Menu.svelte';
  import PanelResizeHandle from './PanelResizeHandle.svelte';
  import SurfaceIcon from './SurfaceIcon.svelte';
  import SurfaceLauncher from './SurfaceLauncher.svelte';
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
  /** The new-surface menu's last row, which no surface kind can be called. */
  const CUSTOMIZE = 'customize';

  let tabs = $state<HTMLDivElement | undefined>(undefined);
  let root = $state<HTMLElement | undefined>(undefined);
  let overflowing = $state(false);
  let dragging = $state(false);
  let near = $state(false);
  /**
   * Off while the panel slides in: its tabs and surface arrive with it, and
   * their own entrances would add a second movement on top. A tab opened or
   * picked after that plays its own.
   */
  let entered = $state(false);

  function onanimationend(event: AnimationEvent): void {
    if (event.target === event.currentTarget && !closing) entered = true;
    onexit(event);
  }

  // A floating panel, reduced motion past its frame, or a test environment has
  // no entrance whose end could say so.
  onMount(() => {
    if (!root || typeof root.getAnimations !== 'function' || root.getAnimations().length === 0) entered = true;
  });

  /**
   * `use:` on a tab or a surface: one created once the panel is in plays its
   * entrance. Decided at creation, so the panel landing does not replay the
   * entrance of what came in with it. An attribute, since Svelte rewrites the
   * class list whenever `class:active` changes.
   */
  function arrive(node: HTMLElement): void {
    if (untrack(() => entered)) node.dataset.arriving = '';
  }

  let surfaces = $derived(panel.surfaces);
  let active = $derived(panel.active);
  let empty = $derived(surfaces.length === 0);

  /** The user's own browser needs the shell's webview, or the iframe a test page paints. */
  function available(kind: SurfaceKind): boolean {
    if (kind === 'browser' && !inShell) return browserBridge.paints;
    return availableTo(kind, inShell, store.owner);
  }

  function measure(): void {
    const node = tabs;
    // A strip with no width yet, a phone's sheet still coming in, has nothing to
    // measure: the observer calls again once it has one. Measured at zero, 44 px
    // chevrons wider than the tabs flipped the state on every run.
    if (!node || node.clientWidth === 0) return;
    const gap = parseFloat(getComputedStyle(node.parentElement ?? node).columnGap) || 0;
    const room = [...(node.parentElement?.querySelectorAll<HTMLElement>(':scope > .chev') ?? [])].reduce((sum, chevron) => sum + chevron.offsetWidth + gap, 0);
    overflowing = stripOverflows(node.scrollWidth, node.clientWidth, room, untrack(() => overflowing));
  }

  $effect(() => {
    const node = tabs;
    if (!node) return;
    // The strip is remeasured when its width or its content changes.
    void surfaces.length;
    untrack(measure);
    // jsdom lays nothing out and ships no ResizeObserver: the strip still renders.
    if (typeof ResizeObserver === 'undefined') return;
    // The chevrons resize the observed tabs: toggling them inside the callback
    // was a resize the observer could not deliver that frame (a loop error).
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
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
    const card = offeredCards().find((one) => one.key.toLowerCase() === key);
    if (!card) return;
    event.preventDefault();
    launch(card.kind);
  }

  /** The profiles a new browser tab can open in besides the default one, where this window paints pages. */
  function profileItems(kind: SurfaceKind) {
    if (kind !== 'browser' || !browserBridge.paints || !available(kind)) return [];
    const others = [DEFAULT_BROWSER_PROFILE, ...browserProfiles.list.map((profile) => profile.id)].filter((id) => id !== browserProfiles.defaultId);
    return [
      ...others.map((id) => ({ id: PROFILE_PICK + id, label: fill(strings.browserProfiles.newTabIn, { name: browserProfiles.name(id) }) })),
      { id: PROFILE_PICK + PRIVATE_BROWSER_PROFILE, label: strings.browserProfiles.newPrivateTab }
    ];
  }
  const PROFILE_PICK = 'browser-profile:';

  let menuItems = $derived([
    ...offeredCards().flatMap((card) => [{
      id: card.kind,
      label: kindName(card.kind),
      disabled: !available(card.kind),
      ...(available(card.kind) ? {} : { hint: unavailable(card.kind) })
    }, ...profileItems(card.kind)]),
    // The way back to a kind this device put away.
    separator('sep-customize'),
    { id: CUSTOMIZE, label: strings.controls.customize }
  ]);

  function pickNew(id: string): void {
    if (id === CUSTOMIZE) store.showSettings('appearance', CONTROLS_SECTION);
    else if (id.startsWith(PROFILE_PICK)) panel.open('browser', undefined, id.slice(PROFILE_PICK.length));
    else launch(id as SurfaceKind);
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<button
  type="button"
  class="sheet-scrim"
  class:floating={rightPanel.floating}
  class:closing
  aria-label={strings.common.close}
  onclick={() => panel.toggle()}
></button>

<aside
  class="panel framed"
  class:maximized={rightPanel.maximized}
  class:floating={rightPanel.floating}
  class:dragging
  class:closing
  class:entered
  style="--panel-width: {rightPanel.width}px"
  data-testid="right-panel"
  bind:this={root}
  use:attach
  use:floatingPanel={{ enabled: rightPanel.floating, maximized: rightPanel.maximized }}
  {onanimationend}
  onpointerenter={() => (near = true)}
  onpointerleave={() => (near = false)}
  onfocusin={() => (near = true)}
  onfocusout={(event) => {
    if (!root?.contains(event.relatedTarget as Node | null)) near = false;
  }}
>
  {#if !rightPanel.floating}<PanelResizeHandle {store} bind:dragging />{/if}

  <header class="strip" data-panel-move data-testid="panel-titlebar">
    {#if rightPanel.floating}
      <button type="button" class="ghost small icon move-handle" data-panel-move data-testid="panel-move"
        title={strings.browser.move} aria-label={strings.browser.move} disabled={rightPanel.maximized}>
        <GripHorizontal size={16} />
      </button>
    {/if}
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
          use:arrive
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
              <SurfaceIcon kind={surface.kind} size={14} />
            </span>
            <span class="cross"><X size={14} strokeWidth={2} /></span>
          </button>
          <span class="name ui-label">{label(surface)}</span>
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
        onpick={pickNew}
        placement="bottom"
        align="end"
        variant="ghost"
        label={strings.rightPanel.newSurface}
        testid="panel-add"
      >
        <Plus size={14} strokeWidth={1.75} />
      </Menu>
    {/if}

    <span class="spacer"></span>

    {#if rightPanel.floating}
      <button type="button" class="ghost small icon" data-testid="panel-dock"
        title={strings.browser.dock} aria-label={strings.browser.dock}
        onclick={() => { rightPanel.floating = false; rightPanel.maximized = false; }}>
        <PanelsTopLeft size={14} strokeWidth={1.75} />
      </button>
    {/if}

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
    <!-- Keyed on the tab, so picking another one fades its surface in rather
         than swapping it in one frame, the way a settings page arrives. -->
    {#key active?.id}
    <div class="surface" use:arrive>
    {#if active?.kind === 'agents'}
      <DelegationSurface {store} surface={active} {panel} />
    {:else if active?.kind === 'messages'}
      <AgentMessagesSurface {store} surface={active} {panel} />
    {:else if active?.kind === 'trace'}
      <TraceSurface {store} />
    {:else if active?.kind === 'browser'}
      {#key active.id}<BrowserSurface surface={active} {panel} {store} />{/key}
    {:else if active?.kind === 'agent-browser'}
      {#if store.openThread}
        {#key store.threadKey(store.openThread.id)}<AgentBrowserSurface {store} threadId={store.openThread.id} />{/key}
      {/if}
    {:else if active?.kind === 'changes'}
      <ChangesSurface {store} surface={active} {panel} />
    {:else if active?.kind === 'files'}
      <FilesSurface {store} surface={active} {panel} />
    {:else if active?.kind === 'file'}
      {#key active.id}
        <FileSurface {store} surface={active} {panel} />
      {/key}
    {:else if active?.kind === 'device'}
      {#if store.openThread}
        {#key store.threadKey(store.openThread.id)}<DeviceSurface {store} threadId={store.openThread.id} />{/key}
      {/if}
    {:else if active?.kind === 'tasks'}
      <TasksSurface {store} />
    {:else}
      <SurfaceLauncher
        {available}
        onlaunch={launch}
        onmenu={(event, kind) => controlMenu(event, store, `panel.${kind}` as ControlId)}
        oncustomize={() => store.showSettings('appearance', CONTROLS_SECTION)}
      />
    {/if}
    </div>
    {/key}
  </div>
  {#if rightPanel.floating && !rightPanel.maximized}
    {#each RESIZE_DIRECTIONS as direction}
      <button type="button" class="float-resize" data-panel-resize={direction} data-testid={`panel-resize-${direction}`}
        aria-label={strings.rightPanel.resize}></button>
    {/each}
  {/if}
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
    /* A framed card whose resize handle hangs out into the gap beside it, so
       the card itself does not clip: its body rounds the bottom corners. */
    overflow: visible;
    /* It comes in from the window's right edge and the chat narrows with it,
       at its own width all along, so nothing inside rewraps on the way. */
    --slide-room: calc(var(--panel-width) + var(--frame-gap));
    animation: slide-left var(--dur-slide) var(--ease-slide);
  }

  .panel.closing {
    animation: slide-right-out var(--dur-slide-out) var(--ease-slide);
    pointer-events: none;
  }

  /* Maximized, it already fills the room the chat leaves: it fades in place. */
  .panel.maximized {
    animation: fade var(--dur-3) var(--ease-out-quint);
  }

  .panel.maximized.closing {
    animation: fade-out var(--dur-2) var(--ease-out-quint);
  }

  .panel.maximized {
    width: auto;
    flex: 1;
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
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  /* A new tab opens from its left edge into the strip, the way the strip reads. */
  .tab:global([data-arriving]) {
    animation: tab-in var(--dur-3) var(--ease-out-quint);
  }

  @keyframes tab-in {
    from {
      opacity: 0;
      transform: translateX(-6px);
    }
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

  .surface {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* Opacity only: a browser tab's page is a native view laid over this box,
     and a moving box would drag it along. */
  .surface:global([data-arriving]) {
    animation: fade var(--dur-3) var(--ease-out-quint);
  }

  @media (min-width: 721px) {
    .body {
      overflow: clip;
      border-radius: 0 0 calc(var(--radius-frame) - 1px) calc(var(--radius-frame) - 1px);
    }
  }

  .sheet-scrim {
    display: none;
  }

  /* Under 981 px the panel stops being a column and lies over the chat. */
  @media (max-width: 980px) {
    .panel,
    .panel.maximized {
      position: absolute;
      right: var(--frame-gap);
      top: 0;
      bottom: var(--frame-gap);
      z-index: 30;
      width: min(42vw, 448px);
      min-width: 320px;
      flex: none;
      box-shadow: var(--shadow-e3);
      /* Over the chat it takes no room: it slides across from the right edge. */
      --slide-room: calc(100% + var(--frame-gap));
      animation: slide-over-left var(--dur-slide) var(--ease-slide);
    }

    .panel.closing,
    .panel.maximized.closing {
      animation: slide-over-right-out var(--dur-slide-out) var(--ease-slide);
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
      animation: fade var(--dur-slide) var(--ease-slide);
    }

    .sheet-scrim.closing {
      animation: fade-out var(--dur-slide-out) var(--ease-slide);
      pointer-events: none;
    }
  }

  @media (max-width: 720px) {
    .panel,
    .panel.maximized {
      position: fixed;
      inset: 0;
      width: auto;
      min-width: 0;
      background: var(--color-surface);
      box-shadow: none;
      /* The sheet covers the whole screen, the status bar and the home indicator included. */
      box-sizing: border-box;
      padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    }

    .sheet-scrim {
      display: none;
    }

    /* The tab's icon is its close button: a finger needs the whole height of the tab. */
    .tab {
      padding-left: 0;
    }

    .closer {
      width: var(--touch-target);
      height: var(--touch-target);
    }
  }

  .panel.floating {
    position: fixed;
    inset: auto;
    left: var(--float-x);
    top: var(--float-y);
    width: var(--float-width);
    height: var(--float-height);
    min-width: 0;
    flex: none;
    z-index: 34;
    background: var(--color-surface);
    box-shadow: var(--shadow-e3);
  }
  /* A floating panel appears where it was left and fades away from there. */
  .panel.floating:not(.closing) { animation: none; }
  .panel.floating.closing { animation: fade-out var(--dur-2) var(--ease-out-quint); }
  /* Once in, maximizing, docking or a narrower window changes the entrance
     rule; without this the new one would play again on the open panel. */
  .panel.entered:not(.closing) { animation: none; }
  .sheet-scrim.floating { display: none; }
  .panel.floating:not(.maximized) .strip { cursor: grab; touch-action: none; user-select: none; }
  .panel.floating:not(.maximized) .strip:active { cursor: grabbing; }
  .move-handle { cursor: grab; touch-action: none; }
  .move-handle:active { cursor: grabbing; }
  .float-resize {
    /* Outside the native webview: its OS surface would swallow inside handles. */
    position: absolute; z-index: 1; padding: 0; min-width: 0; min-height: 0;
    border: none; border-radius: 0; background: transparent; touch-action: none;
  }
  .float-resize[data-panel-resize='n'], .float-resize[data-panel-resize='s'] {
    left: 6px; right: 6px; height: 6px; width: auto; cursor: ns-resize;
  }
  .float-resize[data-panel-resize='e'], .float-resize[data-panel-resize='w'] {
    top: 6px; bottom: 6px; width: 6px; height: auto; cursor: ew-resize;
  }
  .float-resize[data-panel-resize='n'] { top: -6px; }
  .float-resize[data-panel-resize='s'] { bottom: -6px; }
  .float-resize[data-panel-resize='e'] { right: -6px; }
  .float-resize[data-panel-resize='w'] { left: -6px; }
  .float-resize[data-panel-resize='nw'], .float-resize[data-panel-resize='ne'],
  .float-resize[data-panel-resize='sw'], .float-resize[data-panel-resize='se'] { width: 12px; height: 12px; }
  .float-resize[data-panel-resize='nw'] { left: -6px; top: -6px; cursor: nwse-resize; }
  .float-resize[data-panel-resize='ne'] { right: -6px; top: -6px; cursor: nesw-resize; }
  .float-resize[data-panel-resize='sw'] { left: -6px; bottom: -6px; cursor: nesw-resize; }
  .float-resize[data-panel-resize='se'] { right: -6px; bottom: -6px; cursor: nwse-resize; }
  .float-resize:focus-visible {
    outline: 2px solid var(--color-foreground); outline-offset: 0;
  }
  .float-resize:active { transform: none; }
  .float-resize:hover:not(:disabled), .float-resize:active { background: transparent; box-shadow: none; }
  @media (max-width: 720px) {
    .move-handle, .float-resize { display: none; }
  }
</style>
