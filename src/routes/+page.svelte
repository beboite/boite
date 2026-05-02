<script lang="ts">
  import { app, type Thread } from "$lib/store.svelte";
  import { ptyKill } from "$lib/pty";
  import { pickAndAddProject } from "$lib/projects";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import Terminal from "$lib/components/Terminal.svelte";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import SettingsDialog from "$lib/components/SettingsDialog.svelte";
  import StatusDot from "$lib/components/StatusDot.svelte";
  import X from "@lucide/svelte/icons/x";

  let settingsOpen = $state(false);

  function newThread(projectId: string) {
    const project = app.projects.find((p) => p.id === projectId);
    if (!project) return;
    const id = crypto.randomUUID();
    const count = app.threadsByProject(projectId).length + 1;
    const thread: Thread = {
      id,
      projectId,
      ptyId: null,
      label: `${project.name} #${count}`,
      title: null,
      status: "idle",
      exitCode: null,
      createdAt: Date.now(),
    };
    app.upsertThread(thread);
    app.activeThreadId = id;
  }

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
    const project = await pickAndAddProject();
    if (project) newThread(project.id);
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

  function projectFor(t: Thread) {
    return app.projects.find((p) => p.id === t.projectId) ?? null;
  }
</script>

<div class="flex h-screen w-screen flex-col overflow-hidden bg-background">
  <TitleBar />

  <div class="flex min-h-0 flex-1">
    <Sidebar
      onNewThread={newThread}
      onCloseThread={closeThread}
      onNewProject={addProject}
      onRemoveProject={removeProject}
      onOpenSettings={() => (settingsOpen = true)}
    />

    <main class="flex min-w-0 flex-1 flex-col">
      {#if app.threads.length > 0}
        <div
          class="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-[var(--color-surface)]"
        >
          {#each app.threads as thread (thread.id)}
            {@const proj = projectFor(thread)}
            {@const isActive = app.activeThreadId === thread.id}
            <div
              class="group flex shrink-0 items-center gap-2 border-r border-border px-3 transition {isActive
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'}"
            >
              <button
                type="button"
                class="flex items-center gap-2 text-[12px]"
                onclick={() => (app.activeThreadId = thread.id)}
                title={thread.title ?? thread.label}
              >
                <StatusDot status={thread.status} />
                {#if proj?.icon}
                  <img src={proj.icon} alt="" class="size-3.5 rounded-sm object-cover" />
                {/if}
                <span class="max-w-[180px] truncate">
                  {thread.title ?? thread.label}
                </span>
              </button>
              <button
                type="button"
                class="rounded p-0.5 text-muted-foreground/60 opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                onclick={() => closeThread(thread.id)}
                aria-label="Close"
              >
                <X class="size-3" />
              </button>
            </div>
          {/each}
        </div>
      {/if}

      {#if app.activeThread}
        <div class="flex h-7 shrink-0 items-center gap-3 border-b border-border bg-[var(--color-surface)] px-4">
          <span class="font-mono text-[10px] text-muted-foreground/80">
            {app.activeThread.title ?? app.activeThread.label}
          </span>
          {#if app.activeThread.exitCode !== null}
            <span
              class="rounded-sm px-1.5 font-mono text-[9px] {app.activeThread.exitCode === 0
                ? 'bg-success/15 text-success'
                : 'bg-danger/15 text-danger'}"
            >
              exit {app.activeThread.exitCode}
            </span>
          {/if}
        </div>
      {:else}
        <div class="flex h-full items-center justify-center">
          <div class="flex flex-col items-center gap-3 text-center">
            <p class="text-sm text-muted-foreground">
              {app.projects.length === 0
                ? "Pick a folder to create your first project."
                : "Select or create a thread."}
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
    </main>
  </div>
</div>

<SettingsDialog
  bind:open={settingsOpen}
  onClose={() => (settingsOpen = false)}
/>
