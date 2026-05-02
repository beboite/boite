<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { pickAndAddProject } from "$lib/features/project/api";
  import { ptyKill } from "$lib/storage/pty";
  import { closeThread } from "$lib/features/thread/api";
  import TitleBar from "$lib/shared/components/TitleBar.svelte";
  import ProjectSidebar from "$lib/features/project/ProjectSidebar.svelte";
  import ShortcutBar from "$lib/features/shortcut/ShortcutBar.svelte";
  import SettingsPanel from "$lib/features/settings/SettingsPanel.svelte";
  import Terminal from "$lib/features/terminal/Terminal.svelte";
  import Toaster from "$lib/features/notifications/Toaster.svelte";

  async function addProject() {
    await pickAndAddProject();
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
    }
    await app.removeProject(projectId);
  }
</script>

<div class="flex h-screen w-screen flex-col overflow-hidden bg-background">
  <TitleBar />

  <div class="flex min-h-0 flex-1">
    <ProjectSidebar
      onCloseThread={closeThread}
      onNewProject={addProject}
      onRemoveProject={removeProject}
    />

    <main class="flex min-w-0 flex-1 flex-col">
      {#if app.view === "settings"}
        <SettingsPanel />
      {:else}
        <ShortcutBar />

        {#if app.threads.length === 0}
          <div class="flex h-full items-center justify-center">
            <div class="flex flex-col items-center gap-3 text-center">
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
        {/if}

        <div class="relative min-h-0 flex-1 bg-[var(--color-background)]">
          {#each app.threads as thread (thread.id)}
            <div
              class="absolute inset-0"
              style:visibility={app.activeThreadId === thread.id ? "visible" : "hidden"}
              aria-hidden={app.activeThreadId !== thread.id}
            >
              <Terminal {thread} active={app.activeThreadId === thread.id} />
            </div>
          {/each}
        </div>
      {/if}
    </main>
  </div>
</div>

<Toaster />
