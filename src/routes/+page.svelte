<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { pickAndAddProject } from "$lib/features/project/api";
  import { ptyKill } from "$lib/storage/pty";
  import { closeThread } from "$lib/features/thread/api";
  import { statusEngine } from "$lib/features/thread/statusEngine";
  import TitleBar from "$lib/shared/components/TitleBar.svelte";
  import ProjectSidebar from "$lib/features/project/ProjectSidebar.svelte";
  import ShortcutBar from "$lib/features/shortcut/ShortcutBar.svelte";
  import SettingsPanel from "$lib/features/settings/SettingsPanel.svelte";
  import Terminal from "$lib/features/terminal/Terminal.svelte";
  import Toaster from "$lib/features/notifications/Toaster.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";

  let activated = $state<Record<string, true>>({});

  function activateThread(id: string) {
    const t = app.threads.find((x) => x.id === id);
    const isFinished =
      t && (t.status === "done" || t.status === "exited" || t.status === "error");
    activated[id] = true;
    app.activeThreadId = id;
    if (t) app.selectedProjectId = t.projectId;
    app.view = "terminal";
    statusEngine.markViewed(id);
    if (isFinished) {
      app.bumpRespawn(id);
    }
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
        try {
          await ptyKill(t.ptyId);
        } catch {
          // already exited
        }
      }
      delete activated[t.id];
    }
    activated = { ...activated };
    await app.removeProject(projectId);
  }

  // Pre-activate any thread that becomes active via shortcut/blank-terminal launch.
  $effect(() => {
    const id = app.activeThreadId;
    if (id && app.threads.some((t) => t.id === id) && !activated[id]) {
      activated[id] = true;
      statusEngine.markViewed(id);
    }
  });

  // Drop activation entries for threads that no longer exist (project removed,
  // thread deleted from another path, etc.). Keeps the map from accumulating
  // dead keys during a long session.
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

          <div class="relative min-h-0 flex-1 bg-[var(--color-background)]">
            {#each app.threads as thread (thread.id)}
              {#if activated[thread.id]}
                <div
                  class="absolute inset-0"
                  style:visibility={app.activeThreadId === thread.id && app.view === "terminal" ? "visible" : "hidden"}
                  aria-hidden={!(app.activeThreadId === thread.id && app.view === "terminal")}
                >
                  {#key app.respawnNonce[thread.id] ?? 0}
                    <Terminal {thread} active={app.activeThreadId === thread.id && app.view === "terminal"} />
                  {/key}
                </div>
              {/if}
            {/each}
          </div>
        </div>

        {#if app.view === "settings"}
          <div class="absolute inset-0 z-10 bg-[var(--color-background)]">
            <SettingsPanel />
          </div>
        {/if}
      {/if}
    </main>
  </div>
</div>

<Toaster />
