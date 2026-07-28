<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { workspace } from "$lib/backend";
  import { settings } from "$lib/features/settings/store.svelte";
  import { pickAndAddProject } from "$lib/features/project/api";
  import { ptyKill } from "$lib/storage/pty";
  import { reloadThread } from "$lib/features/thread/api";
  import TitleBar from "$lib/shared/components/TitleBar.svelte";
  import CloseGuard from "$lib/app/CloseGuard.svelte";
  import ProjectSidebar from "$lib/features/project/ProjectSidebar.svelte";
  import ShortcutBar from "$lib/features/shortcut/ShortcutBar.svelte";
  import Toaster from "$lib/features/notifications/Toaster.svelte";
  import ConfirmHost from "$lib/shared/components/ConfirmHost.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import RemoteLogin from "$lib/features/workspace/RemoteLogin.svelte";
  import FolderBrowser from "$lib/features/project/FolderBrowser.svelte";
  import RightPanel from "$lib/features/panes/RightPanel.svelte";
  import { paneStore } from "$lib/features/panes/store.svelte";
  import PaneShell from "$lib/features/panes/PaneShell.svelte";
  import PaneOverlay from "$lib/features/panes/PaneOverlay.svelte";
  import PaneDropOverlay from "$lib/features/panes/PaneDropOverlay.svelte";
  import GitPanel from "$lib/features/git/GitPanel.svelte";
  import ExplorerPanel from "$lib/features/explorer/ExplorerPanel.svelte";
  import MobileTopBar from "$lib/features/mobile/MobileTopBar.svelte";
  import MobileBottomBar from "$lib/features/mobile/MobileBottomBar.svelte";
  import MobileProjectsPage from "$lib/features/mobile/MobileProjectsPage.svelte";
  import { lazyComponent, prefetchWhenIdle } from "$lib/shared/lazy.svelte";
  import { t } from "$lib/i18n/index.svelte";

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
  // Pulls xterm in through the fallback bubble, so it stays behind the same
  // kind of import() the terminal does.
  const ChatView = lazyComponent(
    () => import("$lib/features/chat/ChatPage.svelte"),
  );
  // Shares the chat's components, so it lands in the same chunk.
  const ProjectView = lazyComponent(
    () => import("$lib/features/project/ProjectPage.svelte"),
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

  // Colored inset outline marks the PURE remote workspace: green connected,
  // amber (pulsing) while connecting or dropped. Dynamic mode presents as
  // Local, so it gets no outline — the boite shows through the sidebar
  // accents instead.
  const outlineClass = $derived(
    workspace.mode !== "remote"
      ? ""
      : workspace.connection === "connected"
        ? "ws-remote-ok"
        : "ws-remote-warn",
  );

  $effect(() => {
    void app.threads.length;
    // untrack: syncWithThreads reads AND writes paneStore.groups/rects;
    // tracked, this effect re-ran on its own writes and on every
    // ResizeObserver tick during pane drags.
    untrack(() => paneStore.syncWithThreads());
  });

  const activeGroupId = $derived.by(() => {
    if (!app.activeThreadId) return null;
    return paneStore.groupOf(app.activeThreadId)?.id ?? null;
  });

  $effect(() => {
    const id = app.activeThreadId;
    if (!id) return;
    const g = paneStore.groupOf(id);
    if (g && g.focusedThreadId !== id) g.focusedThreadId = id;
  });

  function activateThread(id: string) {
    const t = app.threadById(id);
    const isFinished =
      t &&
      (t.status === "done" ||
        t.status === "exited" ||
        t.status === "error" ||
        t.status === "stopped");

    if (app.activeThreadId === id && app.view === "terminal" && !isFinished) {
      return;
    }

    activated[id] = true;
    if (isFinished) {
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

  $effect(() => {
    const id = app.activeThreadId;
    if (id && app.hasThread(id) && !activated[id]) {
      activated[id] = true;
    }
  });

  $effect(() => {
    const g = paneStore.groups.find((x) => x.id === activeGroupId);
    if (!g) return;
    for (const leafId of paneStore.visibleLeaves(activeGroupId)) {
      if (!activated[leafId] && app.hasThread(leafId)) {
        activated[leafId] = true;
      }
    }
  });

  // Mounting a Terminal is what spawns its PTY, so the post-update resume asks
  // for its threads here rather than reaching into this component's state.
  $effect(() => {
    const requested = app.requestedActivations;
    if (requested.length === 0) return;
    for (const id of requested) {
      if (!activated[id] && app.hasThread(id)) {
        activated[id] = true;
      }
    }
    untrack(() => app.clearRequestedActivations());
  });

  $effect(() => {
    const valid = new Set(app.threads.map((t) => t.id));
    let dirty = false;
    for (const id of Object.keys(activated)) {
      if (!valid.has(id)) {
        delete activated[id];
        dirty = true;
      }
    }
    if (dirty) activated = { ...activated };
  });

  onMount(() => prefetchWhenIdle(TerminalView));

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
    if (app.view === "chat") void ChatView.ensure();
  });

  $effect(() => {
    if (app.view === "project") void ProjectView.ensure();
  });

  $effect(() => {
    if (settingsActive) void SettingsView.ensure();
  });

  $effect(() => {
    if (!workspace.needsLogin && !settings.state.setupCompleted) {
      void SetupView.ensure();
    }
  });

  // Opening the Files or Git panel is the strongest signal that a file or a
  // diff is about to be opened; warm the editor before the click lands.
  $effect(() => {
    if (settings.state.rightPanel) prefetchWhenIdle(EditorView);
  });
</script>

<div
  class="flex h-screen w-screen flex-col overflow-hidden bg-background"
  class:mobile-mode={mobile}
>
  <CloseGuard />
  {#if mobile}
    <MobileTopBar />
  {:else}
    <TitleBar />
  {/if}
  <FolderBrowser />

  {#key workspace.epoch}
  {#if workspace.needsLogin}
    <div class="flex min-h-0 flex-1">
      <RemoteLogin />
    </div>
  {:else if !settings.state.setupCompleted}
    <!-- After login, never before: the wizard asks the backend which agents
         are installed, and on a remote boite that answer only exists once the
         connection is up. -->
    {#if SetupView.current}
      {@const SetupComp = SetupView.current}
      <SetupComp />
    {/if}
  {:else}
    <div class="flex min-h-0 flex-1">
    {#if !mobile && !settings.state.sidebarCollapsed}
      <ProjectSidebar
        onActivateThread={activateThread}
        onNewProject={addProject}
        onRemoveProject={removeProject}
      />
    {/if}

    <main class="relative flex min-w-0 flex-1 flex-col">
      {#if !app.ready}
        <div class="flex h-full items-center justify-center">
          <p class="font-mono text-xs text-muted-foreground/60">{t("common.loading")}</p>
        </div>
      {:else}
        <div
          class="flex h-full min-h-0 flex-col"
          class:hidden={!terminalActive}
        >
          {#if !mobile}
            <ShortcutBar />
          {/if}

          {#if app.threads.length === 0}
            <div class="flex h-full items-center justify-center">
              <div class="flex flex-col items-center gap-4 text-center">
                <span class="text-muted-foreground/40">
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
                    class="rounded-md border border-border bg-[var(--color-surface)] px-3 py-1.5 text-sm text-foreground transition hover:bg-[var(--color-surface-2)]"
                    onclick={() => addProject()}
                  >
                    {t("common.chooseFolder")}
                  </button>
                {/if}
              </div>
            </div>
          {:else if app.activeThreadId === null && mobile}
            <div class="flex h-full items-center justify-center px-8 text-center">
              <p class="text-sm text-muted-foreground">
                {t("welcome.tapOrPick")}
              </p>
            </div>
          {:else if app.activeThreadId === null}
            <div class="flex h-full items-center justify-center">
              <div class="flex flex-col items-center gap-5">
                <p class="text-sm text-muted-foreground">
                  {t("welcome.pickThread")}
                </p>
                <div class="grid grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-xs text-muted-foreground/70">
                  <span class="text-right"><kbd class="kbd">Ctrl</kbd> <kbd class="kbd">T</kbd></span>
                  <span>{t("welcome.newTerminal")}</span>
                  <span class="text-right"><kbd class="kbd">Ctrl</kbd> <kbd class="kbd">Tab</kbd></span>
                  <span>{t("welcome.cycleThreads")}</span>
                  <span class="text-right"><kbd class="kbd">Ctrl</kbd> <kbd class="kbd">1–9</kbd></span>
                  <span>{t("welcome.jumpToThread")}</span>
                  <span class="text-right"><kbd class="kbd">Ctrl</kbd> <kbd class="kbd">B</kbd></span>
                  <span>{t("welcome.toggleSidebar")}</span>
                  <span class="text-right"><kbd class="kbd">Ctrl</kbd> <kbd class="kbd">W</kbd></span>
                  <span>{t("welcome.closeThread")}</span>
                </div>
              </div>
            </div>
          {/if}

          <div
            class="relative min-h-0 flex-1 bg-[var(--color-background)]"
            data-pane-viewport
          >
            {#each paneStore.groups as group (group.id)}
              {@const visible = activeGroupId === group.id && terminalActive}
              <div
                class="absolute inset-0"
                style:visibility={visible ? "visible" : "hidden"}
                aria-hidden={!visible}
              >
                <PaneShell {group} />
              </div>
            {/each}

            {#each app.threads as thread (thread.id)}
              {@const group = paneStore.groupOf(thread.id)}
              {@const visible =
                group?.id === activeGroupId && terminalActive}
              {@const focused =
                visible && group?.focusedThreadId === thread.id}
              {@const rect = paneStore.rects[thread.id]}
              {#if activated[thread.id] && rect && group}
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
                  {#key app.respawnNonce[thread.id] ?? 0}
                    {#if TerminalView.current}
                      {@const TerminalComp = TerminalView.current}
                      <TerminalComp {thread} {visible} {focused} />
                    {/if}
                  {/key}
                  <PaneOverlay {thread} {group} {focused} />
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

        <!-- Under the editor and the settings, like every other page: a diff
             opened from a chat sets view=editor and has to win. -->
        {#if app.view === "chat"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            {#if ChatView.current}
              {@const ChatComp = ChatView.current}
              <ChatComp />
            {/if}
          </div>
        {/if}

        {#if app.view === "editor"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            {#if EditorView.current}
              {@const EditorComp = EditorView.current}
              <EditorComp />
            {:else}
              <div class="flex h-full items-center justify-center text-xs text-muted-foreground/70">
                Loading…
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

        {#if mobile && app.view === "terminal" && app.mobileTab === "projects"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            <MobileProjectsPage />
          </div>
        {/if}
      {/if}
      <!-- ConfirmHost first: both are z-50, so DOM order decides and toasts
           must paint above the confirm backdrop, not dimmed under it. -->
      <ConfirmHost />
      <Toaster />
    </main>

    {#if !mobile && app.ready && settings.state.rightPanel}
      <RightPanel />
    {/if}
  </div>
  {/if}
  {/key}

  {#if mobile && !workspace.needsLogin}
    <MobileBottomBar />
  {/if}

  {#if workspace.mode === "remote"}
    <div
      class="ws-outline {outlineClass}"
      style:--ws-color={workspace.info.color || "var(--color-success)"}
      aria-hidden="true"
    ></div>
  {/if}
</div>

<style>
  .ws-outline {
    position: fixed;
    inset: 0;
    z-index: 100;
    pointer-events: none;
    /* Inset shadows follow border-radius, so this rounds the connection
       outline at the corners instead of squaring off the viewport. */
    border-radius: 10px;
    transition: box-shadow 150ms ease;
  }
  :global(.mobile-mode) .ws-outline {
    border-radius: 18px;
  }
  .ws-remote-ok {
    box-shadow: inset 0 0 0 1.5px var(--ws-color, var(--color-success));
  }
  .ws-remote-warn {
    box-shadow: inset 0 0 0 1.5px var(--color-warning);
    animation: ws-pulse 1.2s ease-in-out infinite;
  }
  @keyframes ws-pulse {
    50% {
      box-shadow: inset 0 0 0 1.5px
        color-mix(in srgb, var(--color-warning) 35%, transparent);
    }
  }
</style>
