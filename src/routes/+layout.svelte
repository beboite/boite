<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { app } from "$lib/app/store.svelte";
  import { hasTauri } from "$lib/backend/env";
  import { bootDesktopWorkspace, bootRemoteWorkspace } from "$lib/app/workspace";
  import { reinspectMissingIcons } from "$lib/features/project/api";
  import { settings } from "$lib/features/settings/store.svelte";
  import { applyMotionPreference } from "$lib/theme/motion";
  import {
    closeThreadWithConfirm,
    launchBlankTerminal,
    restoreLastClosedThread,
  } from "$lib/features/thread/api";
  import { addProjectByPath } from "$lib/features/project/api";
  import { watchAgentRequests } from "$lib/features/thread/agentRequests";
  import { installInspector } from "$lib/features/devtools/inspect";
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { paneStore, leavesOf } from "$lib/features/panes/store.svelte";
  import { palette } from "$lib/features/palette/store.svelte";
  import { platform } from "$lib/storage/platform.svelte";
  import { updater } from "$lib/features/updater/store.svelte";
  import { resumeAfterUpdate } from "$lib/features/updater/restart";
  import { todos } from "$lib/features/todo/store.svelte";
  import { chats } from "$lib/features/chat/store.svelte";
  import CommandPalette from "$lib/features/palette/CommandPalette.svelte";
  import { createKeyboardController } from "$lib/shared/keyboard/controller";
  import type { KeyScope, ShortcutBinding } from "$lib/shared/keyboard/types";

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
    const leaves = leavesOf(g.root);
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
    if (app.view === "settings") {
      app.view = "terminal";
      return true;
    }
    if (!app.activeThreadId) return false;
    void closeThreadWithConfirm(app.activeThreadId);
    return true;
  }

  // Resolved top-down: the front-most layer wins. `modal` owns the keyboard
  // outright, which is what stops Escape from closing the dialog and the panel
  // behind it in the same keystroke.
  //
  // The palette is checked first even though it is also a role="dialog": it is
  // a layer we model, so it keeps its own bindings (Ctrl+K has to close what
  // Ctrl+K opened). The DOM probe below is the fallback for the dialogs we do
  // not model, like the confirm prompt.
  function currentScope(): KeyScope {
    if (palette.open) return "palette";
    if (isModalOpen()) return "modal";
    if (app.view === "settings") return "settings";
    if (app.view === "editor") return "editor";
    return "app";
  }

  const shortcuts: ShortcutBinding[] = [
    {
      combo: "escape",
      scopes: ["settings", "editor"],
      description: "Back to the terminal",
      run: () => {
        app.view = "terminal";
      },
    },
    {
      combo: "mod+plus",
      scopes: ["*"],
      description: "Zoom in",
      run: () => settings.setUiScalePercent(settings.state.uiScalePercent + 5),
    },
    {
      combo: "mod+minus",
      scopes: ["*"],
      description: "Zoom out",
      run: () => settings.setUiScalePercent(settings.state.uiScalePercent - 5),
    },
    {
      combo: "mod+digit0",
      scopes: ["*"],
      description: "Reset zoom",
      run: () => settings.setUiScalePercent(100),
    },
    // On macOS this is Cmd+K only: Ctrl+K is readline's kill-line and the
    // shell needs it. The dispatcher drops a match with a stray Ctrl there.
    {
      combo: "mod+k",
      scopes: ["app", "settings", "editor", "palette"],
      description: "Command palette",
      run: () => palette.toggle(),
    },
    {
      combo: "mod+shift+p",
      scopes: ["app", "settings", "editor", "palette"],
      description: "Command palette",
      run: () => palette.toggle(),
    },
    {
      combo: "mod+b",
      scopes: ["*"],
      description: "Toggle sidebar",
      run: () => settings.toggleSidebar(),
    },
    {
      combo: "mod+,",
      scopes: ["app", "settings", "editor"],
      description: "Settings",
      run: () => {
        app.view = app.view === "settings" ? "terminal" : "settings";
      },
    },
    {
      combo: "mod+tab",
      scopes: ["app", "settings", "editor"],
      description: "Next thread",
      run: () => cycleThread(1),
    },
    {
      combo: "mod+shift+tab",
      scopes: ["app", "settings", "editor"],
      description: "Previous thread",
      run: () => cycleThread(-1),
    },
    {
      combo: "mod+alt+arrowright",
      scopes: ["app"],
      description: "Next pane",
      run: () => cyclePaneInGroup(1),
    },
    {
      combo: "mod+alt+arrowdown",
      scopes: ["app"],
      run: () => cyclePaneInGroup(1),
    },
    {
      combo: "mod+alt+arrowleft",
      scopes: ["app"],
      description: "Previous pane",
      run: () => cyclePaneInGroup(-1),
    },
    {
      combo: "mod+alt+arrowup",
      scopes: ["app"],
      run: () => cyclePaneInGroup(-1),
    },
    {
      combo: "mod+shift+t",
      scopes: ["app", "settings", "editor"],
      description: "Reopen the last closed thread",
      run: () => void restoreLastClosedThread(),
    },
    {
      combo: "mod+t",
      scopes: ["app", "settings", "editor"],
      description: "New terminal",
      run: () => void launchBlankTerminal(app.currentProjectId),
    },
    {
      combo: "mod+w",
      scopes: ["app", "settings", "editor"],
      description: "Close the front-most tab, panel or thread",
      run: () => closeFrontMost(),
    },
    ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => ({
      combo: `mod+digit${n}`,
      scopes: ["app", "settings", "editor"] as KeyScope[],
      description: n === 1 ? "Jump to thread 1-9 in this project" : undefined,
      run: () => jumpToThreadN(n),
    })),
  ];

  const keyboard = createKeyboardController({
    bindings: shortcuts,
    getScope: currentScope,
    isMac: () => platform.isMacOS,
  });

  // Its own onMount: the boot one below returns early on the PWA path, and
  // shortcuts have to work there too.
  onMount(() => keyboard.attach());

  // Also its own: an agent can ask to be moved before boot has finished, and
  // the request would land on nobody.
  onMount(() => watchAgentRequests());

  // Development builds only, and the one thing that makes this app inspectable
  // from the MCP bridge: the terminals render to a canvas, so their output is
  // invisible to anything that reads the DOM.
  onMount(() => installInspector());

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
      return;
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
        for (const p of paths) {
          await addProjectByPath(p);
        }
      })
      .then((u) => (unlisten = u));

    // Polls quietly and pre-downloads; the titlebar only speaks up once a
    // release is on disk and a restart is all that is left.
    const stopUpdater = updater.start();
    const stopTodoWatch = todos.watch();
    // The list itself is loaded by `app.init`, which also runs on a workspace
    // switch. Only the watcher belongs here: it outlives every switch, since
    // the event it listens for comes from the desktop's own endpoint.
    const stopChatWatch = chats.watch();

    return () => {
      unlisten?.();
      stopUpdater();
      stopTodoWatch();
      stopChatWatch();
    };
  });
</script>

<svelte:window onwheel={handleWheel} />

{@render children()}

<CommandPalette />
