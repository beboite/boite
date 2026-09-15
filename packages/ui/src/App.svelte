<script lang="ts">
  import { onMount } from 'svelte';
  import ChatView from './components/ChatView.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import DropOverlay from './components/DropOverlay.svelte';
  import FirstRun from './components/FirstRun.svelte';
  import ImportDialog from './components/ImportDialog.svelte';
  import RightPanel from './components/RightPanel.svelte';
  import SettingsShell from './components/SettingsShell.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import TitleBar from './components/TitleBar.svelte';
  import { Closing } from './lib/closing.svelte';
  import { runCommand } from './lib/commands.svelte';
  import { confirm } from './lib/confirm.svelte';
  import { startGlass } from './lib/glass';
  import { installExternalLinks } from './lib/links';
  import { isQuitChord, QUIT_HOLD_MS, QuitHold } from './lib/quit-hold';
  import { onNotificationOpen } from './lib/notify';
  import { strings } from './lib/strings';
  import { rightPanel } from './lib/right-panel.svelte';
  import { store } from './lib/store.svelte';
  import { startTheme } from './lib/theme';

  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  let sidebar = $state<Sidebar | undefined>(undefined);
  let appRoot = $state<HTMLDivElement | undefined>(undefined);

  // The three overlays of this file leave the way they arrived: one `--dur-2`
  // playing the reverse animation, then out of the DOM on `animationend`.
  const toast = new Closing();
  const scrim = new Closing();
  const panelSlot = new Closing();
  /** The error is cleared the moment Dismiss is pressed, so the exit plays on a copy. */
  let toastText = $state('');

  // Ctrl+Q quits the shell after a hold or a double press, never on one slip:
  // the hint shows for as long as the key is down. Only the shell has a
  // process to quit; a browser tab keeps its own Ctrl+Q.
  const quitHint = new Closing();
  let quitting = $state(false);
  const quitHold = inShell
    ? new QuitHold({
        onHolding: (holding) => {
          if (holding) quitHint.show();
          else quitHint.hide();
        },
        onQuit: () => {
          quitting = true;
          void import('@tauri-apps/api/core').then(({ invoke }) => invoke('quit_shell'));
        }
      })
    : null;

  $effect(() => {
    const error = store.error;
    if (!error) {
      toast.hide();
      return;
    }
    toastText = error;
    toast.show();
  });

  $effect(() => {
    if (store.sidebarOpen) scrim.show();
    else scrim.hide();
  });

  $effect(() => {
    if (store.panelOpen && store.openThread) panelSlot.show();
    else panelSlot.hide();
  });

  // Every http(s) link the UI shows goes to the system browser, once, from here.
  $effect(() => {
    const root = appRoot;
    if (!root) return;
    return installExternalLinks(root);
  });

  // The unread count rides the document title, so the taskbar and a browser
  // tab say "(2) Boite" while the window is somewhere behind.
  $effect(() => {
    const unread = store.unreadCount;
    document.title = unread > 0 ? `(${unread}) ${strings.app.name}` : strings.app.name;
  });

  onMount(() => {
    void store.boot();
    // The stored theme, and the OS one while the setting reads `system`.
    const stopTheme = startTheme();
    // The stored window material, which only the shell wears.
    startGlass();
    // A click on a toast opens the thread it was about.
    const stopToasts = onNotificationOpen((threadId) => void store.open(threadId));
    if (!inShell) {
      return () => {
        stopTheme();
        stopToasts();
      };
    }

    // A folder dragged from the Explorer: the shell reports it, the core
    // refuses anything that is not a directory, the toast repeats why.
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let stopTray: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const stop = await listen('tray://providers', () => store.showSettings('accounts'));
      if (disposed) stop(); else stopTray = stop;
    });
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter') store.dropping = true;
        else if (payload.type === 'leave') store.dropping = false;
        else if (payload.type === 'drop') {
          store.dropping = false;
          void store.addProjects(payload.paths);
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
      stopTray?.();
      stopTheme();
      stopToasts();
      quitHold?.dispose();
    };
  });

  function onkeyup(event: KeyboardEvent) {
    // Whichever half of the chord lifts first ends the hold.
    if (quitHold && (event.key.toLowerCase() === 'q' || event.key === 'Control' || event.key === 'Meta')) {
      quitHold.release();
    }
  }

  function onblur() {
    quitHold?.release();
  }

  /** Whether one of the two modal dialogs is up, waiting on the user. */
  let modal = $derived(confirm.current !== null || store.imports !== null);

  /** A key that belongs to whatever the user is typing in, not to the app. */
  function typing(event: KeyboardEvent): boolean {
    const target = event.target;
    return (
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    );
  }

  /**
   * Every app chord goes through the keyboard table (`lib/keybindings.ts`,
   * the defaults under the user's `keybindings.json`), so a moved key moves
   * here, in the palette hints and in the tooltips at once. The quit hold is
   * the one chord that stays where it is.
   */
  function onkeydown(event: KeyboardEvent) {
    if (quitHold && isQuitChord(event)) {
      event.preventDefault();
      quitHold.press();
      return;
    }
    // A dialog waiting for an answer owns the keyboard: a chord under it moves
    // an app the user cannot see, and the call it is asking about stays
    // pending. Each dialog answers its own keys on the capture phase.
    if (modal) return;
    const command = store.commandForKey(event);
    if (command === null) {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
        if (store.sidebarOpen) store.sidebarOpen = false;
        else if (!typing(event) && store.page === 'chat' && (store.busy || store.openThread?.activity?.goal?.status === 'active' || store.openThread?.activity?.loop?.status === 'active')) {
          event.preventDefault();
          void store.stop();
        }
      }
      return;
    }
    switch (command) {
      case 'palette':
        // The palette: threads across every project and the app's commands.
        event.preventDefault();
        store.paletteOpen = !store.paletteOpen;
        break;
      case 'panel':
        if (!store.openThread) return;
        event.preventDefault();
        store.panel.toggle();
        break;
      case 'browser': {
        if (!store.openThread || !inShell) return;
        event.preventDefault();
        const open = store.panel.surfaces.find((surface) => surface.kind === 'browser');
        if (open) store.panel.activate(open.id);
        else store.panel.open('browser');
        break;
      }
      case 'close-surface': {
        // The active surface, never the window: only while the panel is showing.
        const active = store.panel.activeSurfaceId;
        if (!store.panelOpen || !active || typing(event)) return;
        event.preventDefault();
        store.panel.close(active);
        break;
      }
      case 'stash':
        // The composer stashes what it holds; here the browser's save dialog is
        // kept shut wherever the focus is.
        event.preventDefault();
        break;
      case 'send-and-draft':
        // The composer's own, on the keydown it saw first.
        break;
      default:
        event.preventDefault();
        runCommand(store, command, inShell);
    }
  }

  let firstRun = $derived(store.booted && store.connection !== 'closed' && store.projects.length === 0);
