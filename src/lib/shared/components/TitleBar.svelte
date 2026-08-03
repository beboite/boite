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
  import { t } from "$lib/i18n/index.svelte";
  import WorkspaceToggle from "$lib/features/workspace/WorkspaceToggle.svelte";
  import Minus from "@lucide/svelte/icons/minus";
  import Square from "@lucide/svelte/icons/square";
  import Copy from "@lucide/svelte/icons/copy";
  import X from "@lucide/svelte/icons/x";
  import Settings from "@lucide/svelte/icons/settings";
  import PanelLeft from "@lucide/svelte/icons/panel-left";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import UpdateBadge from "$lib/features/updater/UpdateBadge.svelte";
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
  import {
    closePanelPane,
    openPane,
    panePresence,
    type PanelKind,
  } from "$lib/features/panes/open";
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { revealEditor } from "$lib/features/editor/reveal";
  import FileCode from "@lucide/svelte/icons/file-code";
  import type { MessageKey } from "$lib/i18n/messages";
  import {
    mcpPulse,
    type McpSurface,
  } from "$lib/features/thread/agentActivity.svelte";

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

  /**
   * The side panels, which are panes now rather than one fixed column.
   *
   * One button each, because the rail they replaced was three tabs and hiding
   * two of them behind a right-click on the third is how the file explorer
   * stopped being findable. The rail's own width is gone all the same: a panel
   * is a pane, so it can be moved, resized and put below a terminal.
   */
  const PANEL_BUTTONS: {
    kind: PanelKind;
    key: MessageKey;
    icon: typeof GitBranch;
    /** Which agent surface flashes this button, for the panels an agent can
        change from the outside. The explorer has none: nothing in the MCP writes
        files. */
    surface?: McpSurface;
  }[] = [
    { kind: "git", key: "panes.kindGit", icon: GitBranch, surface: "worktree" },
    { kind: "explorer", key: "panes.kindExplorer", icon: FolderTree },
    { kind: "todo", key: "panes.kindTodo", icon: ListTodo, surface: "todo" },
  ];

  let panelMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(
    null,
  );

  /**
   * One button per panel, answering "is this on screen anywhere".
   *
   * A panel normally lives in the docked column, but it can be detached into a
   * pane, and the button has to mean the same thing either way — otherwise the
   * one panel you detached is the one whose button lies. So: lit when it is up
   * in either place, and a click puts it away wherever it is.
   */
  function panelShowing(kind: PanelKind): boolean {
    return (
      settings.rightPanelFor(app.currentProjectId) === kind ||
      panePresence(kind) !== null
    );
  }

  function togglePanel(kind: PanelKind) {
    if (closePanelPane(kind)) return;
    settings.toggleRightPanel(app.currentProjectId, kind);
  }

  /**
   * The way back to open files.
   *
   * The editor takes the whole main area and puts its tab strip where the agent
   * shortcuts normally are, so leaving it for a terminal took the tabs off
   * screen with it — and nothing anywhere said those buffers were still open.
   * It was a one-way door: the only path back was to open a file again.
   *
   * Shown only while something is open, which is what keeps it from being a
   * fourth permanent button for a view most sessions never use.
   */
  // Scoped to the project on screen, like the strip itself: a count that added
  // up three projects' files pointed at a view that would only show one of
  // them.
  const openHere = $derived(editorStore.forProject(app.currentProjectId).length);
  const editorOpen = $derived(openHere > 0);
  const editorShowing = $derived(
    app.view === "editor" || panePresence("editor") !== null,
  );

  function toggleEditor() {
    if (app.view === "editor") {
      app.view = "terminal";
      return;
    }
    revealEditor();
  }

  // The two panes with nowhere else to be opened from by pointer. Both are
  // ordinary panes rather than panels: they hold a document, not a view of the
  // project, so neither belongs in the row above.
  function openPanelMenu(e: MouseEvent) {
    e.preventDefault();
    panelMenu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: t("panes.openDashboard"),
          action: () => {
            openPane({ kind: "dashboard" });
          },
        },
        {
          label: t("panes.openEditor"),
          action: () => {
            openPane({ kind: "editor" });
          },
        },
      ],
    };
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
      title={t("titlebar.workspaceTooltip")}
      aria-label={t("titlebar.workspaceLabel")}
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
      title={t("titlebar.settingsTooltip")}
      aria-label={t("common.settings")}
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
      title={settings.state.sidebarCollapsed
        ? t("titlebar.showSidebar")
        : t("titlebar.hideSidebar")}
      aria-label={t("titlebar.toggleSidebar")}
      aria-pressed={!settings.state.sidebarCollapsed}
    >
      <PanelLeft class="size-[15px]" />
    </button>
    <span class="ml-1.5 hidden text-xs text-muted-foreground/70 md:inline">
      {t("titlebar.status", {
        threadsCount: app.threads.length,
        threadsLabel: t(
          app.threads.length === 1 ? "titlebar.threadSingle" : "titlebar.threadPlural",
        ),
        projectsCount: app.projects.length,
        projectsLabel: t(
          app.projects.length === 1 ? "titlebar.projectSingle" : "titlebar.projectPlural",
        ),
      })}
    </span>
  </div>

    <div
      class="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center"
    >
      <WorkspaceToggle />
    </div>

  <div data-tauri-drag-region class="flex-1"></div>

  <div class="flex items-center gap-0.5 pr-1.5">
    <UpdateBadge />
    {#if editorOpen}
      <button
        type="button"
        class="flex h-7 items-center justify-center gap-1 rounded-md px-2 transition {editorShowing
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
        onclick={toggleEditor}
        title={t("titlebar.editor", { count: openHere })}
        aria-label={t("titlebar.editor", { count: openHere })}
        aria-pressed={editorShowing}
      >
        <FileCode class="size-[15px]" />
        <span class="text-[11px] tabular-nums">{openHere}</span>
      </button>
    {/if}
    {#each PANEL_BUTTONS as panel (panel.kind)}
      {@const open = panelShowing(panel.kind)}
      {@const Icon = panel.icon}
      {@const pulsing = panel.surface !== undefined && mcpPulse.surface(panel.surface)}
      <button
        type="button"
        class="flex h-7 items-center justify-center rounded-md px-2 transition {open
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
        class:mcp-touch={pulsing}
        onclick={() => togglePanel(panel.kind)}
        oncontextmenu={openPanelMenu}
        title={t(panel.key)}
        aria-label={t(panel.key)}
        aria-pressed={open}
      >
        <Icon class="size-[15px]" />
      </button>
    {/each}
  </div>

  {#if isTauri && !isMacOS}
    <div class="flex h-full items-stretch">
      <button
        type="button"
        class="flex h-full w-11 items-center justify-center text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={minimize}
        aria-label={t("titlebar.minimize")}
        title={t("titlebar.minimize")}
      >
        <Minus class="size-3.5" />
      </button>
      <button
        type="button"
        class="flex h-full w-11 items-center justify-center text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={toggleMax}
        aria-label={isMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
        title={isMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
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
        aria-label={t("titlebar.close")}
        title={t("titlebar.close")}
      >
        <X class="size-3.5" />
      </button>
    </div>
  {/if}
</div>

{#if panelMenu}
  <ContextMenu
    items={panelMenu.items}
    x={panelMenu.x}
    y={panelMenu.y}
    onClose={() => (panelMenu = null)}
  />
{/if}

<style>
  /* An agent just changed this panel's contents through the MCP. The pane
     headers used to carry this flash; they are gone, so the button that opens
     the panel wears it instead, which is the only thing on screen that stands
     for a panel whether or not it is open. */
  .mcp-touch {
    animation: boite-mcp-pulse 1.6s var(--ease-out-quint) forwards;
  }
</style>
