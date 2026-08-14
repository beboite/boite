<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { app } from "$lib/app/store.svelte";
  import { hasTauri } from "$lib/backend/env";
  import { workspace } from "$lib/backend";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { bootDesktopWorkspace, bootRemoteWorkspace } from "$lib/app/workspace";
  import { reinspectMissingIcons } from "$lib/features/project/api";
  import { settings } from "$lib/features/settings/store.svelte";
  import { applyMotionPreference } from "$lib/theme/motion";
  import {
    closeThreadWithConfirm,
    launchBlankTerminalHere,
    restoreLastClosedThread,
  } from "$lib/features/thread/api";
  import { addProjectByPath } from "$lib/features/project/api";
  import { watchAgentRequests } from "$lib/app/agent-requests";
  import { watchAgentActivity } from "$lib/features/thread/agentActivity.svelte";
  import { watchScreen } from "$lib/app/screen.svelte";
  import { installInspector } from "$lib/features/devtools/inspect";
  import { captureWindowErrors } from "$lib/shared/services/logger.svelte";
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { paneStore, threadLeavesOf } from "$lib/features/panes/store.svelte";
  import { splitFocused } from "$lib/features/panes/open";
  import { palette } from "$lib/features/palette/store.svelte";
  import { isDeviceMacOS, platform } from "$lib/storage/platform.svelte";
  import { updater } from "$lib/features/updater/store.svelte";
  import { resumeAfterUpdate } from "$lib/features/updater/restart";
  import { todos } from "$lib/features/todo/store.svelte";
  import { approvals } from "$lib/features/approvals/store.svelte";
  import ApprovalDock from "$lib/features/approvals/ApprovalDock.svelte";
  import CommandPalette from "$lib/features/palette/CommandPalette.svelte";
  import { createKeyboardController } from "$lib/shared/keyboard/controller";
  import { jumpModifier } from "$lib/shared/keyboard/held.svelte";
  import { isEditableTarget } from "$lib/shared/keyboard/combo";
  import { keybindings } from "$lib/features/settings/keybindings.svelte";
  import type { KeyCommandRun, KeyContext } from "$lib/shared/keyboard/types";

  let { children } = $props();

  $effect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.fontSize = `${settings.state.uiScalePercent}%`;
  });

  $effect(() => {
    if (typeof document === "undefined") return;
    return applyMotionPreference(settings.state.motionMode);
  });

  function handleWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -5 : 5;
    settings.setUiScalePercent(settings.state.uiScalePercent + delta);
  }

  function cycleThread(direction: 1 | -1) {
    // Walk in sidebar order (project order, then per-project thread order)
    // so Ctrl+Tab matches what the user sees, not creation order.
    const list = app.sortedProjects.flatMap((p) => app.threadsByProjectSorted(p.id));
    if (list.length === 0) return;
    const idx = list.findIndex((t) => t.id === app.activeThreadId);
    const next = idx < 0 ? 0 : (idx + direction + list.length) % list.length;
    app.activeThreadId = list[next].id;
    app.selectedProjectId = list[next].projectId;
    app.view = "terminal";
  }

  function jumpToThreadN(n: number) {
    const projectId = app.currentProjectId;
    if (!projectId) return;
    const inProject = app.threadsByProjectSorted(projectId);
    const target = inProject[n - 1];
    if (!target) return;
    app.activeThreadId = target.id;
    app.view = "terminal";
  }

  function isModalOpen(): boolean {
    if (typeof document === "undefined") return false;
    return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
  }

  function cyclePaneInGroup(direction: 1 | -1): boolean {
    const id = app.activeThreadId;
    if (!id) return false;
    const g = paneStore.groupOf(id);
    if (!g) return false;
    // Threads only: Ctrl+Tab moves the active THREAD, and a git or browser
    // pane in the same group is not something activeThreadId can hold.
    const leaves = threadLeavesOf(g.root);
    if (leaves.length < 2) return false;
    const idx = leaves.indexOf(id);
    app.activeThreadId = leaves[(idx + direction + leaves.length) % leaves.length];
    return true;
  }

  function closeFrontMost(): boolean {
    if (app.view === "editor") {
      const active = editorStore.activeId;
      if (!active) {
        app.view = "terminal";
        return true;
      }
      void editorStore.close(active).then((closed) => {
        if (closed && editorStore.buffers.length === 0) app.view = "terminal";
      });
      return true;
    }
    if (app.view === "settings" || app.view === "project") {
      app.view = "terminal";
      return true;
    }
    if (!app.activeThreadId) return false;
    void closeThreadWithConfirm(app.activeThreadId);
    return true;
  }

  // What a rule's `when` clause is asking about. Read only once a combo has
  // already matched, which is what keeps the DOM probe off the hot path.
  //
  // The palette is excluded from `modalOpen` even though it is also a
  // role="dialog": it is a layer we model, so it keeps its own keys and Ctrl+K
  // can close what Ctrl+K opened. The probe is the fallback for the dialogs we
  // do not model, like the confirm prompt.
  function keyboardContext(): KeyContext {
    const paletteOpen = palette.open;
    const modalOpen = !paletteOpen && isModalOpen();
    return {
      paletteOpen,
      modalOpen,
      overlayOpen: paletteOpen || modalOpen,
      terminalFocus: app.view === "terminal",
      settingsOpen: app.view === "settings",
      editorFocus: app.view === "editor",
      projectFocus: app.view === "project",
      inputFocus:
        typeof document !== "undefined" && isEditableTarget(document.activeElement),
      hasThread: app.activeThreadId !== null,
    };
  }

  // A rule names a command; this is where a command names behaviour. The two
  // are apart because a rule crosses a socket and a database, so nothing on it
  // can be a function.
  //
  // Splitting lands on the project overview because there is no obvious second
  // thing to show; the palette's Panes section picks a specific one, and
  // dragging a sidebar row onto a live terminal still does the arbitrary case.
  const handlers: Record<string, KeyCommandRun> = {
    "view.backToTerminal": () => {
      app.view = "terminal";
    },
    "view.zoomIn": () => settings.setUiScalePercent(settings.state.uiScalePercent + 5),
    "view.zoomOut": () => settings.setUiScalePercent(settings.state.uiScalePercent - 5),
    "view.zoomReset": () => settings.setUiScalePercent(100),
    "palette.toggle": () => palette.toggle(),
    "view.toggleSidebar": () => settings.toggleSidebar(),
    "view.toggleSettings": () => {
      app.view = app.view === "settings" ? "terminal" : "settings";
    },
    "view.closeFrontMost": () => closeFrontMost(),
    "thread.next": () => cycleThread(1),
    "thread.previous": () => cycleThread(-1),
    "thread.new": () => void launchBlankTerminalHere(),
    "thread.restoreClosed": () => void restoreLastClosedThread(),
    "pane.splitRight": () => {
      splitFocused("right");
    },
    "pane.splitDown": () => {
      splitFocused("bottom");
    },
    "pane.next": () => cyclePaneInGroup(1),
    "pane.previous": () => cyclePaneInGroup(-1),
    ...Object.fromEntries(
      ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => [
        `thread.jump${n}`,
        () => jumpToThreadN(n),
      ]),
    ),
  };

  const keyboard = createKeyboardController({
    rules: () => keybindings.rules,
    context: keyboardContext,
    handlers: () => handlers,
    // The keyboard under the user's hands, never the boite's. This read is why
    // the two are named apart: it was `platform.isMacOS` and a Mac driving a
    // Linux boite lost Cmd for every binding in the app.
    isMac: () => isDeviceMacOS,
    suspended: () => keybindings.recording !== null,
  });

  // Its own onMount: the boot one below returns early on the PWA path, and
  // shortcuts have to work there too.
  onMount(() => keyboard.attach());

  // What lights the position numbers in the sidebar while the jump modifier is
  // down. Beside the dispatcher because it is the same keyboard, and separate
  // from it because a binding fires on a chord while this has to know about a
  // modifier held on its own.
  onMount(() => jumpModifier.watch());

  // The layout guess is only a guess until the user overrides it, and a tablet
  // can cross the threshold by being rotated.
  onMount(() => settings.watchFormFactor());

  // Also its own: an agent can ask to be moved before boot has finished, and
  // the request would land on nobody.
  onMount(() => watchAgentRequests());

  // The pulse that says an agent reached into Boite itself rather than into its
  // own terminal. Mounted here for the same reason: the first call can land
  // during boot, and a mark laid on nobody is a mark nothing shows.
  onMount(() => watchAgentActivity());

  // The window saying what is on it, so an agent debugging this app stops
  // having to ask a human what they see. It lands in workspace_snapshot; see
  // `boite_core::screen`.
  onMount(() => watchScreen());

  // Development builds only, and the one thing that makes this app inspectable
  // from the MCP bridge: the terminals render to a canvas, so their output is
  // invisible to anything that reads the DOM.
  onMount(() => installInspector());

  // Before anything else has a chance to throw. What the window raises on its
  // own reached the devtools console and stopped there, which on a packaged
  // desktop app is nowhere at all.
  captureWindowErrors();

  onMount(() => {
    // No Tauri runtime: this is a browser/PWA. The only backend is the server
    // that served the page; connect to it (or raise the login gate) instead of
    // initializing a dead local workspace.
    if (!hasTauri()) {
      void bootRemoteWorkspace().then(() => reinspectMissingIcons().catch(() => {}));
      // Register the PWA service worker (installability + offline shell). Only
      // works in a secure context (HTTPS or localhost); a no-op otherwise.
      if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        void navigator.serviceWorker.register("/service-worker.js").catch(() => {});
      }
      // Both watches belong on this path too, and neither was here. The dock is
      // mounted below on every platform, so a phone drew it and nothing ever
      // fed it: an agent's permission request reached no device that could
      // answer, and a todo an agent wrote never refreshed the panel. Both
      // arrive as control events on the boite socket, which is the only backend
      // there is here.
      const stopPwaTodoWatch = todos.watch();
      const stopPwaApprovalWatch = approvals.watch();
      void approvals.reload();
      return () => {
        stopPwaTodoWatch();
        stopPwaApprovalWatch();
      };
    }

    void bootDesktopWorkspace().then(() => {
      // Threads are loaded now, so a resume plan left by an update can be
      // matched against them and its threads brought back up.
      resumeAfterUpdate();
      reinspectMissingIcons().catch(() => {});
    });

    // Wait one rAF after mount so the first paint hits the GPU before the
    // window becomes visible. Avoids the white flash on launch.
    // Under software-rendered webkit2gtk (some Linux configs) rAF can stall
    // for several seconds; the timeout is a frontend-side fallback so the
    // window does not depend on the slower 8s Rust failsafe.
    let booted = false;
    const finishBoot = () => {
      if (booted) return;
      booted = true;
      void invoke("finish_boot").catch(() => {});
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(() => finishBoot());
    });
    setTimeout(finishBoot, 1500);

    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths ?? [];
        // The webview drops paths off this machine's file manager, always. Sent
        // with no origin they went to `current()`, so a folder dragged in while
        // a boite was active was inspected on the server: a "not a folder" toast
        // for a folder in plain sight, or a project silently pointed at a
        // same-named directory over there.
        if (workspace.isRemote) {
          notifications.error(t("project.dropIsOnThisMachine"));
          return;
        }
        for (const p of paths) {
          await addProjectByPath(p, workspace.isDynamic ? "local" : undefined);
        }
      })
      .then((u) => (unlisten = u));

    // Polls quietly and pre-downloads; the titlebar only speaks up once a
    // release is on disk and a restart is all that is left.
    const stopUpdater = updater.start();
    const stopTodoWatch = todos.watch();
    // Read once at boot as well as on notice: a request opened while the app
    // was closed is still waiting, and nothing will announce it again.
    const stopApprovalWatch = approvals.watch();
    void approvals.reload();

    return () => {
      unlisten?.();
      stopUpdater();
      stopTodoWatch();
      stopApprovalWatch();
    };
  });
</script>

<svelte:window onwheel={handleWheel} />

{@render children()}

<ApprovalDock />

<CommandPalette />
