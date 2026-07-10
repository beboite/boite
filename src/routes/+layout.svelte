<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { app } from "$lib/app/store.svelte";
  import { hasTauri } from "$lib/backend/env";
  import { bootRemoteWorkspace } from "$lib/app/workspace";
  import { reinspectMissingIcons } from "$lib/features/project/api";
  import { settings } from "$lib/features/settings/store.svelte";
  import { applyMotionPreference } from "$lib/theme/motion";
  import {
    closeThreadWithConfirm,
    launchBlankTerminal,
    restoreLastClosedThread,
  } from "$lib/features/thread/api";
  import { addProjectByPath } from "$lib/features/project/api";
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { paneStore, leavesOf } from "$lib/features/panes/store.svelte";
  import { palette } from "$lib/features/palette/store.svelte";
  import CommandPalette from "$lib/features/palette/CommandPalette.svelte";

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

  function isTextInput(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return true;
    return false;
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

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (isModalOpen()) return;
      if (app.view === "settings" || app.view === "editor") {
        e.preventDefault();
        app.view = "terminal";
      }
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    // UI zoom
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      settings.setUiScalePercent(settings.state.uiScalePercent + 5);
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      settings.setUiScalePercent(settings.state.uiScalePercent - 5);
      return;
    }
    if (e.key === "0") {
      e.preventDefault();
      settings.setUiScalePercent(100);
      return;
    }

    // Command palette (Ctrl+K, or VS Code-style Ctrl+Shift+P)
    if (
      ((e.key === "k" || e.key === "K") && !e.shiftKey && !e.altKey) ||
      ((e.key === "p" || e.key === "P") && e.shiftKey && !e.altKey)
    ) {
      e.preventDefault();
      palette.toggle();
      return;
    }

    // Sidebar toggle
    if ((e.key === "b" || e.key === "B") && !e.altKey) {
      e.preventDefault();
      settings.toggleSidebar();
      return;
    }

    // Settings
    if (e.key === ",") {
      e.preventDefault();
      app.view = app.view === "settings" ? "terminal" : "settings";
      return;
    }

    // Cycle threads. Never override Tab inside text inputs.
    if (e.key === "Tab" && !isTextInput(e.target)) {
      e.preventDefault();
      cycleThread(e.shiftKey ? -1 : 1);
      return;
    }

    // Cycle pane within active group (Ctrl+Alt+Arrow)
    if (
      e.altKey &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight" ||
        e.key === "ArrowUp" || e.key === "ArrowDown")
    ) {
      const id = app.activeThreadId;
      if (!id) return;
      const g = paneStore.groupOf(id);
      if (!g) return;
      const leaves = leavesOf(g.root);
      if (leaves.length < 2) return;
      e.preventDefault();
      const idx = leaves.indexOf(id);
      const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      const next = leaves[(idx + dir + leaves.length) % leaves.length];
      app.activeThreadId = next;
      return;
    }

    // Restore last closed thread
    if ((e.key === "t" || e.key === "T") && e.shiftKey && !e.altKey) {
      e.preventDefault();
      void restoreLastClosedThread();
      return;
    }

    // New blank terminal in current project
    if ((e.key === "t" || e.key === "T") && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void launchBlankTerminal(app.currentProjectId);
      return;
    }

    // Close what's in front: editor tab in editor view, settings view, or
    // the active thread (honoring the confirm-before-close setting).
    if ((e.key === "w" || e.key === "W") && !e.shiftKey && !e.altKey) {
      if (app.view === "editor") {
        e.preventDefault();
        const active = editorStore.activeId;
        if (active) {
          void editorStore.close(active).then((closed) => {
            if (closed && editorStore.buffers.length === 0) {
              app.view = "terminal";
            }
          });
        } else {
          app.view = "terminal";
        }
        return;
      }
      if (app.view === "settings") {
        e.preventDefault();
        app.view = "terminal";
        return;
      }
      if (!app.activeThreadId) return;
      e.preventDefault();
      void closeThreadWithConfirm(app.activeThreadId);
      return;
    }

    // Jump to thread N (1-9) in current project
    if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      jumpToThreadN(Number(e.key));
      return;
    }
  }

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

    void app.init().then(() => reinspectMissingIcons().catch(() => {}));

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

    return () => {
      unlisten?.();
    };
  });
</script>

<svelte:window onwheel={handleWheel} onkeydown={handleKeydown} />

{@render children()}

<CommandPalette />
