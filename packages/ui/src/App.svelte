<script lang="ts">
  import { onMount } from 'svelte';
  import NotificationCard from './components/NotificationCard.svelte';
  import HarnessUpdateNotices from './components/HarnessUpdateNotices.svelte';
  import ChatView from './components/ChatView.svelte';

  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import DropOverlay from './components/DropOverlay.svelte';
  import FirstRun from './components/FirstRun.svelte';

  import Sidebar from './components/Sidebar.svelte';
  import TitleBar from './components/TitleBar.svelte';
  import { Closing } from './lib/closing.svelte';
  import { runCommand } from './lib/commands.svelte';
  import { confirm } from './lib/confirm.svelte';
  import { startGlass } from './lib/glass';
  import { installExternalLinks } from './lib/links';
  import { isQuitChord, QUIT_HOLD_MS, QuitHold } from './lib/quit-hold';
  import { onNotificationOpen } from './lib/notify';
  import { closeTabs } from './lib/panel-close';
  import { strings } from './lib/strings';
  import { rightPanel } from './lib/right-panel.svelte';
  import { workspace } from './lib/workspace.svelte';
  import { startTheme } from './lib/theme';
  import MobileNavigation from './components/MobileNavigation.svelte';
  import { startViewport } from './lib/viewport';
  import { WsClient } from './lib/client';
  import { listenForInstall } from './lib/pwa';

  let store = $derived(workspace.active);
  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  let sidebar = $state<Sidebar | undefined>(undefined);
  let appRoot = $state<HTMLDivElement | undefined>(undefined);
  let mobileScreen = $state<'chat' | 'threads' | 'activity'>('chat');
  // What the first screen does not draw stays out of the first chunk: the right
  // panel and its six surfaces, the palette and the two dialogs were a third of
  // it. Each loads the moment it is asked for, and all of them once the app is
  // idle, so a key pressed a second after boot finds them and the service
  // worker has them for a phone that loses its link.
  const deferredLoaders = {
    RightPanel: () => import('./components/RightPanel.svelte'),
    CommandPalette: () => import('./components/CommandPalette.svelte'),
    ProjectPicker: () => import('./components/ProjectPicker.svelte'),
    ImportDialog: () => import('./components/ImportDialog.svelte')
  };
  type Deferred = { [K in keyof typeof deferredLoaders]?: Awaited<ReturnType<(typeof deferredLoaders)[K]>>['default'] };
  let deferred = $state.raw<Deferred>({});
  const requested = new Set<keyof Deferred>();
  function need(name: keyof Deferred): void {
    if (requested.has(name)) return;
    requested.add(name);
    void deferredLoaders[name]()
      .then((module) => { deferred = { ...deferred, [name]: module.default }; })
      // Offline with a cold cache: the next ask tries again. A dialog that was
      // asked for is closed and said to be missing, or its open state would
      // hold the keyboard for something that never draws.
      .catch(() => {
        requested.delete(name);
        if (name === 'ProjectPicker' && store.projectPickerOpen) store.projectPickerOpen = false;
        else if (name === 'ImportDialog' && store.imports) store.closeImports();
        else if (name === 'CommandPalette' && store.paletteOpen) store.paletteOpen = false;
        else return;
        store.error = strings.phone.dialogOffline;
      });
  }
  function needAll(): void {
    for (const name of Object.keys(deferredLoaders) as (keyof Deferred)[]) need(name);
  }
  let SettingsShell = $state<typeof import('./components/SettingsShell.svelte').default>();
  let settingsLoadError = $state('');
  $effect(() => {
    if (store.page !== 'settings' || SettingsShell) return;
    settingsLoadError = '';
    void import('./components/SettingsShell.svelte').then(module => { SettingsShell = module.default; })
      .catch(() => { settingsLoadError = strings.phone.settingsOffline; });
  });

  $effect(() => {
    if (panelSlot.shown) need('RightPanel');
  });

  // Asked for before the idle prefetch got to it: fetch it now.
  $effect(() => {
    if (store.paletteOpen) need('CommandPalette');
    if (store.projectPickerOpen) need('ProjectPicker');
    if (store.imports) need('ImportDialog');
  });

  onMount(() => {
    const stopViewport = startViewport();
    const stopInstall = listenForInstall();
    // After the first paint, not in its way. Safari has no requestIdleCallback.
    const idle = typeof requestIdleCallback === 'function'
      ? requestIdleCallback(needAll, { timeout: 1500 })
      : setTimeout(needAll, 300);
    let hidden = document.hidden;
    const resume = () => {
      if (document.hidden) return;
      for (const machine of workspace.machines) {
        const client = machine.store.client;
        if (client instanceof WsClient) void client.resume().catch(() => undefined);
      }
    };
    const visibility = () => {
      if (document.hidden) hidden = true;
      else if (hidden) { hidden = false; resume(); }
    };
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', resume);
    window.addEventListener('pageshow', pageshow);
    const notification = (event: MessageEvent) => {
      if (event.data?.type !== 'boite.open-thread' || typeof event.data.threadId !== 'string') return;
      const machine = workspace.machines.find(m => m.store.endpointUrl && new URL(m.store.endpointUrl).origin === location.origin);
      if (machine) void workspace.select(machine.store, event.data.threadId);
      mobileScreen = 'chat';
    };
    navigator.serviceWorker?.addEventListener('message', notification);
    return () => {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle as number);
      else clearTimeout(idle);
      stopViewport();
      stopInstall();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', resume);
      window.removeEventListener('pageshow', pageshow);
      navigator.serviceWorker?.removeEventListener('message', notification);
    };
  });

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
    const requestedThread = new URLSearchParams(location.search).get('thread');
    void workspace.boot().then(async () => {
      if (requestedThread) {
        const url = new URL(location.href); url.searchParams.delete('thread'); history.replaceState(history.state, '', url);
        const machine = workspace.machines.find(m => m.store.endpointUrl && new URL(m.store.endpointUrl).origin === location.origin);
        if (machine) await workspace.select(machine.store, requestedThread);
      }
    });
    // The stored theme, and the OS one while the setting reads `system`.
    const stopTheme = startTheme();
    // The stored window material, which only the shell wears.
    startGlass();
    // A click on a toast opens the thread it was about.
    const stopToasts = onNotificationOpen((threadId) => void workspace.openNotification(threadId));
    if (!inShell) {
      return () => {
        stopTheme();
        stopToasts();
        workspace.close();
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
          void workspace.addLocalProjects(payload.paths);
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
      workspace.close();
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
  let modal = $derived(confirm.current !== null || store.imports !== null || store.projectPickerOpen);

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
      case 'changes':
      case 'files':
      case 'tasks': {
        // Each of these reads the working directory or the project's todos,
        // which the core refuses to a paired device.
        if (!store.openThread || !store.owner) return;
        event.preventDefault();
        // The panel lives in the chat: from the settings the key brings the chat
        // back with the surface open, rather than toggling what nobody sees.
        if (store.page !== 'chat') {
          store.showChat();
          store.panel.open(command);
        } else store.panel.toggleKind(command);
        break;
      }
      case 'close-surface': {
        // The active surface, never the window: only while the panel is showing.
        const active = store.panel.activeSurfaceId;
        if (!store.panelOpen || !active || typing(event)) return;
        event.preventDefault();
        void closeTabs(store.panel, 'close', active);
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

<div class="app" class:shell={inShell} class:ready={store.booted} class:phone-chat={!inShell && store.page === 'chat' && mobileScreen === 'chat'} class:quitting bind:this={appRoot}>
  {#if !inShell && store.booted}<MobileNavigation {store} bind:screen={mobileScreen} />{/if}
  <TitleBar {store} />

  <div class="body" class:mobile-covered={!inShell && store.page === 'chat' && mobileScreen !== 'chat'} class:panel-maximized={rightPanel.maximized && store.panelOpen}>
    {#if !store.booted}
      <p class="empty boot">{strings.app.loading}</p>
    {:else if store.connection === 'closed' && !store.core}
      <Sidebar bind:this={sidebar} {store} />
      <div class="notice">
        <h1>{strings.app.noEndpointTitle}</h1>
        <p class="muted">{strings.app.noEndpointBody}</p>
        <button type="button" class="primary" onclick={() => store.showSettings()}>
          {strings.app.openSettings}
        </button>
      </div>
      {#if store.page === 'settings'}
        {#if SettingsShell}<SettingsShell {store} />{:else}<p class="empty">{settingsLoadError || strings.app.loading}</p>{/if}
      {/if}
    {:else if store.page === 'settings'}
      {#if SettingsShell}<SettingsShell {store} />{:else}<p class="empty">{settingsLoadError || strings.app.loading}</p>{/if}
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
          {#key store}
            <ChatView {store} />
          {/key}
        {/if}
      </main>
      {#if panelSlot.shown && store.openThread && deferred.RightPanel}
        {@const RightPanel = deferred.RightPanel}
        {#key store}
          <RightPanel
            {store}
            panel={store.panel}
            closing={panelSlot.closing}
            attach={panelSlot.attach}
            onexit={panelSlot.end}
          />
        {/key}
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

  <HarnessUpdateNotices />

  {#if toast.shown}
    <div
      class="toast"
      class:closing={toast.closing}
      role="alert"
      use:toast.attach
      onanimationend={toast.end}
      data-testid="error-toast"
    >
      <NotificationCard title={strings.errors.prefix} message={toastText} dismiss={() => (store.error = null)} />
    </div>
  {/if}
</div>

<ContextMenu />
{#if deferred.ProjectPicker}{@const ProjectPicker = deferred.ProjectPicker}<ProjectPicker {store} />{/if}
<ConfirmDialog />
{#if deferred.ImportDialog}{@const ImportDialog = deferred.ImportDialog}<ImportDialog {store} />{/if}
{#if deferred.CommandPalette}{@const CommandPalette = deferred.CommandPalette}<CommandPalette {store} />{/if}

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
    right: max(16px, env(safe-area-inset-right));
    top: calc(16px + env(safe-area-inset-top, 0px));
    z-index: 80;
    width: min(380px, calc(100vw - 32px));
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .shell .toast { top: calc(var(--titlebar) + 16px); }

  .toast.closing {
    animation: fade-out var(--dur-2) var(--ease-out-quint);
    pointer-events: none;
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
    .app:not(.shell) { display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; grid-template-columns: minmax(0, 1fr); height: var(--app-height, 100dvh); top: var(--app-top, 0px); }
    .app:not(.shell) :global(.titlebar) { display: none; grid-row: 2; grid-column: 1; }
    .app.phone-chat :global(.titlebar) { display: flex; }
    .app:not(.shell) .body { grid-row: 3; grid-column: 1; }
    .body.mobile-covered { visibility: hidden; pointer-events: none; }
    .scrim {
      display: block;
      position: fixed;
      inset: var(--titlebar) 0 0;
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
