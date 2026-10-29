<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import type { ThreadId } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import DrawerTabs from './DrawerTabs.svelte';
  import ProjectBoard from './ProjectBoard.svelte';
  import ResizeHandle from './ResizeHandle.svelte';

  /**
   * The project board in the drawer under the chat, where the terminal opens:
   * Ctrl+J shows the tab picked last, the header switches. It takes the
   * terminal's height, kept per device, so the two tabs share one drawer.
   */
  let { store, threadId, closing, attach, onexit }: { store: Store; threadId: ThreadId; closing: boolean;
    attach: (node: HTMLElement) => { destroy: () => void }; onexit: (event: TransitionEvent) => void } = $props();

  /** The terminal drawer's: both tabs are one drawer to the user. */
  const HEIGHT_KEY = 'boite:terminal-height';
  const MIN_HEIGHT = 120;
  const DEFAULT_HEIGHT = 280;
  const narrow = new MediaQuery('(max-width: 720px)');

  let drawer = $state<HTMLElement | undefined>(undefined);
  let height = $state(readHeight());
  let room = $state(window.innerHeight);
  /** A phone's board starts at half the screen, the cards needing more than a shell's lines. */
  let wanted = $derived(narrow.current ? Math.max(height, Math.round(room * 0.5)) : height);
  let visibleHeight = $derived(Math.min(wanted, maxHeight()));
  let dragging = $state(false);
  let hideLabel = $derived(store.keyLabel('terminal'));
  let project = $derived(store.projects.find((entry) => entry.id === store.openThread?.projectId)?.name ?? '');

  function readHeight(): number {
    try {
      const stored = Number(localStorage.getItem(HEIGHT_KEY));
      return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT;
    } catch {
      return DEFAULT_HEIGHT;
    }
  }

  function maxHeight(): number {
    return Math.max(MIN_HEIGHT, Math.round(room * 0.7));
  }

  onMount(() => {
    const parent = drawer?.parentElement;
    if (!parent) return;
    room = parent.clientHeight;
    const observer = new ResizeObserver(() => { room = parent.clientHeight; });
    observer.observe(parent);
    return () => observer.disconnect();
  });

  let dragFrom = 0;

  function setHeight(next: number): void {
    height = Math.min(maxHeight(), Math.max(MIN_HEIGHT, Math.round(next)));
  }

  function saveHeight(): void {
    try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* private mode keeps the height for this session */ }
  }
</script>

<section class="drawer" class:closing class:dragging inert={closing} use:attach
  ontransitionend={(event) => { if (event.propertyName === 'height') onexit(event); }}
  style="--drawer-height: {visibleHeight}px" bind:this={drawer} data-testid="board-drawer">
  <div class="edge">
    <ResizeHandle
      orientation="horizontal"
      edge="top"
      label={strings.terminal.resize}
      testid="board-resize"
      value={visibleHeight}
      min={MIN_HEIGHT}
      max={maxHeight()}
      onstart={() => { dragFrom = visibleHeight; dragging = true; }}
      onmove={(delta) => setHeight(dragFrom - delta)}
      onend={() => { dragging = false; saveHeight(); }}
      onstep={(delta) => { setHeight(visibleHeight - delta); saveHeight(); }}
      onreset={() => { setHeight(DEFAULT_HEIGHT); saveHeight(); }}
    />
  </div>
  <div class="surface framed">
    <header>
      <DrawerTabs {store} current="board" />
      <span class="divider" aria-hidden="true"></span>
      <span class="project ui-label" title={project}>{project}</span>
      <span class="spacer"></span>
      <button
        type="button"
        class="ghost icon"
        title={hideLabel ? `${strings.board.hide} (${hideLabel})` : strings.board.hide}
        aria-label={strings.board.hide}
        data-testid="board-hide"
        onclick={() => store.hideBoard()}
      >
        <ChevronDown size={15} strokeWidth={1.75} />
      </button>
    </header>
    <div class="body">
      <ProjectBoard {store} {threadId} narrow={narrow.current} />
    </div>
  </div>
</section>

<style>
  /* Between the tabs and the project, as the terminal's drawer has it. */
  .divider {
    flex: none;
    width: 1px;
    height: 14px;
    margin: 0 2px;
    background: var(--color-border);
  }

  .drawer {
    position: relative;
    flex: none;
    min-height: 0;
    --drawer-gap: 0px;
    height: calc(var(--drawer-height) + var(--drawer-gap));
    overflow: clip;
    transition: height var(--dur-slide) var(--ease-slide);
  }

  @starting-style {
    .drawer { height: 0; }
  }

  .drawer.closing { height: 0; transition: height var(--dur-slide-out) var(--ease-slide); }
  .drawer.dragging { transition: none; }

  .surface {
    position: relative;
    display: flex;
    flex-direction: column;
    height: var(--drawer-height);
    margin-top: var(--drawer-gap);
    border-top: 1px solid var(--color-border);
  }

  @media (min-width: 721px) {
    .drawer { --drawer-gap: var(--frame-gap); }
    .surface { border-color: var(--color-frame-edge); }
  }

  /* The handle centred in the gap above the frame; on a phone, under its edge. */
  .edge {
    position: absolute;
    top: var(--drawer-gap);
    left: 0;
    right: 0;
    --resize-gap: var(--drawer-gap);
  }

  @media (max-width: 720px) {
    .edge { --resize-gap: -10px; }
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    flex: none;
    min-width: 0;
    padding: 0 6px 0 12px;
  }

  .project {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .spacer { flex: 1; }

  .icon {
    width: var(--control-sm);
    height: var(--control-sm);
    padding: 0;
    display: grid;
    place-items: center;
    flex: none;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
