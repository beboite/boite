<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { listen } from "@tauri-apps/api/event";
  import { invoke } from "@tauri-apps/api/core";
  import { platform as detectPlatform } from "@tauri-apps/plugin-os";
  import { hasTauri } from "$lib/backend/env";
  import { workspace } from "$lib/backend";
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { addProjectByPath } from "$lib/features/project/api";
  import { launchBlankTerminal } from "$lib/features/thread/api";
  import WorkspaceToggle from "$lib/features/workspace/WorkspaceToggle.svelte";
  import Minus from "@lucide/svelte/icons/minus";
  import Square from "@lucide/svelte/icons/square";
  import Copy from "@lucide/svelte/icons/copy";
  import X from "@lucide/svelte/icons/x";
  import Settings from "@lucide/svelte/icons/settings";
  import PanelLeft from "@lucide/svelte/icons/panel-left";
  import PanelRight from "@lucide/svelte/icons/panel-right";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import UpdateBadge from "$lib/features/updater/UpdateBadge.svelte";

  // Window controls only exist in the desktop shell. In a browser/PWA there is
  // no Tauri window object (getCurrentWindow would throw), and the OS/browser
  // draws its own chrome, so we skip the custom min/max/close buttons.
  const isTauri = hasTauri();
  const win = isTauri ? getCurrentWindow() : null;
  let isMaximized = $state(false);

  // macOS keeps its decorations and draws the real traffic lights over our bar
  // (titleBarStyle: Overlay, see tauri.macos.conf.json), so we draw no controls
  // of our own there and just leave the top-left corner free for them.
  // Read straight from the OS plugin rather than the platform store: that one
  // is filled during workspace boot, and the titlebar renders before it.
  const isMacOS = isTauri && safePlatform() === "macos";

  function safePlatform(): string | null {
    try {
      return detectPlatform();
    } catch {
      return null;
    }
  }

  // Fullscreen hides the traffic lights, so the row reclaims their 78px. The
  // backend posts the transition as it starts and hides them for the way out,
  // which is what lets the gap be back on screen before they are.
  let isFullscreen = $state(false);
  const macLightsGap = $derived(isMacOS && !isFullscreen);

  async function syncMaximized() {
    if (!win) return;
    try {
      isMaximized = await win.isMaximized();
    } catch {
      isMaximized = false;
    }
  }

  // Startup and recovery only: isFullscreen() answers once AppKit has finished
  // animating, far too late to lay out against.
  async function syncFullscreen() {
    if (!win) return;
    try {
      isFullscreen = await win.isFullscreen();
    } catch {
      isFullscreen = false;
    }
    // Whatever a missed transition may have left behind: macOS owns them except
    // on the way out of fullscreen, so anywhere else they belong visible.
    setLights(false);
  }

  function setLights(hidden: boolean) {
    if (!isMacOS) return;
    void invoke("set_traffic_lights_hidden", { hidden }).catch(() => {});
  }

  // Two frames: one for Svelte to apply the padding, one for the compositor to
  // paint it. Only then may the lights come back.
  async function showLightsOncePainted() {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    setLights(false);
  }

  onMount(() => {
    if (!win) return;
    void syncMaximized();
    const unlisten = win.onResized(() => {
      void syncMaximized();
    });
    // macOS only, and gated rather than merely inert: nothing about the gap or
    // the traffic lights exists on a platform that draws neither.
    if (!isMacOS) {
      return () => {
        void unlisten.then((fn) => fn());
      };
    }
    void syncFullscreen();
    const unlistenFs = listen<boolean>("boite://fullscreen", (e) => {
      isFullscreen = e.payload;
      if (!e.payload) void showLightsOncePainted();
    });
    return () => {
      void unlisten.then((fn) => fn());
      void unlistenFs.then((fn) => fn());
    };
  });

  function minimize() {
    void win?.minimize();
  }
  function toggleMax() {
    void win?.toggleMaximize().then(() => syncMaximized());
  }
  function close() {
    void win?.close();
  }

  function showSettings() {
    app.view = "settings";
  }

  // The boite logo doubles as a context-aware "home" button:
  //  - from the settings view it just returns to the terminal/threads view;
  //  - already in the terminal view it opens a fresh terminal at the workspace
  //    root (the "folder of folders"), creating the default workspace project
  //    the first time so a bare install can start a shell with zero folder-
  //    picking. Remote only — TauriBackend has no workspace root.
  async function goHome() {
    if (app.view === "settings") {
      app.view = "terminal";
      return;
    }
    if (workspace.mode === "local") return;
    const root = await workspace
      .backendFor("remote")
      .scope.workspaceRoot()
      .catch(() => null);
    if (!root) return;
    const project = await addProjectByPath(
      root,
      workspace.isDynamic ? "remote" : undefined,
    );
    if (project) await launchBlankTerminal(project.id);
  }
