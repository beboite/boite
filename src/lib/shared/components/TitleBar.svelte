<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { hasTauri } from "$lib/backend/env";
  import { backend, workspace } from "$lib/backend";
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { i18n } from "$lib/i18n/index.svelte";
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

  // Window controls only exist in the desktop shell. In a browser/PWA there is
  // no Tauri window object (getCurrentWindow would throw), and the OS/browser
  // draws its own chrome, so we skip the custom min/max/close buttons.
  const isTauri = hasTauri();
  const win = isTauri ? getCurrentWindow() : null;
  let isMaximized = $state(false);

  async function syncMaximized() {
    if (!win) return;
    try {
      isMaximized = await win.isMaximized();
    } catch {
      isMaximized = false;
    }
  }

  onMount(() => {
    if (!win) return;
    void syncMaximized();
    const unlisten = win.onResized(() => {
      void syncMaximized();
    });
    return () => {
      void unlisten.then((fn) => fn());
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
    const root = await backend().scope.workspaceRoot().catch(() => null);
    if (!root) return;
    const project = await addProjectByPath(root);
    if (project) await launchBlankTerminal(project.id);
  }
</script>

<div
  data-tauri-drag-region
  class="relative flex h-9 shrink-0 select-none items-center border-b border-border bg-[var(--color-titlebar)]"
>
  {#if settings.state.setupCompleted}
    <div class="flex items-center gap-0.5 pl-1.5">
      <button
        type="button"
        class="flex h-7 items-center justify-center rounded-md px-2 transition {app.view ===
        'terminal'
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
        onclick={goHome}
        title={i18n.t("titlebar.workspace_tooltip")}
        aria-label={i18n.t("titlebar.workspace_label")}
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
        title={i18n.t("titlebar.settings_tooltip")}
        aria-label={i18n.t("common.settings")}
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
        title={settings.state.sidebarCollapsed ? i18n.t("titlebar.show_sidebar") : i18n.t("titlebar.hide_sidebar")}
        aria-label={i18n.t("sidebar.toggle_sidebar")}
        aria-pressed={!settings.state.sidebarCollapsed}
      >
        <PanelLeft class="size-[15px]" />
      </button>
      <span class="ml-1.5 hidden text-[11px] text-muted-foreground/70 md:inline">
        {i18n.t("titlebar.status", {
          threadsCount: app.threads.length,
          threadsLabel: i18n.t(app.threads.length === 1 ? "titlebar.thread_single" : "titlebar.thread_plural"),
          projectsCount: app.projects.length,
          projectsLabel: i18n.t(app.projects.length === 1 ? "titlebar.project_single" : "titlebar.project_plural")
        })}
      </span>
    </div>

    <div
      class="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center"
    >
      <WorkspaceToggle />
    </div>
  {/if}

  <div data-tauri-drag-region class="flex-1"></div>

  {#if settings.state.setupCompleted}
    <div class="flex items-center gap-0.5 pr-1.5">
      <button
        type="button"
        class="flex h-7 items-center justify-center rounded-md px-2 transition {settings.state
          .rightPanel !== null
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
        onclick={() => settings.togglePanelRight()}
        title={settings.state.rightPanel !== null ? i18n.t("titlebar.hide_side_panel") : i18n.t("titlebar.show_side_panel")}
        aria-label={i18n.t("titlebar.show_side_panel")}
        aria-pressed={settings.state.rightPanel !== null}
      >
        <PanelRight class="size-[15px]" />
      </button>
    </div>
  {/if}

  {#if isTauri}
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
