<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { pickAndAddProject } from "$lib/features/project/api";
  import { ptyKill } from "$lib/storage/pty";
  import { closeThread, reloadThread } from "$lib/features/thread/api";
  import TitleBar from "$lib/shared/components/TitleBar.svelte";
  import ProjectSidebar from "$lib/features/project/ProjectSidebar.svelte";
  import ShortcutBar from "$lib/features/shortcut/ShortcutBar.svelte";
  import SettingsPanel from "$lib/features/settings/SettingsPanel.svelte";
  import Terminal from "$lib/features/terminal/Terminal.svelte";
  import Toaster from "$lib/features/notifications/Toaster.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import RightPanel from "$lib/features/panes/RightPanel.svelte";
  import { paneStore } from "$lib/features/panes/store.svelte";
  import PaneShell from "$lib/features/panes/PaneShell.svelte";
  import PaneOverlay from "$lib/features/panes/PaneOverlay.svelte";
  import PaneDropOverlay from "$lib/features/panes/PaneDropOverlay.svelte";
  import EditorPanel from "$lib/features/editor/EditorPanel.svelte";

  let activated = $state<Record<string, true>>({});

  $effect(() => {
    void app.threads.length;
    paneStore.syncWithThreads();
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
      const wasStopped = t?.status === "stopped";
      void reloadThread(id, { keepScrollback: wasStopped });
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

  async function handleCloseThread(id: string) {
    await closeThread(id);
    delete activated[id];
    activated = { ...activated };
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

<div class="flex h-screen w-screen flex-col overflow-hidden bg-background">
  <TitleBar />

  <div class="flex min-h-0 flex-1">
    {#if !settings.state.sidebarCollapsed}
      <ProjectSidebar
        onCloseThread={handleCloseThread}
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
          class:hidden={app.view !== "terminal"}
        >
          <ShortcutBar />

          {#if app.threads.length === 0}
            <div class="flex h-full items-center justify-center">
              <div class="flex flex-col items-center gap-4 text-center">
                <span class="text-muted-foreground/40">
                  <BoiteLogo size={64} />
                </span>
                <p class="text-sm text-muted-foreground">
                  {app.projects.length === 0
                    ? "Pick a folder to create your first project."
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
          {:else if app.activeThreadId === null}
            <div class="flex h-full items-center justify-center">
              <p class="text-sm text-muted-foreground">
                Pick a thread on the left to bring it to life.
              </p>
            </div>
          {/if}

          <div
            class="relative min-h-0 flex-1 bg-[var(--color-background)]"
            data-pane-viewport
          >
            {#each paneStore.groups as group (group.id)}
              {@const visible = activeGroupId === group.id && app.view === "terminal"}
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
                group?.id === activeGroupId && app.view === "terminal"}
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

        {#if app.view === "settings"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            <SettingsPanel />
          </div>
        {/if}

        {#if app.view === "editor"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            <EditorPanel />
          </div>
        {/if}
      {/if}
      <Toaster />
    </main>

    {#if app.ready && settings.state.rightPanel}
      <RightPanel />
    {/if}
  </div>
</div>