</script>

<svelte:window {onkeydown} {onkeyup} {onblur} />

<div class="app" class:shell={inShell} class:ready={store.booted} class:quitting bind:this={appRoot}>
  {#if inShell}
    <TitleBar {store} />
  {/if}

  <div class="body" class:panel-maximized={rightPanel.maximized && store.panelOpen}>
    {#if !store.booted}
      <p class="empty boot">{strings.app.loading}</p>
    {:else if store.connection === 'closed' && !store.core}
      <div class="notice">
        <h1>{strings.app.noEndpointTitle}</h1>
        <p class="muted">{strings.app.noEndpointBody}</p>
        <button type="button" class="primary" onclick={() => store.showSettings()}>
          {strings.app.openSettings}
        </button>
      </div>
      {#if store.page === 'settings'}
        <SettingsShell {store} />
      {/if}
    {:else if store.page === 'settings'}
      <SettingsShell {store} />
    {:else}
      <Sidebar bind:this={sidebar} {store} />
      {#if scrim.shown}
        <button
          type="button"
          class="scrim"
          class:closing={scrim.closing}
          aria-label={strings.common.close}
          use:scrim.attach
          onanimationend={scrim.end}
          onclick={() => (store.sidebarOpen = false)}
        ></button>
      {/if}
      <main>
        {#if firstRun}
          <FirstRun {store} />
        {:else}
          <ChatView {store} />
        {/if}
      </main>
      {#if panelSlot.shown && store.openThread}
        <RightPanel
          {store}
          panel={store.panel}
          closing={panelSlot.closing}
          attach={panelSlot.attach}
          onexit={panelSlot.end}
        />
      {/if}
    {/if}
  </div>

  {#if store.dropping}
    <DropOverlay />
  {/if}

  {#if quitHint.shown}
    <div
      class="quit-hint"
      class:closing={quitHint.closing}
      role="status"
      style="--quit-hold: {QUIT_HOLD_MS}ms"
      use:quitHint.attach
      onanimationend={quitHint.end}
      data-testid="quit-hint"
    >
      <span class="text">{strings.titlebar.quitHold}</span>
      <span class="sub">{strings.titlebar.quitHoldHint}</span>
      <span class="bar" class:filling={quitHint.open}></span>
    </div>
  {/if}

  {#if toast.shown}
    <div
      class="toast"
      class:closing={toast.closing}
      role="alert"
      use:toast.attach
      onanimationend={toast.end}
      data-testid="error-toast"
    >
      <span class="text" title={toastText}>{strings.errors.prefix}: {toastText}</span>
      <button type="button" class="ghost small" onclick={() => (store.error = null)}>{strings.common.dismiss}</button>
    </div>
  {/if}
</div>

<ContextMenu />
<ConfirmDialog />
<ImportDialog {store} />
<CommandPalette {store} />

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
  }

  /* The whole app arriving is a fade: nothing inside it should look shifted. */
  .app.ready {
    animation: fade var(--dur-3) var(--ease-out-quint);
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
    position: relative;
  }

  main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* Maximized, the panel takes the room and the chat column keeps none. */
  .body.panel-maximized main {
    flex: none;
    width: 0;
    overflow: hidden;
  }

  .boot {
    margin: auto;
  }

  .notice {
    margin: auto;
    padding: 40px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .scrim {
    display: none;
  }

  .toast {
    position: absolute;
    right: 16px;
    bottom: 16px;
    z-index: 80;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: min(420px, calc(100vw - 32px));
    padding: 8px 8px 8px 12px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--color-danger);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-e2);
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .toast.closing {
    animation: fade-out var(--dur-2) var(--ease-out-quint);
    pointer-events: none;
  }

  .toast .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
  }

  /* The quit hint: a card at the top centre with a bar that fills over the
     hold, so the eye reads how long is left before the window goes. */
  .quit-hint {
    position: absolute;
    top: calc(var(--titlebar, 0px) + 12px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 90;
    display: grid;
    grid-template-columns: auto auto;
    align-items: baseline;
    gap: 6px 8px;
    padding: 8px 12px 10px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-e2);
    animation: pop var(--dur-2) var(--ease-out-quint);
    pointer-events: none;
  }

  .quit-hint.closing {
    animation: pop-out var(--dur-2) var(--ease-out-quint);
  }

  .quit-hint .text {
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .quit-hint .sub {
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .quit-hint .bar {
    grid-column: 1 / -1;
    height: 2px;
    border-radius: 1px;
    background: var(--color-foreground);
    transform: scaleX(0);
    transform-origin: left;
  }

  .quit-hint .bar.filling {
    animation: quit-fill var(--quit-hold) linear forwards;
  }

  @keyframes quit-fill {
    to {
      transform: scaleX(1);
    }
  }

  /* The last frame before the process goes: nothing under the pointer answers. */
  .app.quitting {
    pointer-events: none;
    opacity: 0.6;
    transition: opacity var(--dur-2) var(--ease-out-quint);
  }

  @media (max-width: 720px) {
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 20;
      border: none;
      border-radius: 0;
      background: var(--color-scrim);
      height: auto;
      padding: 0;
      animation: fade var(--dur-2) var(--ease-out-quint);
    }

    .scrim.closing {
      animation-name: fade-out;
      pointer-events: none;
    }
  }
</style>
