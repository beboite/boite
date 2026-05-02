<script lang="ts">
  import { app } from "$lib/store.svelte";
  import { ptyKill } from "$lib/pty";
  import { pickAndAddProject } from "$lib/projects";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import Terminal from "$lib/components/Terminal.svelte";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import SettingsPanel from "$lib/components/SettingsPanel.svelte";
  import ShortcutBar from "$lib/components/ShortcutBar.svelte";

  async function closeThread(threadId: string) {
    const t = app.threads.find((x) => x.id === threadId);
    if (t?.ptyId) {
      try {
        await ptyKill(t.ptyId);
      } catch {
        // already exited
      }
    }
    app.removeThread(threadId);
  }

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
    <Sidebar
      onCloseThread={closeThread}
      onNewProject={addProject}
      onRemoveProject={removeProject}
      onOpenSettings={() => (app.view = "settings")}
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

        <div class="relative min-h-0 flex-1 bg-[#13151a]">
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
