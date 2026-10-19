<script lang="ts">
  import { ChevronDown, Columns2, History, Plus, Rows2, Search, X } from '@lucide/svelte';
  import { onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { MAX_THREAD_TERMINALS, type ThreadId } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { MAX_PANES, MIN_SHARE, activeTab, paneNumber, panesOf, terminalIdOf, type TerminalTab } from '../lib/terminal-layout';
  import { baseName } from '../lib/terminal-marks';
  import type TerminalView from './TerminalView.svelte';
  import DrawerTabs from './DrawerTabs.svelte';
  import ResizeHandle from './ResizeHandle.svelte';

  /**
   * The thread's shells in the frame under the chat, in tabs, each one shell
   * or a split of up to four. Ctrl+J shows and hides the drawer, the shells
   * keep running while hidden, a cross kills one. With the project board on,
   * the drawer's first tabs switch between the board and the shells. The top edge drags the
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
  /** Some handle of the drawer is being dragged. Each handle keeps its own state; this only stills the drawer's height transition. */
  let dragging = $state(false);
  let layout = $derived(store.terminalLayout(threadId));
  let tabs = $derived<TerminalTab[]>(layout === null ? [] : narrow.current
    ? panesOf(layout).map((pane) => ({ id: pane, panes: [pane], direction: 'row', sizes: [1] }))
    : layout.tabs);
  let shown = $derived(layout === null ? null : tabs.find((tab) => tab.panes.includes(layout!.active)) ?? tabs[0] ?? null);
  let more = $derived(layout !== null && store.terminalsMultiple() && panesOf(layout).length < MAX_THREAD_TERMINALS);
  let splits = $derived(more && !narrow.current && layout !== null && activeTab(layout).panes.length < MAX_PANES);
  let hideLabel = $derived(store.keyLabel('terminal'));
  /** The screen with the keyboard: its shell, its live directory and whether a command runs. */
  let screen = $derived(layout === null ? null : store.terminalScreen(layout.active));
  let liveCwd = $derived(screen?.cwd ?? cwd);

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

  /** A tab is named after the directory its shells are in, as Windows Terminal titles it, else by number. */
  function tabLabel(tab: TerminalTab): string {
    return tab.panes.map((pane) => {
      const where = store.terminalScreen(pane)?.cwd;
      return where ? baseName(where) : fill(strings.terminal.tab, { n: String(paneNumber(threadId, pane)) });
    }).join(' | ');
  }

  function tabTitle(tab: TerminalTab): string {
    return tab.panes.map((pane) => store.terminalScreen(pane)?.cwd ?? cwd).join('\n');
  }

  /** `running`, `failed` or nothing: the dot after a tab's or the drawer's name. */
  function statusOf(panes: string[]): 'running' | 'failed' | null {
    const screens = panes.map((pane) => store.terminalScreen(pane));
    if (screens.some((entry) => entry?.running)) return 'running';
    if (screens.some((entry) => entry?.lastExit !== null && entry?.lastExit !== undefined && entry.lastExit !== 0 && !entry.running)) return 'failed';
    return null;
  }

  function statusTitle(panes: string[]): string {
    const status = statusOf(panes);
    if (status === 'running') return strings.terminal.running;
    const failed = panes.map((pane) => store.terminalScreen(pane)).find((entry) => entry?.lastExit);
    return status === 'failed' ? fill(strings.terminal.failed, { code: String(failed?.lastExit ?? '') }) : '';
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

  let dragFrom = 0;

  function setHeight(next: number): void {
    height = Math.min(maxHeight(), Math.max(MIN_HEIGHT, Math.round(next)));
  }

  function saveHeight(): void {
    try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* private mode keeps the height for this session */ }
  }

  /** The two panes around the line `handle` sits on: where they start and how much room they share. */
  function pair(handle: HTMLElement, tab: TerminalTab): { from: number; span: number } | null {
    const line = handle.parentElement;
    const before = line?.previousElementSibling?.getBoundingClientRect();
    const after = line?.nextElementSibling?.getBoundingClientRect();
    if (!before || !after) return null;
    const row = tab.direction === 'row';
    const from = row ? before.left : before.top;
    const span = (row ? after.right : after.bottom) - from;
    return span > 0 ? { from, span } : null;
  }

  let splitFrom = 0;
  let splitSpan = 0;

  /** The share of the two panes around line `index` that goes to the first, in percent. */
  function sharePercent(tab: TerminalTab, index: number): number {
    const first = tab.sizes[index] ?? 1;
    const second = tab.sizes[index + 1] ?? 1;
    return (first / (first + second)) * 100;
  }
</script>

<section class="drawer" class:closing class:dragging inert={closing} use:attach
  ontransitionend={(event) => { if (event.propertyName === 'height') onexit(event); }}
  style="--terminal-height: {visibleHeight}px" bind:this={drawer} data-testid="terminal-drawer">
  <!-- Outside the frame, which clips: the handle lies in the gap above it. -->
  <div class="edge">
    <ResizeHandle
      orientation="horizontal"
      edge="top"
      label={strings.terminal.resize}
      testid="terminal-resize"
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
      {#if store.boardAvailable()}
        <!-- The project board shares the drawer: its tab first, the shells' after. -->
        <DrawerTabs {store} current="terminal" />
        <span class="divider" aria-hidden="true"></span>
      {/if}
      {#if tabs.length > 1}
        <div class="tabs" role="tablist" aria-label={strings.terminal.tabs}>
          {#each tabs as tab (tab.id)}
            {@const selected = tab === shown}
            <div class="tab" class:selected data-testid="terminal-tab">
              <button type="button" class="ghost label ui-label" role="tab" aria-selected={selected} title={tabTitle(tab)}
                onclick={() => showTab(tab)}>
                {#if tab.panes.length > 1}
                  {#if tab.direction === 'row'}<Columns2 size={13} strokeWidth={1.75} />{:else}<Rows2 size={13} strokeWidth={1.75} />{/if}
                {/if}
                {tabLabel(tab)}
                {#if statusOf(tab.panes)}<span class="status {statusOf(tab.panes)}" title={statusTitle(tab.panes)} data-testid="terminal-status"></span>{/if}
              </button>
              <button type="button" class="ghost close" title={strings.terminal.closeTab} aria-label={strings.terminal.closeTab}
                data-testid="terminal-tab-close" onclick={() => closeTab(tab)}>
                <X size={12} strokeWidth={1.75} />
              </button>
            </div>
          {/each}
        </div>
      {:else}
        {@const status = layout === null ? null : statusOf([layout.active])}
        <span class="title ui-label">{screen?.shell?.name ?? strings.terminal.title}</span>
        <span class="cwd ui-label" title={liveCwd} data-testid="terminal-cwd">{liveCwd}</span>
        {#if status}<span class="status {status}" title={statusTitle([layout!.active])} data-testid="terminal-status"></span>{/if}
      {/if}
      <span class="spacer"></span>
      <button type="button" class="ghost icon" title={titled(strings.terminal.find, 'terminal-find')}
        aria-label={strings.terminal.find} data-testid="terminal-find-open" disabled={screen === null}
        onclick={() => screen?.openSearch()}>
        <Search size={14} strokeWidth={1.75} />
      </button>
      <button type="button" class="ghost icon" title={titled(strings.terminal.history, 'terminal-history')}
        aria-label={strings.terminal.history} data-testid="terminal-history-open" disabled={screen === null}
        onclick={() => screen?.openHistory()}>
        <History size={15} strokeWidth={1.75} />
      </button>
      <span class="divider" aria-hidden="true"></span>
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
              {@const tab = shown}
              <div class="split">
                <ResizeHandle
                  orientation={tab.direction === 'row' ? 'vertical' : 'horizontal'}
                  edge="center"
                  label={strings.terminal.resizePanes}
                  testid="terminal-split-resize"
                  value={sharePercent(tab, index - 1)}
                  min={MIN_SHARE * 100}
                  max={(1 - MIN_SHARE) * 100}
                  onstart={(handle) => {
                    const room = pair(handle, tab);
                    if (room === null) return false;
                    splitFrom = room.from;
                    splitSpan = room.span;
                    dragging = true;
                  }}
                  onend={() => { dragging = false; }}
                  onmove={(_, at) => store.resizeTerminalPanes(threadId, tab.id, index - 1, (at - splitFrom) / splitSpan)}
                  onstep={(delta, handle) => {
                    const room = pair(handle, tab);
                    if (room !== null) store.resizeTerminalPanes(threadId, tab.id, index - 1, sharePercent(tab, index - 1) / 100 + delta / room.span);
                  }}
                  onreset={() => store.resizeTerminalPanes(threadId, tab.id, index - 1, 0.5)}
                />
              </div>
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
    position: relative;
    flex: none;
    min-height: 0;
    --terminal-gap: 0px;
    height: calc(var(--terminal-height) + var(--terminal-gap));
    overflow: clip;
    transition: height var(--dur-slide) var(--ease-slide);
  }

  @starting-style {
    .drawer { height: 0; }
  }

  .drawer.closing { height: 0; transition: height var(--dur-slide-out) var(--ease-slide); }
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

  /* The frame's top edge, for the handle centred in the gap above it. On a
     phone there is no gap: the handle stays under the edge, inside the
     drawer's clip. */
  .edge {
    position: absolute;
    top: var(--terminal-gap);
    left: 0;
    right: 0;
    --resize-gap: var(--terminal-gap);
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

  .divider {
    flex: none;
    width: 1px;
    height: 14px;
    margin: 0 2px;
    background: var(--color-border);
  }

  /* After a name: the accent breathing while a command runs, red once one failed. */
  .status {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .status.running {
    background: var(--color-accent);
    animation: status-running 1.2s var(--loop-ease-out-quint-36) infinite var(--loops);
  }

  .status.failed { background: var(--ansi-red); }

  @keyframes status-running {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  @media (prefers-reduced-motion: reduce) { .status.running { animation: none; } }
  :global(html[data-motion='reduced']) .status.running { animation: none; }

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

  /* The line between two panes; its handle (ResizeHandle) lies over it. */
  .split {
    flex: none;
    width: 1px;
    position: relative;
    background: var(--color-border);
  }

  .panes.column > .split { width: auto; height: 1px; }
</style>