</script>

<div
  data-tauri-drag-region
  class="relative flex h-9 shrink-0 select-none items-center border-b border-border bg-[var(--color-titlebar)]"
>
  <!-- 78px clears the traffic lights; they sit outside the DOM, so nothing but
       padding can keep the logo from landing under them. -->
  <div class="flex items-center gap-0.5 {macLightsGap ? 'pl-[78px]' : 'pl-1.5'}">
    <button
      type="button"
      class="flex h-7 items-center justify-center rounded-md px-2 transition {app.view ===
      'terminal'
        ? 'bg-accent text-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
      onclick={goHome}
      title="Boite — workspace"
      aria-label="Boite — go to workspace"
    >
      <BoiteLogo size={17} />
    </button>
    <button
      type="button"
      class="flex h-7 items-center justify-center rounded-md px-2 transition {app.view ===
      'settings'
        ? 'bg-accent text-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
      onclick={showSettings}
      title="Settings (Ctrl+,)"
      aria-label="Settings"
    >
      <Settings class="size-[15px]" />
    </button>
    <button
      type="button"
      class="flex h-7 items-center justify-center rounded-md px-2 transition {!settings.state
        .sidebarCollapsed
        ? 'bg-accent text-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
      onclick={() => settings.toggleSidebar()}
      title={settings.state.sidebarCollapsed ? "Show sidebar (Ctrl+B)" : "Hide sidebar (Ctrl+B)"}
      aria-label="Toggle sidebar"
      aria-pressed={!settings.state.sidebarCollapsed}
    >
      <PanelLeft class="size-[15px]" />
    </button>
    <span class="ml-1.5 hidden text-[11px] text-muted-foreground/70 md:inline">
      {app.threads.length} thread{app.threads.length === 1 ? "" : "s"} in
      {app.projects.length} project{app.projects.length === 1 ? "" : "s"}
    </span>
  </div>

  <div
    class="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center"
  >
    <WorkspaceToggle />
  </div>

  <div data-tauri-drag-region class="flex-1"></div>

  <div class="flex items-center gap-1.5 pr-1.5">
    <UpdateBadge />
    <button
      type="button"
      class="flex h-7 items-center justify-center rounded-md px-2 transition {settings.state
        .rightPanel !== null
        ? 'bg-accent text-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
      onclick={() => settings.togglePanelRight()}
      title={settings.state.rightPanel !== null ? "Hide side panel" : "Show side panel"}
      aria-label="Toggle side panel"
      aria-pressed={settings.state.rightPanel !== null}
    >
      <PanelRight class="size-[15px]" />
    </button>
  </div>

  {#if isTauri && !isMacOS}
    <div class="flex h-full items-stretch">
      <button
        type="button"
        class="flex h-full w-11 items-center justify-center text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
        onclick={minimize}
        aria-label="Minimize"
        title="Minimize"
      >
        <Minus class="size-3.5" />
      </button>
      <button
        type="button"
        class="flex h-full w-11 items-center justify-center text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
        onclick={toggleMax}
        aria-label={isMaximized ? "Restore" : "Maximize"}
        title={isMaximized ? "Restore" : "Maximize"}
      >
        {#if isMaximized}
          <Copy class="size-3" />
        {:else}
          <Square class="size-3" />
        {/if}
      </button>
      <button
        type="button"
        class="flex h-full w-11 items-center justify-center text-muted-foreground transition hover:bg-danger hover:text-white"
        onclick={close}
        aria-label="Close"
        title="Close"
      >
        <X class="size-3.5" />
      </button>
    </div>
  {/if}
</div>
