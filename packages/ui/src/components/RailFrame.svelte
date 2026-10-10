<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Settings } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { clampSidebar, SIDEBAR_DEFAULT } from '../lib/prefs';
  import { strings } from '../lib/strings';
  import { experimentOn } from '../lib/experiments.svelte';
  import { work } from '../lib/work-prefs.svelte';
  import { controlMenu } from '../lib/controls';
  import LimitsGlance from './LimitsGlance.svelte';
  import WhipButton from './WhipButton.svelte';

  /**
   * The column on the left of the window, for the thread list and the Agents
   * list alike: one width the user drags, one fold from the title bar, the
   * head on top, an optional subhead that stays put (the Agents search), the
   * rows in one scroll, and one foot ending on the limits and Settings. Each
   * list fills the head, the rows and the foot's own buttons, and may fill the
   * subhead and the foot's lead (the thread list's machine button).
   *
   * `drawer` is the thread list's phone form, a sheet over the chat; the Agents
   * list is a whole screen on a phone and stays in the flow.
   */
  let {
    store,
    kind,
    label,
    testid,
    drawer = false,
    scroller = $bindable(),
    onscroll,
    head,
    subhead,
    children,
    lead,
    foot
  }: {
    store: Store;
    kind: 'sidebar' | 'agents-rail';
    label?: string;
    testid?: string;
    drawer?: boolean;
    scroller?: HTMLDivElement;
    onscroll?: () => void;
    head: Snippet;
    /** What stays put between the head and the rows, like the Agents search. */
    subhead?: Snippet;
    children: Snippet;
    /** The foot's left end, before the gap. */
    lead?: Snippet;
    /** The list's own buttons, right before the limits and Settings. */
    foot?: Snippet;
  } = $props();

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const start = event.clientX,
      width = store.sidebarWidth;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => (store.sidebarWidth = clampSidebar(width + e.clientX - start));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      store.setSidebarWidth(store.sidebarWidth);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
</script>

<aside
  class="rail {kind}"
  class:drawer
  class:open={drawer && store.sidebarOpen}
  class:collapsed={store.sidebarCollapsed}
  style:--sidebar-width={`${store.sidebarWidth}px`}
  aria-label={label}
  data-testid={testid}
>
  <div class="views">{@render head()}</div>
  {@render subhead?.()}
  <div class="scroll" data-project-list={kind === 'sidebar' ? '' : undefined} bind:this={scroller} {onscroll}>
    {@render children()}
  </div>
  <div class="foot">
    {@render lead?.()}
    <span class="grow"></span>
    {@render foot?.()}
    {#if work.shows('sidebar.limits')}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span class="control" oncontextmenu={(event) => controlMenu(event, store, 'sidebar.limits')}><LimitsGlance {store} /></span>
    {/if}
    {#if experimentOn('whip')}<WhipButton />{/if}
    <button
      class="ghost icon"
      title={`${strings.sidebar.settings}${store.keyHint('settings')}`}
      aria-label={strings.sidebar.settings}
      data-testid="nav-settings"
      onclick={() => store.showSettings()}><Settings size={16} /></button
    >
  </div>
  <button
    class="resize"
    aria-label={strings.sidebar.resize}
    title={strings.sidebar.resize}
    data-testid={kind === 'sidebar' ? 'sidebar-resize' : 'agents-resize'}
    onpointerdown={startResize}
    ondblclick={() => store.setSidebarWidth(SIDEBAR_DEFAULT)}
    onkeydown={(e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        store.setSidebarWidth(store.sidebarWidth + (e.key === 'ArrowLeft' ? -16 : 16));
      }
      if (e.key === 'Home') store.setSidebarWidth(SIDEBAR_DEFAULT);
    }}
  ></button>
</aside>

<style>
  /* The container name `sidebar` is also read by Sidebar.svelte's narrow-column layout. */
  .rail {
    container: sidebar / inline-size;
    position: relative;
    width: var(--sidebar-width);
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .views { margin: 0 10px; }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px 6px;
    display: flex;
    flex-direction: column;
  }
  .scroll > :global(*) { flex-shrink: 0; }
  .foot {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 41px;
    box-sizing: border-box;
    margin: 0 8px;
    padding: 6px 0;
    border-top: 1px solid var(--color-border);
  }
  .grow { flex: 1; }
  .control {
    display: contents;
  }
  .foot :global(button.icon) {
    flex: none;
    width: var(--control-sm);
    height: var(--control-sm);
  }
  /* The thread list's machine button sits alone on the left. */
  .foot :global(.machines) { min-width: var(--control-sm); }
  .foot :global(.machines .menu),
  .foot :global(.machines .trigger) { max-width: 100%; }
  .foot :global(button.icon.active) { background: var(--color-active); color: var(--color-foreground); }

  /* Centred in the frame's gap between the list and the card beside it. */
  .resize {
    position: absolute;
    top: 0;
    right: calc(var(--frame-gap) / -2 - 3px);
    bottom: 0;
    width: 6px;
    height: auto;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    cursor: col-resize;
    z-index: 5;
  }
  .resize:hover,
  .resize:focus-visible {
    background: var(--color-edge);
  }
  @media (min-width: 721px) {
    /* Folding slides it out past the window's left edge and the chat card
       widens with it: a margin as wide as the list and its gap gives that room
       back, so the chat never jumps. App.svelte eases the card's own left gap
       in step. */
    .rail {
      --slide-room: calc(var(--sidebar-width) + var(--frame-gap));
      transition: margin-left var(--dur-slide) var(--ease-slide), opacity var(--dur-3) var(--ease-out-quint), display var(--dur-slide) allow-discrete;
    }
    .rail.collapsed {
      display: none;
      pointer-events: none;
      opacity: 0;
      margin-left: calc(-1 * var(--slide-room));
      transition: margin-left var(--dur-slide-out) var(--ease-slide), opacity var(--dur-2) var(--ease-out-quint), display var(--dur-slide-out) allow-discrete;
    }
    @starting-style { .rail:not(.collapsed) { opacity: 0; margin-left: calc(-1 * var(--slide-room)); } }
  }
  @media (max-width: 720px) {
    .rail.drawer {
      background: var(--color-surface);
      border-right: 1px solid var(--color-border);
      position: fixed;
      inset: var(--titlebar) auto 0 0;
      z-index: 30;
      width: min(340px, 90vw);
      visibility: hidden;
      pointer-events: none;
      opacity: 0;
      /* A drawer from the left edge, where its button is. */
      transform: translateX(calc(-100% - 12px));
      transition: opacity var(--dur-3) var(--ease-out-quint), transform var(--dur-slide) var(--ease-slide), visibility var(--dur-slide);
      box-shadow: var(--shadow-e3);
    }
    .rail.drawer.open {
      visibility: visible;
      pointer-events: auto;
      opacity: 1;
      transform: none;
    }
    /* On a phone the list is the whole screen: no width to drag, and the tab bar
       below already leads to Settings. */
    .rail:not(.drawer) { width: auto; flex: 1; }
    .rail:not(.drawer) .views { margin: 0 12px; }
    .rail:not(.drawer) .foot,
    .resize {
      display: none;
    }
  }
</style>
