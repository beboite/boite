<script lang="ts">
  import { errorText } from './lib/errors';
  import { onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { shellStarting, takeNotificationTarget } from './lib/endpoint';
  import { watchAgentBrowser } from './lib/agent-browser-watch';
  import { watchDevices } from './lib/device-watch';
  import { watchWindows } from './lib/window-watch';
  import { browserProfiles } from './lib/browser-profiles.svelte';
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
  import { handleAppKey } from './lib/app-keys';
  import { confirm } from './lib/confirm.svelte';
  import { startGlass } from './lib/glass';
  import { installExternalLinks } from './lib/links';
  import { installDropNavigationGuard } from './lib/drop-navigation';
  import { QUIT_HOLD_MS } from './lib/quit-hold';
  import { closingStores, confirmedQuitHold, desktopQuit, installQuitGuard } from './lib/shell-quit';
  import { notificationWords, onNotificationOpen, storeNotificationWords, storeWorkerLocale } from './lib/notify';
  import { strings } from './lib/strings';
  import { activeLocale } from './lib/i18n.svelte';
  import { retryOrReload } from './lib/retry-load';
  import { experimentOn } from './lib/experiments.svelte';
  import { contactsShown, contactsViews } from './lib/contacts-views.svelte';
  import { installWhipEscape } from './lib/whip.svelte';
  import { rightPanel } from './lib/right-panel.svelte';
  import { workspace } from './lib/workspace.svelte';
  import { hostLocalAgentBrowser } from './lib/agent-browser-host.svelte';
  import type { Store } from './lib/store.svelte';
  import { tourRequested, tourSeen } from './lib/onboarding.svelte';
  import { prefetchAllowed, prefetchNames, warmPages, whenIdle } from './lib/prefetch';
  import { mobileNavigation, parts, prefetchParts } from './lib/deferred-parts';
  import { voice } from './lib/voice-prefs.svelte';
  import { startTheme } from './lib/theme';
  import { appName, appUpdater } from './lib/app-update.svelte';
  import { reportDesktopUpdates } from './lib/desktop-update.svelte';
  import { watchUpdates } from './lib/update-watch';
  import MobileConnect from './components/MobileConnect.svelte';
  import { attentionCount, syncAppBadge } from './lib/badge';
  import { startViewport } from './lib/viewport';
  import { watchRest } from './lib/at-rest';
  import { watchLoopPhase } from './lib/loop-phase';
  import { WsClient } from './lib/client';
  import { listenForInstall } from './lib/pwa';
  import { appPage } from './lib/app-origin';
  import { localNetwork } from './lib/local-network.svelte';
  import { mobileOverlay } from './lib/mobile-history';
  import { startViewHistory } from './lib/view-history.svelte';
  import { agentAutoLink } from './lib/agent-links.svelte';
  import ThreadPreparation from './components/ThreadPreparation.svelte';
  import AgentsLayout from './components/agents/AgentsLayout.svelte';

  let store = $derived(workspace.active);
  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  // The phone's navigation (`lib/deferred-parts.ts`). A failed fetch (offline,
  // cold cache) lets the app draw with a bar that says so and retries, by hand,
  // when the core answers again or when the browser is back online.
  function loadMobileNavigation(): void {
    if (!inShell) void mobileNavigation.load().catch(() => undefined);
  }
  loadMobileNavigation();
  $effect(() => {
    if (store.connection === 'ready') untrack(loadMobileNavigation);
  });
  // The microphone sits in the composer's first frame: its chunk starts with the app too.
  if (voice.current.enabled) void parts.Dictation.load().catch(() => undefined);
  // The machine the window opened on may still give way to one that answers: until then nothing of it is drawn.
  const booted = $derived(store.booted && !(workspace.waiting && store === workspace.primary)
    && (inShell || mobileNavigation.current !== undefined || mobileNavigation.failed));
  // A core compacting its journal once before it serves: the start says so rather than only "Starting".
  let compacting = $state(false);
  $effect(() => {
    if (!inShell || booted) { compacting = false; return; }
    let live = true;
    const look = () => void shellStarting().then(starting => { if (live) compacting = starting?.phase === 'compacting'; });
    look();
    const timer = setInterval(look, 1000);
    return () => { live = false; clearInterval(timer); };
  });
  // New agent pages bring the panel forward on wider clients; phones stay on the user's chosen view.
  $effect(() => {
    const threadId = store.openThread?.id;
    void store.connection;
    if (threadId && store.client?.state === 'ready') return watchAgentBrowser(store, threadId);
  });
  // A simulator or emulator the agent opens shows up in the panel, here and on a phone (docs/devices.md); so does a desktop window it watches.
  $effect(() => {
    const threadId = store.openThread?.id;
    void store.connection;
    const stops = threadId && store.client?.state === 'ready' ? [watchDevices(store, threadId), watchWindows(store, threadId)] : [];
    return () => stops.forEach((stop) => stop());
  });
  const narrow = new MediaQuery('(max-width: 720px)');
  let appRoot = $state<HTMLDivElement | undefined>(undefined);
  let mobileScreen = $state<'chat' | 'threads' | 'activity'>('chat'), mobileTabs = $state(false);
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
    // The drawer, then xterm.js and its stylesheet: only once a terminal is asked for.
    TerminalDrawer: () => import('./components/TerminalDrawer.svelte'),
    TerminalView: () => import('./components/TerminalView.svelte'),
    // The project board, in the same drawer: only once it is asked for.
    BoardDrawer: () => import('./components/BoardDrawer.svelte'),
    PluginUpdateNotice: () => import('./components/PluginUpdateNotice.svelte')
  };
  type Deferred = { [K in keyof typeof deferredLoaders]?: Awaited<ReturnType<(typeof deferredLoaders)[K]>>['default'] };
  let deferred = $state.raw<Deferred>({});
  const requested = new Set<keyof Deferred>();
  let boardShown = $derived(store.openThread !== null && store.boardShown && store.boardAvailable());
  // One drawer at a time: the board, when it holds the drawer, wins over a terminal left open.
  let terminalShown = $derived(store.openThread !== null && store.owner && store.terminalShown(store.openThread.id) && !boardShown);
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
  // Once the first load has landed rather than against it, and the rest only on a
  // link that can spare the bytes (lib/prefetch.ts). The plugin update notice reads its own list, so it loads on any link.
  $effect(() => {
    if (!store.booted) return;
    return whenIdle(() => { if (!prefetchAllowed()) return need('PluginUpdateNotice'); needAll(); prefetchParts(); warmPages(store, experimentOn('resident-agents')); });
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
  hostLocalAgentBrowser();
  let SettingsShell = $state<typeof import('./components/SettingsShell.svelte').default>();
  // Switched off with the page open: every machine goes back to its chat, so
  // switching it on again does not reopen a page nobody navigated to.
  $effect(() => {
    if (experimentOn('resident-agents')) return;
    for (const machine of workspace.machines) if (machine.store.page === 'agents') machine.store.showChat();
  });
  const contacts = contactsViews(() => store, () => workspace.machines, () => narrow.current);
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
    if (terminalShown) {
      need('TerminalDrawer');
      need('TerminalView');
    }
  });

  $effect(() => {
    if (boardShown) need('BoardDrawer');
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

  // This computer's own setting decides whether the window's updater installs by itself.
  $effect(() => { appUpdater.autoInstall = workspace.machines.find((machine) => machine.store.localCore)?.store.settings?.autoInstallUpdates === true; });

  onMount(() => {
    const stopViewport = startViewport();
    const stopRest = watchRest();
    const stopLoopPhase = watchLoopPhase();
    const stopInstall = listenForInstall();
    const stopAutoLink = agentAutoLink.start();
    // Another machine of the group reads this computer's app updates from its core.
    const stopDesktopReport = reportDesktopUpdates(() => workspace.machines.map((machine) => machine.store));
    const stopUpdates = watchUpdates(() => workspace.machines.map((machine) => machine.store));
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
    // The app's page is public and every machine is on a private address: Chrome lets its sockets through once "Local network" is allowed.
    const stopLocalNetwork = appPage() ? localNetwork.start(resume) : () => undefined;
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    window.addEventListener('pageshow', pageshow);
    const notification = (event: MessageEvent) => { if (workspace.workerMessage(event.data)) mobileScreen = 'chat'; };
    navigator.serviceWorker?.addEventListener('message', notification);
    return () => {
      stopViewport();
      stopRest();
      stopLoopPhase();
      stopAutoLink();
      stopDesktopReport();
      stopInstall();
      stopUpdates();
      stopLocalNetwork();
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
  const boardSlot = new Closing();
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
  const requestQuit = desktopQuit(() => closingStores(workspace.machines), () => { quitting = true; });
  onMount(() => { if (inShell) return installQuitGuard(requestQuit, error => { store.error = String(error); }); });
  const quitHold = inShell
    ? confirmedQuitHold(requestQuit, {
        onHolding: (holding) => {
          if (holding) quitHint.show();
          else quitHint.hide();
        },
        hasQuit: () => quitting,
        failed: error => { store.error = String(error); }
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
    // Chrome refuses every socket until "Local network" is allowed: the recovery screen says so, and "socket error" says nothing more.
    const blocked = mobileRecovery && localNetwork.state === 'denied';
    if (!error || owner.errorOffline || pairingNotice || held || blocked) {
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

  /**
   * The thread the right panel belongs to: the chat's open thread, or on the
   * Agents page the agent's own; an ordinary thread left open behind the
   * Agents page has no panel there.
   */
  const panelThread = $derived(store.page === 'agents' ? (store.openThread?.agentSessionId ? store.openThread : null) : store.openThread);
  $effect(() => {
    if (store.panelOpen && panelThread) panelSlot.show();
    else panelSlot.hide();
  });
  $effect(() => {
    // The drawer opens once its chunk is here, so its opening animation plays whole.
    if (terminalShown && deferred.TerminalDrawer) terminalSlot.show();
    else {
      // The drawer goes inert as it leaves, which drops the focus on `<body>`:
      // the keyboard goes back to the composer first.
      if (document.activeElement?.closest('[data-testid=terminal-drawer]')) focusComposer();
      terminalSlot.hide();
    }
  });
  $effect(() => {
    if (boardShown && deferred.BoardDrawer) boardSlot.show();
    else {
      if (document.activeElement?.closest('[data-testid=board-drawer]')) focusComposer();
      boardSlot.hide();
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
    void storeWorkerLocale(activeLocale());
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
    const stores = workspace.machinesOr(store).map((machine) => machine.store);
    const count = attentionCount(stores);
    const name = appName();
    document.title = count > 0 ? `(${count}) ${name}` : name;
    if (!inShell) syncAppBadge(count);
  });

  onMount(() => {
    // A notification tapped with no window open: taken off the address at
    // once, so a reload during the boot does not jump there again.
    const tapped = takeNotificationTarget();
    const stopSettingsSync = workspace.settingsSync.start();
    const stopGroupLinks = workspace.groups.start();
    void workspace.bootAt(tapped);
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

    // A drag from the Explorer: the shell says what each path is, a folder
    // becomes a project and a file goes to the message being written.
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
    void import('./lib/native-drop').then(async ({ listenNativeDrop }) => {
      const stop = await listenNativeDrop(workspace);
      if (disposed) stop(); else unlisten = stop;
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

  /**
   * Every app chord goes through the keyboard table (`lib/keybindings.ts`,
   * the defaults under the user's `keybindings.json`), so a moved key moves
   * here, in the palette hints and in the tooltips at once. The quit hold is
   * the one chord that stays where it is.
   */
  function onkeydown(event: KeyboardEvent) {
    handleAppKey(event, { store, inShell, modal, quitHold });
  }

</script>

<svelte:window {onkeydown} {onkeyup} {onblur} ononline={() => { if (mobileNavigation.failed) loadMobileNavigation(); }} />

{#each workspace.machines as machine (machine.id)}
  <ThreadPreparation store={machine.store} visible={machine.store === store && documentVisible && (inShell || mobileScreen === 'chat')} />
{/each}
{#if !workspace.machines.some(machine => machine.store === store)}
  <ThreadPreparation {store} visible={documentVisible && (inShell || mobileScreen === 'chat')} />
{/if}

<div class="app" class:shell={inShell} class:ready={booted} class:phone-chat={!inShell && !mobileRecovery && store.page === 'chat' && mobileScreen === 'chat'} class:off-chat={!inShell && store.page !== 'chat'} class:tabbed={!inShell && mobileTabs} class:quitting bind:this={appRoot}>
  {#if !inShell && booted}
    {#if mobileNavigation.current}
      {@const MobileNavigation = mobileNavigation.current}
      <MobileNavigation {store} recover={mobileRecovery} bind:screen={mobileScreen} bind:tabbed={mobileTabs} />
    {:else}
      <p class="mobile-navigation-failed" role="alert" data-testid="mobile-navigation-failed">
        <span>{strings.parts.navigationFailed}</span>
        <button type="button" data-testid="mobile-navigation-retry" onclick={() => void retryOrReload(() => mobileNavigation.load())}>{strings.common.retry}</button>
      </p>
    {/if}
  {/if}
  <TitleBar {store} />

  <div class="body" class:mobile-covered={!inShell && store.page === 'chat' && (mobileScreen !== 'chat' || mobileRecovery)} class:panel-maximized={(store.page === 'chat' || store.page === 'agents') && rightPanel.maximized && !rightPanel.floating && store.panelOpen} class:sidebar-folded={sidebarFolded}>
    {#if !booted}
      <p class="empty boot" class:long={compacting}>{compacting ? strings.app.compacting : strings.app.loading}</p>
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
          <button type="button" class="primary" data-preload-view="settings" onclick={() => store.showSettings()}>
            {strings.app.openSettings}
          </button>
        </div>
      {/if}
    {:else if store.page === 'agents' && experimentOn('resident-agents')}
      <AgentsLayout {store} panel={panelSlot} showPanel={panelSlot.shown && panelThread !== null} RightPanel={deferred.RightPanel} />
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
      {#if store.page === 'home' && contactsShown(store)}
        <!-- Contacts take the chat's card; the thread list stays beside them. -->
        <main><div class="thread-chat framed">
          {#if contacts.HomePage}{#key store}<contacts.HomePage {store} />{/key}{:else}<p class="empty">{contacts.homeError || strings.app.loading}</p>{/if}
        </div></main>
      {:else}
      <main>
        <div class="thread-chat framed">
          {#key store}
            <ChatView {store} />
          {/key}
        </div>
        {#if terminalSlot.shown && store.openThread && deferred.TerminalDrawer}
          {@const TerminalDrawer = deferred.TerminalDrawer}
          {#key store}
            {#key store.openThread.id}
              <TerminalDrawer {store} threadId={store.openThread.id} cwd={store.openThread.cwd}
                view={deferred.TerminalView}
                closing={terminalSlot.closing} attach={terminalSlot.attach} onexit={terminalSlot.end} />
            {/key}
          {/key}
        {/if}
        {#if boardSlot.shown && store.openThread && deferred.BoardDrawer}
          {@const BoardDrawer = deferred.BoardDrawer}
          <!-- Not keyed on the thread: the board is the project's, the same in each of its threads. -->
          {#key store}
            <BoardDrawer {store} threadId={store.openThread.id}
              closing={boardSlot.closing} attach={boardSlot.attach} onexit={boardSlot.end} />
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
      <!-- Not keyed on the machine: the column lists every machine's contacts, and a new one would slide in again. -->
      {#if contacts.ContactsRail && contactsShown(store) && !narrow.current}<contacts.ContactsRail {store} />{/if}
    {/if}
  </div>

  {#if store.dropping}
    <DropOverlay kind={store.dropping} />
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
  <UndoToast onerror={(error) => (store.error = errorText(error))} />
  {#if store.booted && experimentOn('whip') && WhipOverlay}
    <WhipOverlay onerror={(error) => (store.error = errorText(error))} />
  {/if}
</div>

<ContextMenu />
<DragGhost />
{#if tour && deferred.Onboarding}{@const Onboarding = deferred.Onboarding}<Onboarding {store} />{:else if deferred.PluginUpdateNotice}{@const PluginUpdateNotice = deferred.PluginUpdateNotice}<PluginUpdateNotice />{/if}
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
  .boot.long { max-width: 360px; padding: 0 24px; text-align: center; }

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

  .mobile-navigation-failed { display: none; }

  @media (max-width: 720px) {
    /* The navigation's place when its chunk did not load: it says so, with a retry. */
    .app:not(.shell) .mobile-navigation-failed { display: flex; grid-row: 1; grid-column: 1; align-items: center; gap: 10px; margin: 0; min-height: 60px; padding: max(8px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left)); border-bottom: 1px solid var(--color-border); color: var(--color-danger); }
    .mobile-navigation-failed button { flex: none; min-height: 44px; padding: 0 14px; border-radius: var(--radius-md); }
    /* Safari scrolls the document to reveal a focused field even with overflow
       hidden. Anchor the app to the viewport so its header does not leave with it. */
    .app:not(.shell) { position: fixed; left: 0; right: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; grid-template-columns: minmax(0, 1fr); height: var(--app-height, 100dvh); top: var(--app-top, 0px); overflow: hidden; }
    .app:not(.shell) :global(.titlebar) { display: none; grid-row: 2; grid-column: 1; }
    .app:not(.shell) .body { grid-row: 2; grid-column: 1; }
    /* The header owns the top safe area; pages keep clear of the home indicator, unless the bottom bar (tabbed) does. */
    .app.off-chat:not(.tabbed) .body { padding-bottom: env(safe-area-inset-bottom, 0px); box-sizing: border-box; }
    /* Skips layout and paint of the chat streaming behind the list; its DOM, state and scroll stay as they were.
       Skipped content does not advance its animations, so the switch waits for the exits the cover started
       (a menu closing) to end, and lifts at once on return. */
    .body.mobile-covered { visibility: hidden; pointer-events: none; content-visibility: hidden; transition: content-visibility 0s var(--dur-whip) allow-discrete; }
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
