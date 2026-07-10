<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { pickAndAddProject } from "$lib/features/project/api";
  import { closeThreadWithConfirm } from "$lib/features/thread/api";
  import type { Thread, ThreadStatus } from "$lib/types";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import MobileLaunchSheet from "./MobileLaunchSheet.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import X from "@lucide/svelte/icons/x";

  const projects = $derived(app.sortedProjects);
  let launchOpen = $state(false);

  function displayStatus(thread: Thread): ThreadStatus {
    if (app.unboundByDedup.includes(thread.id)) return "error";
    if (thread.ptyId && (thread.status === "idle" || thread.status === "stopped")) {
      return "ready";
    }
    return thread.status;
  }

  function openThread(thread: Thread) {
    app.selectedProjectId = thread.projectId;
    app.activeThreadId = thread.id;
    app.mobileTab = "terminal";
  }

  function launchInto(id: string) {
    app.selectedProjectId = id;
    launchOpen = true;
  }

  // Tapping a project should land on a live terminal: open its most recent
  // thread, or the launch picker when it has none (selecting alone left the
  // user on an empty terminal page).
  function selectProject(id: string) {
    app.selectedProjectId = id;
    const threads = app.threadsByProjectSorted(id);
    if (threads.length > 0) {
      app.activeThreadId = threads[threads.length - 1].id;
      app.mobileTab = "terminal";
    } else {
      launchInto(id);
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
  <header class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
    <h2 class="text-sm font-semibold text-foreground">Projects</h2>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg border border-border bg-[var(--color-surface-2)] px-3 py-2 text-[13px] font-medium text-foreground/90 transition active:bg-[var(--color-surface-3)]"
      onclick={() => void pickAndAddProject()}
    >
      <FolderPlus class="size-4" />
      Add
    </button>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto p-2.5">
    {#if projects.length === 0}
      <div class="flex flex-col items-center gap-3 px-4 py-12 text-center text-sm text-muted-foreground">
        No projects yet. Add a folder to start.
      </div>
    {:else}
      <div class="flex flex-col gap-2.5">
        {#each projects as project (project.id)}
          {@const threads = app.threadsByProjectSorted(project.id)}
          {@const isCurrent = app.currentProjectId === project.id}
          <section
            class="overflow-hidden rounded-xl border bg-[var(--color-surface)] {isCurrent
              ? 'border-foreground/25'
              : 'border-border'}"
          >
            <div class="flex items-center gap-3 px-3 py-3">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-3 text-left"
                onclick={() => selectProject(project.id)}
              >
                <span
                  class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md"
                  style:background={project.icon ? "transparent" : "var(--color-surface-3)"}
                >
                  {#if project.icon}
                    <img src={project.icon} alt="" class="size-full object-contain" decoding="async" draggable="false" />
                  {:else}
                    <span class="text-sm font-semibold text-muted-foreground">
                      {project.name.charAt(0).toUpperCase()}
                    </span>
                  {/if}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[14px] font-medium text-foreground">{project.name}</span>
                  <span class="block truncate text-[11px] text-muted-foreground">
                    {threads.length} terminal{threads.length === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
              <button
                type="button"
                class="flex size-9 shrink-0 items-center justify-center rounded-lg text-foreground/80 transition hover:bg-accent active:bg-accent/70"
                onclick={() => launchInto(project.id)}
                aria-label="New terminal in {project.name}"
              >
                <Plus class="size-5" />
              </button>
            </div>

            {#if threads.length > 0}
              <ul class="border-t border-border">
                {#each threads as thread (thread.id)}
                  {@const isActive = app.activeThreadId === thread.id}
                  <li class="flex items-center gap-3 px-3 py-2.5 {isActive ? 'bg-[var(--color-surface-2)]' : ''}">
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-3 text-left"
                      onclick={() => openThread(thread)}
                    >
                      <StatusDot
                        status={displayStatus(thread)}
                        asleep={thread.autoSlept ?? false}
                        keepAwake={(thread.keepAwake ?? false) && !!thread.ptyId}
                      />
                      <ShortcutIcon iconKey={thread.iconKey} size={15} />
                      <span class="min-w-0 flex-1 truncate text-[13px] text-foreground/85">
                        {thread.title ?? thread.label}
                      </span>
                    </button>
                    <button
                      type="button"
                      class="shrink-0 rounded-lg p-2 text-muted-foreground/70 transition hover:bg-danger/20 hover:text-danger active:bg-danger/30"
                      onclick={() => void closeThreadWithConfirm(thread.id)}
                      aria-label="Close {thread.label}"
                    >
                      <X class="size-4" />
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </div>
</div>

<MobileLaunchSheet open={launchOpen} onClose={() => (launchOpen = false)} />
