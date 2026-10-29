<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { Settings } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { clampSidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from '../lib/prefs';
  import { strings } from '../lib/strings';
  import { experimentOn } from '../lib/experiments.svelte';
  import { pinnedQuotas } from '../lib/pinned-quotas.svelte';
  import { work } from '../lib/work-prefs.svelte';
  import { controlMenu } from '../lib/controls';
  import LimitsGlance from './LimitsGlance.svelte';
  import WhipButton from './WhipButton.svelte';
  import Deferred, { parts } from './Deferred.svelte';
  import ResizeHandle from './ResizeHandle.svelte';

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

  let rail = $state<HTMLElement | undefined>(undefined);
  const phone = new MediaQuery('(max-width: 720px)');
  let dockVisible = $derived(phone.current ? kind === 'sidebar' && store.sidebarOpen : !store.sidebarCollapsed);
  let folded: boolean | undefined;
  /**
   * Whether this list was folded since it was drawn. Only then does its
   * arrival slide in from the window's edge: a list drawn by a page change
   * (Threads to Agents, back from Settings) or at boot replaces the one that
   * stood there, so it stands still and only its rows change.
   */
  let wasFolded = $state(untrack(() => store.sidebarCollapsed));
  let sliding: ReturnType<typeof setTimeout> | undefined;
  let marked: HTMLElement | undefined;

  function unmark(): void {
    clearTimeout(sliding);
    if (marked) delete marked.dataset.railSliding;
    marked = undefined;
  }

  /**
   * Marks the body row while the list folds or unfolds, so the chat card's own
   * left gap eases in step (app.css); the boot and a page change move that gap
   * at once. An attribute, since Svelte rewrites the row's class list. Before
   * the DOM update, so the mark and the fold reach the same style pass.
   */
  $effect.pre(() => {
    const now = store.sidebarCollapsed;
    const was = folded;
    folded = now;
    if (now) wasFolded = true;
    const row = untrack(() => rail)?.parentElement;
    if (was === undefined || was === now || !row) return;
    unmark();
    row.dataset.railSliding = '';
    marked = row;
    sliding = setTimeout(unmark, 600);
  });

  // Gone before the slide ends (Settings opened at once): the row's next gap
  // change, a page change, must not ease.
  $effect(() => unmark);

  let resizeFrom = 0;
</script>

<aside
  bind:this={rail}
  class="rail {kind}"
  class:drawer
  class:open={drawer && store.sidebarOpen}
  class:collapsed={store.sidebarCollapsed}
  class:was-folded={wasFolded}
  style:--sidebar-width={`${store.sidebarWidth}px`}
  aria-label={label}
  data-testid={testid}
  data-quota-dock-target=""
>
  <div class="views">{@render head()}</div>
  {@render subhead?.()}
  <div class="scroll" data-project-list={kind === 'sidebar' ? '' : undefined} bind:this={scroller} {onscroll}>
    {@render children()}
  </div>
  {#if (store.page === 'chat' || store.page === 'agents') && dockVisible && experimentOn('pinned-quotas') && pinnedQuotas.current.pinned && pinnedQuotas.wantsDock(store)}
    <Deferred part={parts.PinnedQuota} quiet>{#snippet children(PinnedQuota)}<PinnedQuota {store} dock />{/snippet}</Deferred>
  {/if}
  <div class="foot">
    {@render lead?.()}
    <span class="grow"></span>
    {@render foot?.()}
    <Deferred part={parts.UpdatesNotice} quiet>{#snippet children(UpdatesNotice)}<UpdatesNotice />{/snippet}</Deferred>
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
      data-preload-view="settings"
      onclick={() => store.showSettings()}><Settings size={16} /></button
    >
  </div>
  <div class="resize">
    <ResizeHandle
      orientation="vertical"
      edge="right"
      label={strings.sidebar.resize}
      testid={kind === 'sidebar' ? 'sidebar-resize' : 'agents-resize'}
      value={store.sidebarWidth}
      min={SIDEBAR_MIN}
      max={SIDEBAR_MAX}
      onstart={() => { resizeFrom = store.sidebarWidth; }}
      onmove={(delta) => (store.sidebarWidth = clampSidebar(resizeFrom + delta))}
      onend={() => store.setSidebarWidth(store.sidebarWidth)}
      onstep={(delta) => store.setSidebarWidth(store.sidebarWidth + delta)}
      onreset={() => store.setSidebarWidth(SIDEBAR_DEFAULT)}
    />
  </div>
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
    /* No rule above or below the rows: they fade out under the head and the
       foot. The fade is exactly the padding, so at rest it covers nothing; a
       mask, not a scroll-driven animation, because tests and closing elements
       wait on every running animation and that one would never end. */
    --fade: 10px;
    /* Shorter on top: the head's tools sit right above, and a deeper fade
       there opened a wider gap under them than between them and the switch. */
    --fade-top: 6px;
    padding: var(--fade-top) 6px var(--fade);
    display: flex;
    flex-direction: column;
    mask-image: linear-gradient(to bottom, transparent, black var(--fade-top), black calc(100% - var(--fade)), transparent);
  }
  .scroll > :global(*) { flex-shrink: 0; }
  .foot {
    display: flex;
    /* The machine button alone on the left, the others together on the
       right, at the bottom: square targets as tall as the composer's, whose
       lower edge meets the chat card's instead of floating above it. */
    align-items: flex-end;
    gap: 4px;
    box-sizing: border-box;
    margin: 0 10px;
    padding-top: 8px;
  }
  .grow { flex: 1; }
  /* Five square buttons and their gaps need 220 pixels: below that, the
     update button's arrival closes the gaps instead of pushing Settings out. */
  @container sidebar (max-width: 219.98px) {
    .foot:has(:global(.update-trigger)) { gap: 0; }
  }
  .control {
    display: contents;
  }
  .foot :global(button.icon) {
    flex: none;
    width: var(--control-lg);
    height: var(--control-lg);
  }
  .foot :global(.machines) { min-width: var(--control-lg); }
  .foot :global(.machines .menu),
  .foot :global(.machines .trigger) { height: var(--control-lg); max-width: 100%; }
  .foot :global(.machines .trigger:not(:has(.name))) { width: var(--control-lg); }
  /* With one machine the wrapper stays, empty, for its connection state. */
  .foot :global(.machines:not(:has(.trigger))) { display: none; }
  .foot :global(button.icon.active) { background: var(--color-active); color: var(--color-foreground); }

  /* The edge that drags the width, centred in the frame gap (ResizeHandle). */
  .resize { display: contents; }
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
    /* Unfolding only (`wasFolded`): a list drawn open stands where it is. */
    @starting-style { .rail.was-folded:not(.collapsed) { opacity: 0; margin-left: calc(-1 * var(--slide-room)); } }
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
