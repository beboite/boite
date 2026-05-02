<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import MoreHorizontal from "@lucide/svelte/icons/more-horizontal";

  type Props = {
    onCloseThread: (threadId: string) => void;
    onNewProject: () => void;
    onRemoveProject: (projectId: string) => void;
  };
  let { onCloseThread, onNewProject, onRemoveProject }: Props = $props();

  let menuFor = $state<string | null>(null);

  function toggleMenu(id: string, e: MouseEvent) {
    e.stopPropagation();
    menuFor = menuFor === id ? null : id;
  }

  function closeMenu() {
    menuFor = null;
  }

  function selectProject(projectId: string) {
    app.selectedProjectId = projectId;
    app.view = "terminal";
  }
</script>

<svelte:window onclick={closeMenu} />

<aside
  class="flex h-full w-60 shrink-0 flex-col border-r border-border bg-[var(--color-surface)]"
>
  <header class="flex items-center justify-between px-3 py-2.5">
    <span
      class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
    >
      Projects
    </span>
    <button
      type="button"
      class="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
      onclick={onNewProject}
      aria-label="Add project"
      title="Add project from folder"
    >
      <Plus class="size-3.5" />
    </button>
  </header>

  <div class="flex-1 overflow-y-auto px-2 pb-2">
    {#if app.projects.length === 0}
      <button
        type="button"
        class="mx-1 mt-2 flex w-[calc(100%-0.5rem)] flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-transparent px-3 py-7 text-xs text-muted-foreground transition hover:border-foreground/30 hover:bg-accent/30 hover:text-foreground"
        onclick={onNewProject}
      >
        <FolderOpen class="size-5 opacity-70" />
        <span>Pick a folder</span>
      </button>
    {/if}

    {#each app.projects as project (project.id)}
      {@const isSelected = app.currentProjectId === project.id}
      <div class="mb-1.5">
        <div
          class="group/project relative flex items-center gap-2 rounded-md px-2 py-1.5 transition {isSelected
            ? 'bg-accent/40'
            : ''}"
        >
          <div
            class="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded bg-[var(--color-surface-3)]"
          >
            {#if project.icon}
              <img
                src={project.icon}
                alt=""
                class="size-full object-cover"
                loading="lazy"
              />
            {:else}
              <span class="text-[10px] font-semibold text-muted-foreground">
                {project.name.charAt(0).toUpperCase()}
              </span>
            {/if}
          </div>
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-xs font-medium text-foreground/90"
            title={project.cwd}
            onclick={() => selectProject(project.id)}
          >
            {project.name}
          </button>

          <div
            class="flex items-center opacity-0 transition group-hover/project:opacity-100"
          >
            <button
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onclick={(e) => toggleMenu(project.id, e)}
              aria-label="Project options"
              title="More"
            >
              <MoreHorizontal class="size-3" />
            </button>
          </div>

          {#if menuFor === project.id}
            <div
              class="absolute right-2 top-full z-20 mt-1 flex min-w-36 flex-col rounded-md border bg-[var(--color-surface-2)] p-1 shadow-xl"
              role="menu"
            >
              <button
                type="button"
                class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-danger transition hover:bg-danger/15"
                onclick={(e) => {
                  e.stopPropagation();
                  closeMenu();
                  onRemoveProject(project.id);
                }}
              >
                <Trash2 class="size-3" />
                Remove project
              </button>
            </div>
          {/if}
        </div>

        {#if app.threadsByProject(project.id).length > 0}
          <ul class="ml-2 space-y-0.5 border-l border-border/60 pl-2">
            {#each app.threadsByProject(project.id) as thread (thread.id)}
              <li class="group/thread">
                <div
                  class="flex items-center gap-2 rounded-md px-2 py-1.5 transition {app.activeThreadId ===
                    thread.id && app.view === 'terminal'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'}"
                >
                  <StatusDot status={thread.status} />
                  <span class="flex size-3.5 shrink-0 items-center justify-center">
                    <ShortcutIcon iconKey={thread.iconKey} size={12} />
                  </span>
                  <button
                    type="button"
                    class="min-w-0 flex-1 truncate text-left text-[12.5px]"
                    onclick={() => {
                      app.activeThreadId = thread.id;
                      app.view = "terminal";
                    }}
                    title={thread.title ?? thread.label}
                  >
                    {thread.title ?? thread.label}
                  </button>
                  <button
                    type="button"
                    class="rounded p-0.5 text-muted-foreground/60 opacity-0 transition hover:bg-background hover:text-foreground group-hover/thread:opacity-100"
                    onclick={() => onCloseThread(thread.id)}
                    aria-label="Close {thread.label}"
                    title="Close thread"
                  >
                    <X class="size-3" />
                  </button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  </div>
</aside>
