<script lang="ts">
  import { untrack } from "svelte";
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
  import SettingsPanel from "$lib/features/settings/SettingsPanel.svelte";
  import Terminal from "$lib/features/terminal/Terminal.svelte";
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
  import EditorPanel from "$lib/features/editor/EditorPanel.svelte";
  import GitPanel from "$lib/features/git/GitPanel.svelte";
  import ExplorerPanel from "$lib/features/explorer/ExplorerPanel.svelte";
  import MobileTopBar from "$lib/features/mobile/MobileTopBar.svelte";
  import MobileBottomBar from "$lib/features/mobile/MobileBottomBar.svelte";
  import MobileProjectsPage from "$lib/features/mobile/MobileProjectsPage.svelte";

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

  // Colored inset outline marks the remote workspace: green connected, amber
  // (pulsing) while connecting or dropped.
  const outlineClass = $derived(
    workspace.mode === "local"
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
    const t = app.threads.find((x) => x.id === id);
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

  async function addProject() {
    await pickAndAddProject();
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
    if (id && app.threads.some((t) => t.id === id) && !activated[id]) {
      activated[id] = true;
    }
  });

  $effect(() => {
    const g = paneStore.groups.find((x) => x.id === activeGroupId);
    if (!g) return;
    for (const leafId of paneStore.visibleLeaves(activeGroupId)) {
      if (!activated[leafId] && app.threads.some((t) => t.id === leafId)) {
        activated[leafId] = true;
      }
    }
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
          <p class="font-mono text-xs text-muted-foreground/60">Loading…</p>
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
                    ? "Pick a folder to create your first project."
                    : mobile
                      ? "Tap + to open a terminal."
                      : "Click a shortcut above to launch a terminal."}
                </p>
                {#if app.projects.length === 0}
                  <button
                    type="button"
                    class="rounded-md border border-border bg-[var(--color-surface)] px-3 py-1.5 text-sm text-foreground transition hover:bg-[var(--color-surface-2)]"
                    onclick={addProject}
                  >
                    Choose folder…
                  </button>
                {/if}
              </div>
            </div>
          {:else if app.activeThreadId === null && mobile}
            <div class="flex h-full items-center justify-center px-8 text-center">
              <p class="text-sm text-muted-foreground">
                Tap + to open a terminal, or pick one from Projects.
              </p>
            </div>
          {:else if app.activeThreadId === null}
            <div class="flex h-full items-center justify-center">
              <div class="flex flex-col items-center gap-5">
                <p class="text-sm text-muted-foreground">
                  Pick a thread on the left to bring it to life.
                </p>
                <div class="grid grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-xs text-muted-foreground/70">
                  <span class="text-right"><kbd class="kbd">Ctrl</kbd> <kbd class="kbd">T</kbd></span>
                  <span>New terminal</span>
                  <span class="text-right"><kbd class="kbd">Ctrl</kbd> <kbd class="kbd">Tab</kbd></span>
                  <span>Cycle threads</span>
                  <span class="text-right"><kbd class="kbd">Ctrl</kbd> <kbd class="kbd">1–9</kbd></span>
                  <span>Jump to thread</span>
                  <span class="text-right"><kbd class="kbd">Ctrl</kbd> <kbd class="kbd">B</kbd></span>
                  <span>Toggle sidebar</span>
                  <span class="text-right"><kbd class="kbd">Ctrl</kbd> <kbd class="kbd">W</kbd></span>
                  <span>Close thread</span>
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
                    <Terminal {thread} {visible} {focused} />
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
            <SettingsPanel />
          </div>
        {/if}

        {#if app.view === "editor"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            <EditorPanel />
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

  {#if workspace.mode !== "local"}
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
