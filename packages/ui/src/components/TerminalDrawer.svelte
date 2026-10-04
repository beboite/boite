<script lang="ts">
  import { ChevronDown, Columns2, Plus, Rows2, X } from '@lucide/svelte';
  import { onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { MAX_THREAD_TERMINALS, type ThreadId } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { MAX_PANES, activeTab, paneNumber, panesOf, terminalIdOf, type TerminalTab } from '../lib/terminal-layout';
  import type TerminalView from './TerminalView.svelte';

  /**
   * The thread's shells in the frame under the chat, in tabs, each one shell
   * or a split of up to four. Ctrl+J shows and hides the drawer, the shells
   * keep running while hidden, a cross kills one. The top edge drags the
   * drawer's height, kept per device, and the line between two panes their
   * shares. A phone shows each shell as a tab of its own: a split that narrow
   * cannot be read.
   */
  let { store, threadId, cwd, view: View, closing, attach, onexit }: { store: Store; threadId: ThreadId; cwd: string;
    view?: typeof TerminalView; closing: boolean; attach: (node: HTMLElement) => { destroy: () => void };
    onexit: (event: TransitionEvent) => void } = $props();

  const HEIGHT_KEY = 'boite:terminal-height';
  const MIN_HEIGHT = 120;
  const DEFAULT_HEIGHT = 280;
  const narrow = new MediaQuery('(max-width: 720px)');

  let drawer = $state<HTMLElement | undefined>(undefined);
  let height = $state(readHeight());
  let room = $state(window.innerHeight);
  let visibleHeight = $derived(Math.min(height, Math.max(MIN_HEIGHT, Math.round(room * 0.7))));
  let dragging = $state(false);
  let layout = $derived(store.terminalLayout(threadId));
  let tabs = $derived<TerminalTab[]>(layout === null ? [] : narrow.current
    ? panesOf(layout).map((pane) => ({ id: pane, panes: [pane], direction: 'row', sizes: [1] }))
    : layout.tabs);
  let shown = $derived(layout === null ? null : tabs.find((tab) => tab.panes.includes(layout!.active)) ?? tabs[0] ?? null);
  let more = $derived(layout !== null && store.terminalsMultiple() && panesOf(layout).length < MAX_THREAD_TERMINALS);
  let splits = $derived(more && !narrow.current && layout !== null && activeTab(layout).panes.length < MAX_PANES);
  let hideLabel = $derived(store.keyLabel('terminal'));

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

  function titled(label: string, command: Parameters<Store['keyLabel']>[0]): string {
    const key = store.keyLabel(command);
    return key ? `${label} (${key})` : label;
  }

  function tabLabel(tab: TerminalTab): string {
    return fill(strings.terminal.tab, { n: tab.panes.map((pane) => paneNumber(threadId, pane)).join(' | ') });
  }

  function showTab(tab: TerminalTab): void {
    if (layout !== null && !tab.panes.includes(layout.active)) store.focusTerminal(threadId, tab.panes[0]!);
  }

  function closeTab(tab: TerminalTab): void {
    for (const pane of tab.panes) void store.closeTerminal(pane);
  }

  // The keyboard follows the active pane when the one that had it closes, as in T3 Code.
  $effect(() => {
    const active = layout?.active;
    if (active === undefined) return;
    untrack(() => {
      const focus = document.activeElement;
      if (focus === null || focus === document.body || drawer?.contains(focus)) store.focusShell(active);
    });
  });
  onMount(() => {
    const parent = drawer?.parentElement;
    if (!parent) return;
    room = parent.clientHeight;
    const observer = new ResizeObserver(() => { room = parent.clientHeight; });
    observer.observe(parent);
    return () => observer.disconnect();
  });

  /** Follows the pointer from `handle` with `move` until it lets go, then runs `end`. */
  function track(event: PointerEvent, move: (next: PointerEvent) => void, end: () => void) {
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      end();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  function startDrag(event: PointerEvent) {
    if (event.button !== 0) return;
    const startY = event.clientY;
    const startHeight = visibleHeight;
    dragging = true;
    track(event, (next) => {
      height = Math.min(maxHeight(), Math.max(MIN_HEIGHT, startHeight + startY - next.clientY));
    }, () => {
      dragging = false;
      try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* private mode keeps the height for this session */ }
    });
  }

  /** The line after pane `index`: the two panes around it share their room at the pointer. */
  function startSplit(event: PointerEvent, tab: TerminalTab, index: number) {
    if (event.button !== 0) return;
    const line = event.currentTarget as HTMLElement;
    const before = line.previousElementSibling?.getBoundingClientRect();
    const after = line.nextElementSibling?.getBoundingClientRect();
    if (!before || !after) return;
    const row = tab.direction === 'row';
    const from = row ? before.left : before.top;
    const span = (row ? after.right : after.bottom) - from;
    if (span <= 0) return;
    dragging = true;
    track(event, (next) => {
      store.resizeTerminalPanes(threadId, tab.id, index, ((row ? next.clientX : next.clientY) - from) / span);
    }, () => { dragging = false; });
  }
</script>

<section class="drawer" class:closing class:dragging inert={closing} use:attach
  ontransitionend={(event) => { if (event.propertyName === 'height') onexit(event); }}
  style="--terminal-height: {visibleHeight}px" bind:this={drawer} data-testid="terminal-drawer">
  <div class="surface framed">
    <div
      class="handle"
      class:dragging
      role="separator"
      aria-orientation="horizontal"
      aria-label={strings.terminal.resize}
      onpointerdown={startDrag}
    ></div>
    <header>
      {#if tabs.length > 1}
        <div class="tabs" role="tablist" aria-label={strings.terminal.tabs}>
          {#each tabs as tab (tab.id)}
            {@const selected = tab === shown}
            <div class="tab" class:selected data-testid="terminal-tab">
              <button type="button" class="ghost label ui-label" role="tab" aria-selected={selected} title={cwd}
                onclick={() => showTab(tab)}>
                {#if tab.panes.length > 1}
                  {#if tab.direction === 'row'}<Columns2 size={13} strokeWidth={1.75} />{:else}<Rows2 size={13} strokeWidth={1.75} />{/if}
                {/if}
                {tabLabel(tab)}
              </button>
              <button type="button" class="ghost close" title={strings.terminal.closeTab} aria-label={strings.terminal.closeTab}
                data-testid="terminal-tab-close" onclick={() => closeTab(tab)}>
                <X size={12} strokeWidth={1.75} />
              </button>
            </div>
          {/each}
        </div>
      {:else}
        <span class="title ui-label">{strings.terminal.title}</span>
        <span class="cwd ui-label" title={cwd}>{cwd}</span>
      {/if}
      <span class="spacer"></span>
      {#if more}
        <button type="button" class="ghost icon" title={titled(strings.terminal.new, 'terminal-new')}
          aria-label={strings.terminal.new} data-testid="terminal-new" onclick={() => store.newTerminal(threadId)}>
          <Plus size={15} strokeWidth={1.75} />
        </button>
      {/if}
      {#if splits}
        <button type="button" class="ghost icon" title={titled(strings.terminal.splitRight, 'terminal-split')}
          aria-label={strings.terminal.splitRight} data-testid="terminal-split" onclick={() => store.splitTerminal(threadId, 'row')}>
          <Columns2 size={15} strokeWidth={1.75} />
        </button>
        <button type="button" class="ghost icon" title={titled(strings.terminal.splitDown, 'terminal-split-vertical')}
          aria-label={strings.terminal.splitDown} data-testid="terminal-split-down" onclick={() => store.splitTerminal(threadId, 'column')}>
          <Rows2 size={15} strokeWidth={1.75} />
        </button>
      {/if}
      <button
        type="button"
        class="ghost icon"
        title={hideLabel ? `${strings.terminal.hide} (${hideLabel})` : strings.terminal.hide}
        aria-label={strings.terminal.hide}
        data-testid="terminal-hide"
        onclick={() => store.hideTerminal(threadId)}
      >
        <ChevronDown size={15} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        class="ghost icon"
        title={titled(strings.terminal.close, 'terminal-close')}
        aria-label={strings.terminal.close}
        data-testid="terminal-close"
        disabled={layout === null}
        onclick={() => { if (layout !== null) void store.closeTerminal(layout.active); }}
      >
        <X size={15} strokeWidth={1.75} />
      </button>
    </header>
    <div class="body">
      {#if View && layout !== null && shown !== null}
        <div class="panes" class:column={shown.direction === 'column'}>
          {#each shown.panes as pane, index (pane)}
            {#if index > 0}
              <div
                class="split"
                role="separator"
                aria-orientation={shown.direction === 'row' ? 'vertical' : 'horizontal'}
                aria-label={strings.terminal.resizePanes}
                onpointerdown={(event) => startSplit(event, shown!, index - 1)}
              ></div>
            {/if}
            <div
              class="pane"
              class:active={shown.panes.length > 1 && pane === layout.active}
              style="flex: {shown.sizes[index] ?? 1} 1 0"
              onfocusin={() => store.focusTerminal(threadId, pane)}
              data-testid="terminal-pane"
            >
              <View
                {store}
                id={pane}
                start={(cols, rows) => store.openTerminal(threadId, cols, rows, terminalIdOf(threadId, pane))}
                onexit={() => store.terminalExited(threadId, pane)}
                autofocus={pane === layout.active}
              />
            </div>
          {/each}
        </div>
      {:else}
        <p class="loading muted" role="status">{strings.app.loading}</p>
      {/if}
    </div>
  </div>
</section>

<style>
  .drawer {
    flex: none;
    min-height: 0;
    --terminal-gap: 0px;
    height: calc(var(--terminal-height) + var(--terminal-gap));
    overflow: clip;
    transition: height var(--dur-3) var(--ease-out-quint);
  }

  @starting-style {
    .drawer { height: 0; }
  }

  .drawer.closing { height: 0; transition-duration: var(--dur-2); }
  .drawer.dragging { transition: none; }

  /* One flat screen, header included, as a console window: no card inside the frame. */
  .surface {
    position: relative;
    display: flex;
    flex-direction: column;
    height: var(--terminal-height);
    margin-top: var(--terminal-gap);
    border-top: 1px solid var(--color-border);
    background: var(--color-terminal-background);
  }

  @media (min-width: 721px) {
    .drawer { --terminal-gap: var(--frame-gap); }
    .surface { border-color: var(--color-frame-edge); }
  }

  .loading { margin: 12px; font-size: var(--text-sm); }

  /* The top edge, a hairline on hover and while dragged, like the panel's. */
  .handle {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 8px;
    cursor: row-resize;
    z-index: 1;
    touch-action: none;
  }

  .handle::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 3px;
    height: 1px;
    background: transparent;
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .handle:hover::after { background: var(--color-border); }
  .handle.dragging::after { background: color-mix(in srgb, var(--color-foreground) 60%, transparent); }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    flex: none;
    min-width: 0;
    padding: 0 6px 0 12px;
  }

  .title {
    flex: none;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-foreground);
  }

  .cwd {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    margin-left: -6px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab {
    display: flex;
    align-items: center;
    flex: none;
    border-radius: var(--radius-sm);
    color: var(--color-muted-foreground);
  }

  .tab.selected { background: var(--color-active); color: var(--color-foreground); }
  .tab:not(.selected):hover { background: var(--color-hover); }

  .tab .label {
    display: flex;
    align-items: center;
    gap: 5px;
    height: var(--control-sm);
    padding: 0 4px 0 8px;
    font-size: var(--text-sm);
    color: inherit;
    background: none;
    white-space: nowrap;
  }

  .tab .close {
    width: 20px;
    height: 20px;
    margin-right: 2px;
    padding: 0;
    display: grid;
    place-items: center;
    color: inherit;
    background: none;
  }

  .tab .close:hover { color: var(--color-foreground); }

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
  }

  .panes {
    display: flex;
    height: 100%;
    min-height: 0;
  }

  .panes.column { flex-direction: column; }

  .pane {
    position: relative;
    min-width: 0;
    min-height: 0;
  }

  /* The pane with the keyboard, in a split: a hairline inside its edge. */
  .pane.active::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent);
  }

  .split {
    flex: none;
    width: 1px;
    position: relative;
    background: var(--color-border);
    cursor: col-resize;
    touch-action: none;
  }

  .panes.column > .split { width: auto; height: 1px; cursor: row-resize; }

  /* A wider grip than the hairline it draws. */
  .split::before {
    content: '';
    position: absolute;
    inset: 0 -4px;
    z-index: 1;
  }

  .panes.column > .split::before { inset: -4px 0; }
  .split:hover, .drawer.dragging .split { background: var(--color-edge); }
</style>
