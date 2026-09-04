<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { isFinished } from "$lib/domain/thread-status";
  import { clearFinished } from "$lib/features/thread/finished.svelte";
  import { workspace, backend } from "$lib/backend";
  import { reportSettingsSnapshot } from "$lib/features/setup/telemetry";
  import { settings } from "$lib/features/settings/store.svelte";
  import { homeAvailable } from "$lib/features/settings/homeAvailable";
  import { pickAndAddProject } from "$lib/features/project/api";
  import { ptyKill } from "$lib/storage/pty";
  import { reloadThread, warmWorktreeFor } from "$lib/features/thread/api";
  import TitleBar from "$lib/shared/components/TitleBar.svelte";
  import CloseGuard from "$lib/app/CloseGuard.svelte";
  import ProjectSidebar from "$lib/features/project/ProjectSidebar.svelte";
  import Toaster from "$lib/features/notifications/Toaster.svelte";
  import { toastArea } from "$lib/features/notifications/anchor.svelte";
  import ConfirmHost from "$lib/shared/components/ConfirmHost.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import RemoteLogin from "$lib/features/workspace/RemoteLogin.svelte";
  import ConnectionBanner from "$lib/features/workspace/ConnectionBanner.svelte";
  import FolderBrowser from "$lib/features/project/FolderBrowser.svelte";
  import {
    paneStore,
    paneViewport,
    threadLeavesOf,
  } from "$lib/features/panes/store.svelte";
  import { panePresence } from "$lib/features/panes/open";
  import { logger } from "$lib/shared/services/logger.svelte";
  import { statusEngine } from "$lib/features/thread/statusEngine";
  import { watchWindowFocus } from "$lib/app/focus.svelte";
  import PaneShell from "$lib/features/panes/PaneShell.svelte";
  import PaneOverlay from "$lib/features/panes/PaneOverlay.svelte";
  import { parseThreadLink } from "$lib/domain/awareness";
  import PaneDropOverlay from "$lib/features/panes/PaneDropOverlay.svelte";
  import GitPanel from "$lib/features/git/GitPanel.svelte";
  import ExplorerPanel from "$lib/features/explorer/ExplorerPanel.svelte";
  // Already in the entry graph as a pane leaf, so the phone's tab costs nothing
  // the window was not downloading anyway.
  import TodoPanel from "$lib/features/todo/TodoPanel.svelte";
  import MobileTopBar from "$lib/features/mobile/MobileTopBar.svelte";
  import MobileBottomBar from "$lib/features/mobile/MobileBottomBar.svelte";
  import MobileProjectsPage from "$lib/features/mobile/MobileProjectsPage.svelte";
  import { infoBoxInset } from "$lib/features/infobox/strip";
  import { lazyComponent, prefetchWhenIdle } from "$lib/shared/lazy.svelte";
  import { syncStore } from "$lib/features/sync/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import type { MessageKey } from "$lib/i18n/messages";
  import { fade, fly } from "svelte/transition";
  import { DUR, easeOutQuint } from "$lib/theme/motion";

  // Data rather than markup, so the stagger is an index and not five copies of
  // the same transition written out by hand.
  const WELCOME_KEYS: { keys: string[]; label: MessageKey }[] = [
    { keys: ["Ctrl", "T"], label: "welcome.newTerminal" },
    { keys: ["Ctrl", "Tab"], label: "welcome.cycleThreads" },
    { keys: ["Ctrl", "1-9"], label: "welcome.jumpToThread" },
    { keys: ["Ctrl", "Shift", "E"], label: "welcome.splitPane" },
    { keys: ["Ctrl", "B"], label: "welcome.toggleSidebar" },
    { keys: ["Ctrl", "W"], label: "welcome.closeThread" },
  ];

  // xterm (~300 KB) and CodeMirror (~600 KB) dwarf the rest of the app. Held
  // behind import() they leave the entry graph entirely, so the window paints
  // without parsing either. The terminal chunk is warmed on idle because it is
  // the one almost every session ends up needing.
  const TerminalView = lazyComponent(
    () => import("$lib/features/terminal/Terminal.svelte"),
  );
  const EditorView = lazyComponent(
    () => import("$lib/features/editor/EditorPanel.svelte"),
  );
  // Four tabs of form controls that most sessions never open.
  const SettingsView = lazyComponent(
    () => import("$lib/features/settings/SettingsPanel.svelte"),
  );
  // Seen once in the lifetime of an install. A static import would keep its
  // four screens and their icons in the entry chunk forever.
  const SetupView = lazyComponent(
    () => import("$lib/features/setup/SetupWizard.svelte"),
  );
  const TelemetryOverlayView = lazyComponent(
    () => import("$lib/features/setup/TelemetryOverlay.svelte"),
  );

  let telemetryOnboarding = $state<"unknown" | "pending" | "done">("unknown");
  const ProjectView = lazyComponent(
    () => import("$lib/features/project/ProjectPage.svelte"),
  );
  // Four cards read once a machine is set up, and the fastpick table behind
  // one of them. Behind import() like every other page opened on purpose.
  const PluginsView = lazyComponent(
    () => import("$lib/features/plugin/PluginsPage.svelte"),
  );
  // Behind import(): a boot that never arms the experiment never fetches it.
  const HomeView = lazyComponent(
    () => import("$lib/features/home/HomePage.svelte"),
  );
  // A canvas and a rope simulation, for an experiment that is off by default.
  // Behind import(), a boot that never switches it on never fetches it.
  // Behind import(): a machine whose configuration never differs never fetches
  // the merge tool, and it drags @codemirror/merge and the language table in
  // behind it. The sync store itself imports none of that, on purpose, a test
  // asserts it, because the launch pull puts the store on the boot graph.
  const SyncMergeView = lazyComponent(
    () => import("$lib/features/sync/SyncMergeOverlay.svelte"),
  );
  const WhipView = lazyComponent(
    () => import("$lib/features/whip/WhipOverlay.svelte"),
  );
  // The strip above every terminal. Behind import() so it lands with the
  // terminal chunk rather than in the first paint, and never at all on a phone.
  const InfoBoxView = lazyComponent(
    () => import("$lib/features/infobox/ProjectInfoBox.svelte"),
  );

  let activated = $state<Record<string, true>>({});

  // Phone layout: no sidebar/side panel, a bottom bar drives full-width pages.
  // The terminal viewport stays the single always-mounted PTY host in both
  // layouts; only the chrome around it and what overlays it change.
  const mobile = $derived(settings.state.mobileLayout);
  const terminalActive = $derived(
    mobile ? app.mobileTab === "terminal" : app.view === "terminal",
  );
  const settingsActive = $derived(
    mobile ? app.mobileTab === "settings" : app.view === "settings",
  );
  // Nothing arming home: always false, so every branch below collapses to
  // today's chrome.
  const homeActive = $derived(
    homeAvailable(settings.state) &&
      (mobile ? app.mobileTab === "home" : app.view === "home"),
  );

  // Colored inset outline marks the PURE remote workspace: green connected,
  // amber (pulsing) while connecting or dropped. There the boite IS the
  // workspace, so a window-wide ring is the truth.
  //
  // Dynamic mode gets none of it, dropped included. Two sources are live at
  // once and only one of them went away: ringing the whole window says the app
  // is down while the local half keeps working, which is the loudest possible
  // way to be wrong. What is unreachable is marked where it is instead: the
  // imported project blocks in the sidebar, and the pane of an open remote
  // thread, both below.
  const outlineClass = $derived.by(() => {
    if (workspace.mode !== "remote") return "";
    return workspace.connection === "connected" ? "ws-remote-ok" : "ws-remote-warn";
  });

  // Dynamic mode with its boite unreachable. Scopes the marks that replace the
  // window ring; false in pure remote mode, where the ring above already said it.
  const boiteDown = $derived(
    workspace.isDynamic && workspace.hasRemote && workspace.connection !== "connected",
  );

  $effect(() => {
    // Which threads, not how many. A count cannot see a replacement, close
    // four and launch four and it reads 60 both times, and a group this never
    // made is a thread with no terminal drawn at all, since the wrapper below
    // needs a group and a rect. Nothing then mounts, nothing spawns, and
    // nothing is logged. `projectId` too: a move keeps the same id, and without
    // it the group stays stamped on the project the thread just left.
    for (const t of app.threads) {
      void t.id;
      void t.projectId;
    }
    // untrack: syncWithThreads reads AND writes paneStore.groups/rects;
    // tracked, this effect re-ran on its own writes and on every
    // ResizeObserver tick during pane drags.
    untrack(() => paneStore.syncWithThreads());
  });

  const activeGroupId = $derived.by(() => {
    if (app.activeThreadId) {
      return paneStore.groupOf(app.activeThreadId)?.id ?? null;
    }
    // A group with no terminal in it: git, files or the todo list opened on a
    // project nobody has launched anything in. Nothing sets `activeThreadId`
    // for one, so which group is on screen has to come from the project.
    const projectId = app.currentProjectId;
    if (!projectId) return null;
    return (
      paneStore.groups.find(
        (g) => g.projectId === projectId && threadLeavesOf(g.root).length === 0,
      )?.id ?? null
    );
  });

  // Selecting a thread focuses its pane, and that is all: the write is
  // untracked because it used to read the field it writes, which subscribed the
  // effect to its own output (AGENTS.md, rule 4). Every later focus change in
  // that group, a panel opened beside the terminal, a chip tapped on the
  // phone's pane strip, re-ran this and was put straight back on the thread.
  $effect(() => {
    const id = app.activeThreadId;
    if (!id) return;
    const g = paneStore.groupOf(id);
    if (!g) return;
    untrack(() => {
      if (g.focusedPaneId !== id) g.focusedPaneId = id;
    });
  });

  // The project the app came up on. Nobody asked for a thread in it, it is
  // where the last session happened to stop, so warming it would make every
  // single start pay for a checkout and a copy of the build artifacts in the
  // background. `undefined` until the effect below has run once, which is how
  // that first value is told from a project the user moved to.
  let bootProjectId: string | null | undefined;

  // Moving to a project is the first honest sign a thread is about to be
  // launched in it, and a worktree takes long enough to make that it has to
  // start now rather than on the click.
  //
  // Reads the id and nothing else: looking the project up inside the effect
  // would take a dependency on the whole `projects` array, and every rename,
  // every usage refresh, every reorder would re-run this.
  $effect(() => {
    const id = app.selectedProjectId;
    if (bootProjectId === undefined) {
      bootProjectId = id;
      return;
    }
    untrack(() => warmWorktreeFor(app.projects.find((p) => p.id === id) ?? null));
  });

  function activateThread(id: string) {
    const t = app.threadById(id);
    const finished = !!t && isFinished(t.status);

    // Reading it is what takes the unread mark back, and every way in has to
    // do it: the sidebar row cleared its own, so a thread reached from the
    // palette, a keyboard jump or a pane kept blinking behind the terminal the
    // user was already looking at.
    clearFinished(id);

    if (app.activeThreadId === id && app.view === "terminal" && !finished) {
      return;
    }

    activated[id] = true;
    if (finished) {
      void reloadThread(id);
      app.view = "terminal";
      return;
    }
    app.activeThreadId = id;
    if (t) app.selectedProjectId = t.projectId;
    app.view = "terminal";
  }

  function focusPane(threadId: string) {
    activateThread(threadId);
  }

  async function addProject(target?: "local" | "remote") {
    await pickAndAddProject(target);
  }

  async function removeProject(projectId: string) {
    const threads = app.threadsByProject(projectId);
    for (const t of threads) {
      if (t.ptyId) {
        void ptyKill(t.ptyId, false).catch(() => {});
      }
      delete activated[t.id];
    }
    activated = { ...activated };
    await app.removeProject(projectId);
  }

  // `activated` is both read and written by the four effects below, so a plain
  // read made each of them depend on the map they were about to change: every
  // activation scheduled one extra run of itself. The trigger stays tracked, the
  // bookkeeping does not.
  function markActivated(id: string) {
    untrack(() => {
      if (!activated[id]) activated[id] = true;
    });
  }

  $effect(() => {
    const id = app.activeThreadId;
    if (id && app.hasThread(id)) markActivated(id);
  });

  $effect(() => {
    const g = paneStore.groups.find((x) => x.id === activeGroupId);
    if (!g) return;
    for (const leafId of paneStore.visibleThreads(activeGroupId)) {
      if (app.hasThread(leafId)) markActivated(leafId);
    }
  });

  // Whether the window is in front, tracked in one place. `storage/notify.ts`
  // reads it to decide whether an OS notification is worth raising at all.
  onMount(() => watchWindowFocus());

  // Mounting a Terminal is what spawns its PTY, so the post-update resume asks
  // for its threads here rather than reaching into this component's state.
  $effect(() => {
    const requested = app.requestedActivations;
    if (requested.length === 0) return;
    for (const id of requested) {
      if (app.hasThread(id)) markActivated(id);
    }
    untrack(() => app.clearRequestedActivations());
  });

  $effect(() => {
    const valid = new Set(app.threads.map((t) => t.id));
    untrack(() => {
      let dirty = false;
      for (const id of Object.keys(activated)) {
        if (!valid.has(id)) {
          delete activated[id];
          dirty = true;
        }
      }
      if (dirty) activated = { ...activated };
    });
  });

  /**
   * Says so when the thread the user is looking at has no terminal drawn.
   *
   * A pane needs three things at once, an entry in `activated`, a group, and a
   * rect, and failing any of them draws nothing at all. Nothing downstream then
   * runs: no mount, no spawn, no error, and a release log that says the worktree
   * was handed over and stops. That silence is the whole reason this bug outlived
   * three releases, so the three flags are named here rather than reasoned about
   * from the outside.
   *
   * On a delay, because all three are false for a frame or two on any normal
   * launch: the row lands, the group is made by an effect, and the rect is
   * synthesised or measured after that. What this catches is the state that
   * never resolves. Keyed to the active thread, so it costs one timer per
   * selection change and nothing at all while the user reads.
   */
  $effect(() => {
    const id = app.activeThreadId;
    if (!id) return;
    const timer = setTimeout(() => {
      const group = paneStore.groupOf(id);
      const visible = group?.id === activeGroupId && terminalActive;
      const rect = group ? paneStore.rectFor(id, group, visible) : null;
      if (activated[id] && group && rect) return;
      logger.warn("panes", `${app.threadById(id)?.label ?? id}: no terminal drawn`, {
        threadId: id,
        activated: !!activated[id],
        group: group?.id ?? null,
        rect: !!rect,
        measured: !!paneStore.rects[id],
        // The list the pane wrappers iterate, next to the lookup everything
        // else goes through. They disagreed once, and that disagreement is the
        // whole bug; naming both is what tells a missing thread from a thread
        // the store cannot find.
        inThreads: app.threads.some((t) => t.id === id),
        known: !!app.threadById(id),
        activeGroupId,
        terminalActive,
        view: app.view,
        viewport: paneStore.viewport,
        groups: paneStore.groups.length,
      });
    }, 2000);
    return () => clearTimeout(timer);
  });

  onMount(() => prefetchWhenIdle(TerminalView));

  /**
   * The thread a notification was about, if the window was opened by one.
   *
   * `boite_core::awareness` writes one format and both hosts resolve it here.
   * The PWA arrives with it in the query, put there by the service worker
   * opening the push payload's `url`; the desktop has no origin for a URL to
   * resolve against, so it only ever sees one when something in-process sets it.
   * Same parser either way, which is why the format has one owner.
   *
   * Read once and cleared, so a refresh does not re-open what the user has
   * since navigated away from.
   */
  let pendingLink = $state<{ threadId: string } | null>(null);

  onMount(() => {
    const link = parseThreadLink(window.location.search);
    if (!link) return;
    pendingLink = { threadId: link.threadId };
    window.history.replaceState(window.history.state, "", window.location.pathname);
  });

  // Waits for the row rather than for `ready`: a workspace finishes hydrating
  // before its threads land on a remote boite, and a link consumed against an
  // empty store would be spent on a thread the app has not heard of yet.
  // `activateThread` moves the sidebar to the thread's own project, so the
  // `project` the link carries is for whoever renders it, not for this.
  $effect(() => {
    const link = pendingLink;
    if (!link || !app.ready || !app.hasThread(link.threadId)) return;
    untrack(() => {
      activateThread(link.threadId);
      app.mobileTab = "terminal";
      pendingLink = null;
    });
  });

  // The status sweep belongs to the window, not to whichever pane happens to be
  // mounted. It used to be started and stopped by the Terminal components
  // themselves, so with no local pane open (the project page, the dashboard, a
  // dynamic workspace showing only the boite's threads) nothing demoted a
  // finished agent and its dot stayed lit until a click brought a pane back.
  onMount(() => {
    statusEngine.start();
    return () => statusEngine.stop();
  });

  $effect(() => {
    for (const _id in activated) {
      void TerminalView.ensure();
      break;
    }
  });

  $effect(() => {
    if (app.view === "editor") void EditorView.ensure();
  });

  $effect(() => {
    if (app.view === "project") void ProjectView.ensure();
  });

  $effect(() => {
    if (homeActive) void HomeView.ensure();
  });

  $effect(() => {
    if (settingsActive) void SettingsView.ensure();
  });

  $effect(() => {
    if (app.view === "plugins") void PluginsView.ensure();
  });

  $effect(() => {
    if (app.ready && !settings.state.setupCompleted) {
      void SetupView.ensure();
    }
  });

  $effect(() => {
    if (!app.ready || !settings.ready) return;
    if (!settings.state.setupCompleted) {
      telemetryOnboarding = "done";
      return;
    }
    untrack(() => {
      void backend()
        .telemetry.state()
        .then((state) => {
          telemetryOnboarding = state.onboardingCompleted ? "done" : "pending";
          if (state.onboardingCompleted) void reportSettingsSnapshot();
        })
        .catch(() => {
          telemetryOnboarding = "done";
        });
    });
  });

  $effect(() => {
    if (telemetryOnboarding === "pending") void TelemetryOverlayView.ensure();
  });

  // Fetched when the experiment is armed rather than when the button is
  // pressed: the chunk has to be mounted and listening for the pointer before
  // the first throw, or the rope spawns wherever the pointer was at boot.
  $effect(() => {
    if (settings.state.experimentWhip) void WhipView.ensure();
  });

  // The info box is no longer behind a flag, so its chunk is fetched as soon as
  // there is a terminal view to draw it over rather than when a switch is
  // flipped.
  $effect(() => {
    if (!mobile) void InfoBoxView.ensure();
  });

  // The launch pull, and deliberately not part of the boot.
  //
  // After `app.ready`, which is after the boot timing has been reported: a git
  // fetch sitting inside `app.init` would land between two boot marks and blame
  // sync for a slow open. It is not a boot phase and must never look like one.
  //
  // `untrack` because pullAtLaunch reads settings and writes its own store, and
  // without it the effect would subscribe to what it just wrote. The store
  // itself does nothing when the switch is off or no repository is named, and
  // once per transport identity, so a workspace grafted later gets its own.
  $effect(() => {
    if (!app.ready || !settings.ready) return;
    if (!settings.state.syncOnLaunch || !settings.state.syncRemoteUrl) return;
    untrack(() => {
      void SyncMergeView.ensure().then(() => syncStore.pullAtLaunch());
    });
  });

  // Opening the Sync tab with something waiting is the strongest signal the
  // merge view is about to be needed.
  $effect(() => {
    if (syncStore.pending > 0) prefetchWhenIdle(SyncMergeView);
  });

  // Opening the Files or Git panel is the strongest signal that a file or a
  // diff is about to be opened; warm the editor before the click lands. The
  // pane tree is the whole answer now that those panels have no other home.
  $effect(() => {
    if (panePresence("git") || panePresence("explorer")) {
      prefetchWhenIdle(EditorView);
    }
  });

