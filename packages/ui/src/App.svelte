<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { watchAgentBrowser } from './lib/agent-browser-watch';
  import { watchDevices } from './lib/device-watch';
  import { lendLocalBrowser } from './lib/desktop-browser-host.svelte';
  import { browserProfiles } from './lib/browser-profiles.svelte';
  import TerminalDrawer from './components/TerminalDrawer.svelte';
  import UndoToast from './components/UndoToast.svelte';
  import NotificationCard from './components/NotificationCard.svelte';
  import ChatView from './components/ChatView.svelte';

  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import DragGhost from './components/DragGhost.svelte';
  import DropOverlay from './components/DropOverlay.svelte';

  import Sidebar from './components/Sidebar.svelte';
  import TitleBar from './components/TitleBar.svelte';
  import { Closing } from './lib/closing.svelte';
  import { focusComposer } from './lib/focus';
  import { runCommand } from './lib/commands.svelte';
  import { confirm } from './lib/confirm.svelte';
  import { startGlass } from './lib/glass';
  import { installExternalLinks } from './lib/links';
  import { installDropNavigationGuard } from './lib/drop-navigation';
  import { isQuitChord, QUIT_HOLD_MS, QuitHold } from './lib/quit-hold';
  import { notificationWords, onNotificationOpen, storeNotificationWords } from './lib/notify';
  import { closeTabs } from './lib/panel-close';
  import { strings } from './lib/strings';
  import { experimentOn } from './lib/experiments.svelte';
  import { installWhipEscape } from './lib/whip.svelte';
  import { rightPanel } from './lib/right-panel.svelte';
  import { workspace } from './lib/workspace.svelte';
  import type { Store } from './lib/store.svelte';
  import { tourRequested, tourSeen } from './lib/onboarding.svelte';
  import { prefetchAllowed, prefetchNames, whenIdle } from './lib/prefetch';
  import { startTheme } from './lib/theme';
  import { setZoom, stepZoom, wantedZoom, ZOOM_DEFAULT, zoomKey } from './lib/zoom';
  import { appName, appUpdater } from './lib/app-update.svelte';
  import MobileNavigation from './components/MobileNavigation.svelte';
  import MobileConnect from './components/MobileConnect.svelte';
  import { attentionCount, syncAppBadge } from './lib/badge';
  import { startViewport } from './lib/viewport';
  import { WsClient } from './lib/client';
  import { listenForInstall } from './lib/pwa';
  import { mobileOverlay } from './lib/mobile-history';
  import { startViewHistory } from './lib/view-history.svelte';
  import { agentAutoLink } from './lib/agent-links.svelte';
  import ThreadPreparation from './components/ThreadPreparation.svelte';

  let store = $derived(workspace.active);
  // The machine the window opened on may still give way to one that answers: until then nothing of it is drawn.
  const booted = $derived(store.booted && !(workspace.waiting && store === workspace.primary));
  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  // A page the agent opens brings its browser forward in the panel, on every client (lib/agent-browser-watch.ts).
  $effect(() => {
    const threadId = store.openThread?.id;
    void store.connection;
    if (threadId && store.client?.state === 'ready') return watchAgentBrowser(store, threadId);
  });
  // A simulator or emulator the agent opens shows up in the panel, here and on a phone (docs/devices.md).
  $effect(() => {
    const threadId = store.openThread?.id;
    void store.connection;
    if (threadId && store.client?.state === 'ready') return watchDevices(store, threadId);
  });
  $effect(() => lendLocalBrowser(workspace.machines)); // the panel's browser tabs, which this computer's agents drive
  const narrow = new MediaQuery('(max-width: 720px)');
  let appRoot = $state<HTMLDivElement | undefined>(undefined);
  let mobileScreen = $state<'chat' | 'threads' | 'activity'>('chat');
  const mobileRecovery = $derived(!inShell && (store.pairingRequired || (!store.core && store.connection !== 'ready'))
    && !workspace.machines.some(machine => machine.store.connection === 'ready'));
  // Wider than a phone (an iPhone on its side, a tablet, a desktop browser)
  // a lost or revoked pairing gets the same screen rather than a stale page.
  const wideRecovery = $derived(!narrow.current && mobileRecovery && store.pairingRequired && store.page !== 'settings');
  let documentVisible = $state(!document.hidden);
  // What the first screen does not draw stays out of the first chunk: the right
  // panel and its six surfaces, the palette and the two dialogs were a third of
  // it. Each loads the moment it is asked for, and the rest once the app has
  // booted and is idle, so a key pressed a second later finds them and the service
  // worker has them for a phone that loses its link. The tour is the same case
  // taken further: a device draws it once, then only when asked.
  const deferredLoaders = {
    RightPanel: () => import('./components/RightPanel.svelte'),
    CommandPalette: () => import('./components/CommandPalette.svelte'),
    ProjectPicker: () => import('./components/ProjectPicker.svelte'),
    ImportDialog: () => import('./components/ImportDialog.svelte'),
    ConnectFlow: () => import('./components/ConnectFlow.svelte'),
    Onboarding: () => import('./components/Onboarding.svelte'),
    // xterm.js and its stylesheet: only once a terminal is asked for.
    TerminalView: () => import('./components/TerminalView.svelte')
  };
  type Deferred = { [K in keyof typeof deferredLoaders]?: Awaited<ReturnType<(typeof deferredLoaders)[K]>>['default'] };
  let deferred = $state.raw<Deferred>({});
  const requested = new Set<keyof Deferred>();
  let terminalShown = $derived(store.openThread !== null && store.owner && store.terminalShown(store.openThread.id));
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
        else if (name === 'ConnectFlow' && store.connectDialog) store.closeConnect();
        else if (name === 'CommandPalette' && store.paletteOpen) store.paletteOpen = false;
        else return;
        store.error = strings.phone.dialogOffline;
      });
  }
  function needAll(): void {
    const names = Object.keys(deferredLoaders) as (keyof Deferred)[];
    for (const name of prefetchNames(names, { tourSeen: tourSeen(), owner: store.owner })) need(name);
  }
  // Once the first load has landed rather than against it, and only on a link
  // that can spare the bytes (lib/prefetch.ts).
  $effect(() => {
    if (!store.booted || !prefetchAllowed()) return;
    return whenIdle(needAll);
  });
  let WhipOverlay = $state<typeof import('./components/WhipOverlay.svelte').default>();
  $effect(() => {
    if (!store.booted || !experimentOn('whip') || WhipOverlay) return;
    void import('./components/WhipOverlay.svelte').then(module => { WhipOverlay = module.default; })
      .catch(error => { store.error = String(error); });
  });
  // Browser profiles live on this computer, whichever machine is in view: they
  // are kept by the core this shell started (lib/browser-profiles.svelte.ts).
  $effect(() => {
    browserProfiles.source = workspace.machines.find((machine) => machine.store.localCore)?.store ?? store;
  });
  let SettingsShell = $state<typeof import('./components/SettingsShell.svelte').default>();
  let AgentsPage = $state<typeof import('./components/agents/AgentsPage.svelte').default>();
  let agentsLoadError = $state('');
  $effect(() => {
    if (store.page !== 'agents' || !experimentOn('resident-agents') || AgentsPage) return;
    void import('./components/agents/AgentsPage.svelte').then(module => { AgentsPage = module.default; })
      .catch(() => { agentsLoadError = strings.agents.offline; });
  });
  // Switched off with the page open: every machine goes back to its chat, so
  // switching it on again does not reopen a page nobody navigated to.
  $effect(() => {
    if (experimentOn('resident-agents')) return;
    for (const machine of workspace.machines) if (machine.store.page === 'agents') machine.store.showChat();
  });
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

  $effect(() => {
    if (terminalShown) need('TerminalView');
  });

  // A drawer left open before a reload or a reconnect opens again, with its tabs and splits.
  $effect(() => {
    const open = store.openThread;
    if (open !== null && store.owner && store.connection === 'ready') untrack(() => store.restoreTerminal(open.id));
  });

  // Asked for before the idle prefetch got to it: fetch it now.
  $effect(() => {
    if (store.paletteOpen) need('CommandPalette');
    if (store.projectPickerOpen) need('ProjectPicker');
    if (store.imports) need('ImportDialog');
    if (store.connectDialog) need('ConnectFlow');
    if (tour) need('Onboarding');
  });

  onMount(installWhipEscape);

  onMount(() => {
    const stopViewport = startViewport();
    const stopInstall = listenForInstall();
    const stopAutoLink = agentAutoLink.start();
    let stopAppUpdater: () => void = () => undefined;
    let updateDelay: number | undefined;
    const updateFrame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => { updateDelay = window.setTimeout(() => { stopAppUpdater = appUpdater.start(); }, 0); })
      : undefined;
    if (updateFrame === undefined) updateDelay = window.setTimeout(() => { stopAppUpdater = appUpdater.start(); }, 0);
    let hidden = document.hidden;
    const resume = () => {
      if (document.hidden) return;
      for (const machine of workspace.machines) {
        const client = machine.store.client;
        if (client instanceof WsClient) void client.resume().catch(() => undefined);
      }
    };
    const visibility = () => {
      documentVisible = !document.hidden;
      if (document.hidden) hidden = true;
      else if (hidden) { hidden = false; resume(); }
    };
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
    const offline = () => { for (const machine of workspace.machines) if (machine.store.client instanceof WsClient) machine.store.client.offline(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    window.addEventListener('pageshow', pageshow);
    const notification = (event: MessageEvent) => {
      if (event.data?.type !== 'boite.open-thread' || typeof event.data.threadId !== 'string') return;
      const machine = workspace.machines.find(m => m.store.endpointUrl && new URL(m.store.endpointUrl).origin === location.origin);
      if (machine) void workspace.select(machine.store, event.data.threadId);
      mobileScreen = 'chat';
    };
    navigator.serviceWorker?.addEventListener('message', notification);
    return () => {
      stopViewport();
      stopAutoLink();
      stopInstall();
      if (updateFrame !== undefined) cancelAnimationFrame(updateFrame);
      if (updateDelay !== undefined) clearTimeout(updateDelay);
      stopAppUpdater();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', offline);
      window.removeEventListener('pageshow', pageshow);
      navigator.serviceWorker?.removeEventListener('message', notification);
    };
  });

  // The three overlays of this file leave the way they arrived: one `--dur-2`
  // playing the reverse animation, then out of the DOM on `animationend`.
  const toast = new Closing();
  const scrim = new Closing();
  const panelSlot = new Closing();
  const terminalSlot = new Closing();
  /** The error is cleared the moment Dismiss is pressed, so the exit plays on a copy. */
  let toastText = $state('');
  let toastThreadId = $state<string | null>(null);
  let toastStore = $state<Store | null>(null);

  function dismissError(): void {
    if (toastStore) toastStore.error = null;
  }

  function openErrorThread(): void {
    const owner = toastStore;
    const threadId = toastThreadId;
    if (!owner || !threadId) return;
    owner.error = null;
    void workspace.select(owner, threadId);
    mobileScreen = 'chat';
  }

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
    const owner = store;
    const error = owner.error;
    // Missing/revoked phone credentials have a persistent recovery screen.
    // Keep other errors (including a failed pairing attempt) visible.
    const pairingNotice = !inShell && (narrow.current || wideRecovery) && store.pairingRequired
      && (error === strings.errors.unpaired || error === strings.errors.revoked);
    // A machine that may still give way to one that answers has nothing to report yet.
    const held = workspace.waiting && owner === workspace.primary;
    if (!error || pairingNotice || held) {
      toast.hide();
      return;
    }
    toastText = error;
    toastThreadId = store.errorThreadId;
    toastStore = store;
    toast.show();
  });

  $effect(() => {
    const owner = store;
    const error = owner.error;
    if (!error || owner.errorSeverity !== 'minor' || owner.errorThreadId) return;
    const timer = setTimeout(() => {
      if (owner.error === error && owner.errorSeverity === 'minor') owner.error = null;
    }, 5_000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (store.sidebarOpen) scrim.show();
    else scrim.hide();
  });

  $effect(() => {
    if (store.panelOpen && store.openThread) panelSlot.show();
    else panelSlot.hide();
  });
  $effect(() => {
    if (terminalShown) terminalSlot.show();
    else {
      // The drawer goes inert as it leaves, which drops the focus on `<body>`:
      // the keyboard goes back to the composer first.
      if (document.activeElement?.closest('[data-testid=terminal-drawer]')) focusComposer();
      terminalSlot.hide();
    }
  });

  // On a phone the panel covers the chat: Back shuts it.
  $effect(() => {
    if (panelSlot.open) return mobileOverlay(() => store.panel.hide());
  });

  // The tray menu is native: it speaks the UI's language only when told, at
  // start and whenever the language changes.
  $effect(() => {
    if (!inShell) return;
    const labels = { show: strings.quotas.trayShow, quit: strings.quotas.trayQuit };
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('tray_labels', labels))
      .catch(() => {
        // An older shell without the command keeps its English menu.
      });
  });

  // The same for a push: the service worker shows the core's generic notices
  // in the words this page left it, written again when the language changes.
  $effect(() => {
    if (inShell) return;
    void storeNotificationWords(notificationWords());
  });

  // Every http(s) link the UI shows goes to the system browser, once, from here.
  $effect(() => {
    const root = appRoot;
    if (!root) return;
    const stopLinks = installExternalLinks(root);
    const stopDrops = installDropNavigationGuard(root);
    return () => { stopLinks(); stopDrops(); };
  });

  // What wants the user rides the document title, so the taskbar and a browser
  // tab say "(2) Boite" while the window is somewhere behind: the threads of
  // every connected machine that wait on an answer or finished unread. The
  // installed app's icon badge carries the same count.
  $effect(() => {
    const stores = workspace.machines.length ? workspace.machines.map((machine) => machine.store) : [store];
    const count = attentionCount(stores);
    const name = appName();
    document.title = count > 0 ? `(${count}) ${name}` : name;
    if (!inShell) syncAppBadge(count);
  });

  onMount(() => {
    // A notification tapped with no window open: taken off the address at
    // once, so a reload during the boot does not jump there again.
    const requestedThread = new URLSearchParams(location.search).get('thread');
    if (requestedThread) { const url = new URL(location.href); url.searchParams.delete('thread'); history.replaceState(history.state, '', url); }
    const stopSettingsSync = workspace.settingsSync.start();
    const stopGroupLinks = workspace.groups.start();
    void workspace.boot(requestedThread || null);
    // The stored theme, and the OS one while the setting reads `system`.
    const stopTheme = startTheme();
    // The stored window material, which only the shell wears.
    startGlass();
    // A click on a toast opens the thread it was about.
    const stopToasts = onNotificationOpen((threadId) => void workspace.openNotification(threadId));
    // A mouse's back and forward buttons walk the threads, drafts and settings tabs shown.
    const stopViewHistory = startViewHistory();
    if (!inShell) {
      return () => {
        stopViewHistory();
        stopTheme();
        stopToasts();
        stopSettingsSync();
        stopGroupLinks();
        workspace.close();
      };
    }

    // A folder dragged from the Explorer: the shell reports it, the core
    // refuses anything that is not a directory, the toast repeats why.
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let stopTray: (() => void) | undefined;
    const traySettings = async (tab: 'accounts' | 'limits') => {
      const local = workspace.machines.find((machine) => machine.store.localCore)?.store;
      if (!local) return;
      await workspace.select(local);
      if (workspace.active === local) local.showSettings(tab);
    };
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const stops = await Promise.all([
        listen('tray://providers', () => void traySettings('accounts')),
        listen('tray://limits', () => void traySettings('limits')),
      ]);
      const stop = () => stops.forEach((off) => off());
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
      stopViewHistory();
      stopTheme();
      stopToasts();
      quitHold?.dispose();
      stopSettingsSync();
      stopGroupLinks();
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

  /*
   * The tour opens by itself the first time Boite runs on this device, and on
   * request afterwards. It waits for a core: its screens carry real switches,
   * and half of them would be dead against a connection that is not there.
   */
  /**
   * A folded column standing in the body, the one case where the chat card or
   * the Agents card keeps a left gap: both lists fold together (RailFrame). A class rather than `.body:has(> .sidebar.collapsed)`:
   * that selector made every node a streaming answer or a scroll mounted
   * anywhere below restyle the body, right before the list read its layout.
   */
  let sidebarFolded = $derived(store.sidebarCollapsed && store.booted && ((store.connection === 'closed' && !store.core) || store.page !== 'settings'));
  let tour = $derived(store.booted && store.connection === 'ready' && (tourRequested() || !tourSeen()));

  /**
   * Whether something modal is up, waiting on the user: no app chord fires under
   * it. The tour counts once it is drawn: offline with a cold cache it never is,
   * and the keyboard must not stay held for it.
   */
  let modal = $derived((tour && deferred.Onboarding !== undefined) || confirm.current !== null || store.imports !== null || store.projectPickerOpen || (store.connectDialog !== null && deferred.ConnectFlow !== undefined));

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
    // Ctrl+=, Ctrl+- and Ctrl+0 zoom the whole interface in the shell, except
    // inside a browser surface's own chrome, whose page walks its own ladder.
    // A browser tab keeps its native zoom.
    const zoom = inShell ? zoomKey(event) : null;
    if (zoom !== null && !(event.target instanceof Element && event.target.closest('[data-testid=browser-surface]'))) {
      event.preventDefault();
      void setZoom(zoom === 0 ? ZOOM_DEFAULT : stepZoom(wantedZoom(), zoom)).catch((error: unknown) => {
        store.error = error instanceof Error ? error.message : String(error);
      });
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
        store.togglePanel();
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
        // A paired device reads the working tree, not the project's todos.
        if (!store.openThread || (command === 'tasks' && !store.owner)) return;
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

</script>

<svelte:window {onkeydown} {onkeyup} {onblur} />

{#each workspace.machines as machine (machine.id)}
  <ThreadPreparation store={machine.store} visible={machine.store === store && documentVisible && (inShell || mobileScreen === 'chat')} />
{/each}
{#if !workspace.machines.some(machine => machine.store === store)}
  <ThreadPreparation {store} visible={documentVisible && (inShell || mobileScreen === 'chat')} />
{/if}

<div class="app" class:shell={inShell} class:ready={booted} class:phone-chat={!inShell && !mobileRecovery && store.page === 'chat' && mobileScreen === 'chat'} class:off-chat={!inShell && store.page !== 'chat'} class:quitting style:--typing-state={documentVisible ? 'running' : 'paused'} bind:this={appRoot}>
  {#if !inShell && booted}<MobileNavigation {store} recover={mobileRecovery} bind:screen={mobileScreen} />{/if}
  <TitleBar {store} />

  <div class="body" class:mobile-covered={!inShell && store.page === 'chat' && (mobileScreen !== 'chat' || mobileRecovery)} class:panel-maximized={rightPanel.maximized && !rightPanel.floating && store.panelOpen} class:sidebar-folded={sidebarFolded}>
    {#if !booted}
      <p class="empty boot">{strings.app.loading}</p>
    {:else if wideRecovery}
      <div class="wide-recovery" data-testid="wide-recovery"><MobileConnect {store} onpaired={() => {}} /></div>
    {:else if store.connection === 'closed' && !store.core}
      <Sidebar {store} />
      <!-- The notice gives way to Settings: the two cards side by side left
           Settings too narrow for its nav and its page. -->
      {#if store.page === 'settings'}
        {#if SettingsShell}<SettingsShell {store} onopenthread={() => { mobileScreen = 'chat'; }} />{:else}<p class="empty">{settingsLoadError || strings.app.loading}</p>{/if}
      {:else}
        <div class="notice framed">
          <h1>{strings.app.noEndpointTitle}</h1>
          <p class="muted">{strings.app.noEndpointBody}</p>
          <button type="button" class="primary" onclick={() => store.showSettings()}>
            {strings.app.openSettings}
          </button>
        </div>
      {/if}
    {:else if store.page === 'agents' && experimentOn('resident-agents')}
      {#if AgentsPage}{#key store}<AgentsPage {store} />{/key}{:else}<p class="empty">{agentsLoadError || strings.app.loading}</p>{/if}
    {:else if store.page === 'settings'}
      {#if SettingsShell}<SettingsShell {store} onopenthread={() => { mobileScreen = 'chat'; }} />{:else}<p class="empty">{settingsLoadError || strings.app.loading}</p>{/if}
    {:else}
      <Sidebar {store} />
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
        <div class="thread-chat framed">
          {#key store}
            <ChatView {store} />
          {/key}
        </div>
        {#if terminalSlot.shown && store.openThread}
          {#key store}
            {#key store.openThread.id}
              <TerminalDrawer {store} threadId={store.openThread.id} cwd={store.openThread.cwd}
                view={deferred.TerminalView}
                closing={terminalSlot.closing} attach={terminalSlot.attach} onexit={terminalSlot.end} />
            {/key}
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


  {#if toast.shown}
    <div
      class="toast"
      class:closing={toast.closing}
      role="alert"
      use:toast.attach
      onanimationend={toast.end}
      data-testid="error-toast"
    >
      <NotificationCard
        title={toastThreadId ? strings.notify.failed : strings.errors.prefix}
        message={toastText}
        dismiss={dismissError}
        action={toastThreadId ? { label: strings.notify.openThread, run: openErrorThread } : undefined}
      />
    </div>
  {/if}
  <UndoToast onerror={(error) => (store.error = error instanceof Error ? error.message : String(error))} />
  {#if store.booted && experimentOn('whip') && WhipOverlay}
    <WhipOverlay onerror={(error) => (store.error = error instanceof Error ? error.message : String(error))} />
  {/if}
</div>

<ContextMenu />
<DragGhost />
{#if tour && deferred.Onboarding}{@const Onboarding = deferred.Onboarding}<Onboarding {store} />{/if}
{#if deferred.ProjectPicker}{@const ProjectPicker = deferred.ProjectPicker}<ProjectPicker {store} />{/if}
<ConfirmDialog />
{#if deferred.ImportDialog}{@const ImportDialog = deferred.ImportDialog}<ImportDialog {store} />{/if}
{#if deferred.ConnectFlow}{@const ConnectFlow = deferred.ConnectFlow}<ConnectFlow {store} />{/if}
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

  .thread-chat {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* The frame: the cards keep `--frame-gap` from the window's right and bottom
     edges and from each other. The rails on the left stand on the frame, so
     only a folded column (RailFrame) leaves the chat or Agents card a left gap
     to keep itself. */
  @media (min-width: 721px) {
    .body {
      gap: var(--frame-gap);
      padding: 0 var(--frame-gap) var(--frame-gap) 0;
    }

    .body.sidebar-folded {
      padding-left: var(--frame-gap);
    }
  }

  /* Maximized, the panel takes the room and the chat column keeps none, not
     even its edge or the gap beside it. */
  .body.panel-maximized main {
    flex: none;
    width: 0;
    overflow: hidden;
    border: none;
    box-shadow: none;
    margin-right: calc(-1 * var(--frame-gap));
  }

  .boot {
    margin: auto;
  }

  .wide-recovery { flex: 1; min-width: 0; display: flex; overflow-y: auto; padding: 16px 24px; }
  .notice {
    flex: 1;
    min-width: 0;
    padding: 40px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
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
    /* Safari scrolls the document to reveal a focused field even with overflow
       hidden. Anchor the app to the viewport so its header does not leave with it. */
    .app:not(.shell) { position: fixed; left: 0; right: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); grid-template-columns: minmax(0, 1fr); height: var(--app-height, 100dvh); top: var(--app-top, 0px); overflow: hidden; }
    .app:not(.shell) :global(.titlebar) { display: none; grid-row: 2; grid-column: 1; }
    .app:not(.shell) .body { grid-row: 2; grid-column: 1; }
    /* The header owns the top safe area; pages keep clear of the home indicator. */
    .app.off-chat .body { padding-bottom: env(safe-area-inset-bottom, 0px); box-sizing: border-box; }
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