</script>

<!-- h-dvh, not h-screen: on a phone `100vh` is the large viewport, so with the
     browser's URL bar showing, the shell was taller than the visible area and
     `overflow-hidden` put MobileBottomBar below the fold with no way to reach
     it. `w-full` rather than `w-screen` for the same reason on the other axis
     (`100vw` includes the scrollbar gutter). -->
<div
  class="flex h-dvh w-full flex-col overflow-hidden bg-background"
  class:mobile-mode={mobile}
>
  <CloseGuard />
  {#if mobile}
    <MobileTopBar />
  {:else}
    <TitleBar />
  {/if}
  <FolderBrowser />
  <!-- Above the keyed block, next to FolderBrowser: these two used to live
       inside <main>, which the login and setup branches never render. A failed
       connection raises a toast from the login screen, and there was no host to
       draw it; a confirm asked from there never settled at all. -->
  <ConfirmHost />
  <Toaster />

  {#key workspace.epoch}
  {#if workspace.needsLogin}
    <div class="flex min-h-0 flex-1">
      <RemoteLogin />
    </div>
  {:else if app.ready && !settings.state.setupCompleted}
    <!-- After the workspace is initialized, never before: the wizard asks the
         backend which agents are installed, and on a remote boite that answer
         only exists once the connection is up. `app.ready` is what says so.
         `needsLogin` alone was not enough: a PWA that boots with an unreachable
         boite is no longer sent to the login form, so the settings behind this
         test are the unhydrated defaults and every such boot drew the wizard. -->

    {#if SetupView.current}
      {@const SetupComp = SetupView.current}
      <SetupComp />
    {/if}
  {:else if app.ready && settings.state.setupCompleted && telemetryOnboarding === "pending"}
    {#if TelemetryOverlayView.current}
      {@const Overlay = TelemetryOverlayView.current}
      <Overlay onDone={() => (telemetryOnboarding = "done")} />
    {/if}
  {:else if app.ready && settings.state.setupCompleted && telemetryOnboarding === "unknown"}
    <div class="flex min-h-0 flex-1"></div>
  {:else}
    <div class="flex min-h-0 flex-1">
    <!-- Home keeps the sidebar. It used to drop it, which made the one view a
         user lands on the one view with no way to reach a thread: the door in
         was a click and the way back was the titlebar. The threads are what the
         workspace is, and home is a page about them, not a mode without them. -->
    {#if !mobile && !settings.state.sidebarCollapsed}
      <ProjectSidebar
        onActivateThread={activateThread}
        onNewProject={addProject}
        onRemoveProject={removeProject}
      />
    {/if}

    <!-- use:toastArea: the toast stack is fixed to the window, and this is what
         keeps it over the work area rather than over the docked panel. -->
    <main class="relative flex min-w-0 flex-1 flex-col" use:toastArea>
      {#if !app.ready}
        <div class="flex h-full items-center justify-center">
          <p class="text-sm text-muted-2">{t("common.loading")}</p>
        </div>
      {:else}
        <div
          class="flex h-full min-h-0 flex-col"
          class:hidden={!terminalActive}
        >
          <!-- Skipped whenever a group is on screen: with no terminal running
               that group is a panel the user opened on purpose, and a welcome
               card taking the full height would leave it nothing to draw in. -->
          {#if app.threads.length === 0 && !activeGroupId}
            <div class="flex h-full items-center justify-center">
              <div class="flex flex-col items-center gap-4 text-center">
                <span class="text-muted-2">
                  <BoiteLogo size={64} />
                </span>
                <p class="text-sm text-muted-foreground">
                  {app.projects.length === 0
                    ? t("welcome.pickFolder")
                    : mobile
                      ? t("welcome.tapToOpen")
                      : t("welcome.clickShortcut")}
                </p>
                {#if app.projects.length === 0}
                  <button
                    type="button"
                    class="rounded-md border border-edge bg-[var(--color-surface)] px-3 py-1.5 text-sm text-foreground transition hover:bg-[var(--color-surface-2)]"
                    onclick={() => addProject()}
                  >
                    {t("common.chooseFolder")}
                  </button>
                {/if}
              </div>
            </div>
          {:else if app.activeThreadId === null && !activeGroupId && mobile}
            <div class="flex h-full items-center justify-center px-8 text-center">
              <p class="text-sm text-muted-foreground">
                {t("welcome.tapOrPick")}
              </p>
            </div>
          {:else if app.activeThreadId === null && !activeGroupId}
            <!-- The largest surface in the app, and it used to be a 200px
                 cheat-sheet floating in a thousand pixels of nothing. Same
                 information, given a container and a reason to be there, and
                 the rows arrive one after another rather than all at once. -->
            <div class="flex h-full items-center justify-center p-8">
              <div
                class="flex flex-col items-center gap-5 rounded-lg border border-border bg-[var(--color-surface)]/60 px-10 py-8 shadow-e2"
                in:fade={{ duration: DUR.slow, easing: easeOutQuint }}
              >
                <span class="text-muted-2"><BoiteLogo size={40} /></span>
                <p class="text-base text-muted-foreground">
                  {t("welcome.pickThread")}
                </p>
                <div class="grid grid-cols-[auto_auto] gap-x-6 gap-y-2 text-xs text-muted-2">
                  {#each WELCOME_KEYS as row, i (row.label)}
                    <span
                      class="text-right"
                      in:fly={{
                        y: 4,
                        duration: DUR.slow,
                        delay: 60 + i * 35,
                        easing: easeOutQuint,
                      }}
                    >
                      {#each row.keys as k (k)}<kbd class="kbd">{k}</kbd>{" "}{/each}
                    </span>
                    <span
                      in:fly={{
                        y: 4,
                        duration: DUR.slow,
                        delay: 60 + i * 35,
                        easing: easeOutQuint,
                      }}
                    >
                      {t(row.label)}
                    </span>
                  {/each}
                </div>
              </div>
            </div>
          {/if}

          <div
            class="relative min-h-0 flex-1 bg-[var(--color-background)]"
            data-pane-viewport
            use:paneViewport
          >
            {#each paneStore.groups as group (group.id)}
              {@const visible = activeGroupId === group.id && terminalActive}
              <!-- Hidden rather than unmounted, which is what keeps a terminal
                   alive in the group nobody is looking at, and what lets a
                   browser pane an agent opened beside its own thread finish
                   loading and go on answering. The mark is how anything asking
                   "is this pane on the screen" tells the two apart, since a
                   hidden group's leaves are laid out at the same rectangles as
                   the visible one's: see `features/panes/visible.ts`. -->
              <div
                class="absolute inset-0"
                data-pane-group={group.id}
                data-pane-shown={visible ? "true" : "false"}
                style:visibility={visible ? "visible" : "hidden"}
                aria-hidden={!visible}
              >
                <PaneShell {group} {mobile} />
              </div>
            {/each}

            {#each app.threads as thread (thread.id)}
              {@const group = paneStore.groupOf(thread.id)}
              <!-- On a phone the group draws one pane at a time, so being in the
                   group on screen is no longer enough to be on the screen: the
                   terminals of the other panes are laid out at the same
                   rectangle and would stack on top of the one being read. -->
              {@const visible =
                group?.id === activeGroupId &&
                terminalActive &&
                (!mobile || group.focusedPaneId === thread.id)}
              {@const focused =
                visible && group?.focusedPaneId === thread.id}
              {@const rect = group ? paneStore.rectFor(thread.id, group, visible) : null}
              <!-- The info box is a strip across the top of this column, so the
                   terminal starts under it rather than beside it. Decided here
                   and not inside the box: the row and the inset have to be the
                   same number or output ends up under it again, which is what
                   the floating card did to the first four lines. Panes too
                   narrow for a readable row get neither. -->
              {@const stripShown = Boolean(!mobile && rect && rect.w >= 420)}
              <!-- A pilot row has no PTY, so nothing is overlaid on its
                   rectangle: its pane is a component in the tree and the shell
                   already drew it. Mounting a Terminal here is what spawns a
                   PTY, so this guard is what keeps a chat thread from starting
                   a shell nobody asked for. -->
              {#if activated[thread.id] && rect && group && thread.runtime !== "pilot"}
                <div
                  class="absolute"
                  style:left="{rect.x}px"
                  style:top="{rect.y}px"
                  style:width="{rect.w}px"
                  style:height="{rect.h}px"
                  style:visibility={visible ? "visible" : "hidden"}
                  aria-hidden={!visible}
                  onpointerdowncapture={() => focusPane(thread.id)}
                >
                  <!-- Not keyed on the relaunch nonce. It used to be, and a
                       reload therefore threw away xterm and its WebGL context
                       to build both again; the terminal relaunches in place and
                       watches the nonce itself. -->
                  <!-- Keyed on this thread's own environment, not on the
                       workspace. A PTY handle is only valid against the backend
                       instance that issued it, so the terminals that have to
                       release before a transport is disposed are exactly the
                       ones whose handles came from it: one environment's. A
                       boite going down no longer tears down the local terminals
                       it has nothing to do with. -->
                  <div
                    class="absolute inset-x-0 bottom-0"
                    style:top="{infoBoxInset(stripShown)}px"
                  >
                    {#key workspace.epochOf(thread.origin)}
                      {#if TerminalView.current}
                        {@const TerminalComp = TerminalView.current}
                        <TerminalComp {thread} {visible} {focused} />
                      {/if}
                    {/key}
                  </div>
                  <!-- A thread that lives on the dropped boite: what is typed
                       into it is going nowhere, and the pane is the only place
                       that can say so about this thread rather than about the
                       whole window. -->
                  <PaneOverlay
                    {thread}
                    {group}
                    {focused}
                    offline={boiteDown && thread.origin === "remote"}
                  />
                  <!-- One strip per terminal: in split view each pane runs its
                       own worktree, so a single row over the whole area could
                       only ever describe one of them, and a git pane opened
                       beside the terminal leaves the row spanning the terminal
                       column alone. After the pane overlay in the DOM and at
                       the same z, so it draws over the ring rather than under
                       it. -->
                  {#if stripShown && InfoBoxView.current}
                    {@const InfoBoxComp = InfoBoxView.current}
                    <InfoBoxComp {thread} {visible} {focused} />
                  {/if}
                </div>
              {/if}
            {/each}

            <PaneDropOverlay />
          </div>
        </div>

        {#if settingsActive}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            {#if SettingsView.current}
              {@const SettingsComp = SettingsView.current}
              <SettingsComp />
            {/if}
          </div>
        {/if}

        {#if app.view === "project"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            {#if ProjectView.current}
              {@const ProjectComp = ProjectView.current}
              <ProjectComp onOpenThread={activateThread} />
            {/if}
          </div>
        {/if}

        {#if homeActive}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            {#if HomeView.current}
              {@const HomeComp = HomeView.current}
              <HomeComp />
            {:else}
              <div class="flex h-full items-center justify-center text-sm text-muted-2">
                {t("common.loading")}
              </div>
            {/if}
          </div>
        {/if}

        {#if app.view === "plugins"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            {#if PluginsView.current}
              {@const PluginsComp = PluginsView.current}
              <PluginsComp />
            {:else}
              <div class="flex h-full items-center justify-center text-sm text-muted-2">
                {t("common.loading")}
              </div>
            {/if}
          </div>
        {/if}

        {#if app.view === "editor"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            {#if EditorView.current}
              {@const EditorComp = EditorView.current}
              <EditorComp />
            {:else}
              <div class="flex h-full items-center justify-center text-sm text-muted-2">
                {t("common.loading")}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Tab pages sit under the editor/settings overlays: a diff opened
             from git sets view=editor and must win over the git page. -->

        {#if mobile && app.view === "terminal" && app.mobileTab === "git"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            <GitPanel />
          </div>
        {/if}

        {#if mobile && app.view === "terminal" && app.mobileTab === "files"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            <ExplorerPanel />
          </div>
        {/if}

        <!-- No `projectId` prop: with no pane around it the page follows the
             project the bottom bar is showing, which is what the panel already
             falls back to. -->
        {#if mobile && app.view === "terminal" && app.mobileTab === "todo"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            <TodoPanel />
          </div>
        {/if}

        {#if mobile && app.mobileTab === "projects" && (app.view === "terminal" || app.view === "home")}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            <MobileProjectsPage />
          </div>
        {/if}
      {/if}
    </main>
  </div>
  {/if}
  {/key}

  {#if mobile && !workspace.needsLogin}
    <MobileBottomBar />
  {/if}

  {#if outlineClass}
    <div
      class="ws-outline {outlineClass}"
      style:--ws-color={workspace.info.color || "var(--color-success)"}
      aria-hidden="true"
    ></div>
  {/if}

  <!-- The outline is 1.5px of colour and says nothing about what to do. This
       carries the state and the retry. -->
  <ConnectionBanner />

  <!-- Over the whole window, login screen and setup wizard included: the whip
       belongs to the app rather than to a view. Cosmetic in full: it sends
       nothing to any terminal. -->
  {#if settings.state.experimentWhip && WhipView.current}
    {@const WhipComp = WhipView.current}
    <WhipComp />
  {/if}

  <!-- Over everything, because a configuration that differs is the user's to
       settle before anything else reads it. -->
  {#if syncStore.mergeOpen && SyncMergeView.current}
    {@const SyncMergeComp = SyncMergeView.current}
    <SyncMergeComp />
  {/if}
</div>

<style>
  .ws-outline {
    position: fixed;
    inset: 0;
    z-index: var(--z-outline);
    pointer-events: none;
    /* Inset shadows follow border-radius, so this rounds the connection
       outline at the corners instead of squaring off the viewport. */
    border-radius: 10px;
    transition: box-shadow 150ms ease;
  }
  :global(.mobile-mode) .ws-outline {
    border-radius: 18px;
  }
  /* A glow hugging the edges rather than a line drawn on them. The 1.5px of
     solid colour was a border the app did not have, and it read as chrome:
     something to look at instead of something to notice. A hairline at half
     strength with the light falling inward says the same thing at the edge of
     vision and disappears the moment you are reading a terminal. */
  .ws-remote-ok {
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--ws-color, var(--color-success)) 40%, transparent),
      inset 0 0 24px -8px color-mix(in srgb, var(--ws-color, var(--color-success)) 75%, transparent);
  }
  /* The unhealthy one keeps the pulse, and rather more light: this is the state
     the user has to act on. */
  .ws-remote-warn {
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--color-warning) 55%, transparent),
      inset 0 0 26px -6px color-mix(in srgb, var(--color-warning) 80%, transparent);
    animation: ws-pulse var(--dur-pulse) ease-in-out infinite;
  }
  @keyframes ws-pulse {
    50% {
      box-shadow:
        inset 0 0 0 1px color-mix(in srgb, var(--color-warning) 22%, transparent),
        inset 0 0 26px -10px color-mix(in srgb, var(--color-warning) 30%, transparent);
    }
  }
</style>
