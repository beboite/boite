<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import ConfirmDialog from "$lib/shared/components/ConfirmDialog.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import MoreHorizontal from "@lucide/svelte/icons/more-horizontal";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";

  type Props = {
    onCloseThread: (threadId: string) => void;
    onNewProject: () => void;
    onRemoveProject: (projectId: string) => void;
  };
  let { onCloseThread, onNewProject, onRemoveProject }: Props = $props();

  let menuFor = $state<string | null>(null);
  let confirmThreadId = $state<string | null>(null);
  let confirmProjectId = $state<string | null>(null);

  // Drag-arm flags so the row only becomes draggable when grabbing the grip.
  let projectArmed = $state<string | null>(null);
  let threadArmed = $state<string | null>(null);

  let projectDragging = $state<string | null>(null);
  let projectOver = $state<string | null>(null);
  let threadDragging = $state<{ id: string; projectId: string } | null>(null);
  let threadOver = $state<string | null>(null);

  let resizing = $state(false);
  let asideEl: HTMLElement | null = $state(null);

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

  // ----- Project drag reorder -----
  function projectDragStart(id: string, e: DragEvent) {
    if (projectArmed !== id) {
      e.preventDefault();
      return;
    }
    projectDragging = id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    }
  }
  function projectDragOver(id: string, e: DragEvent) {
    if (!projectDragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    projectOver = id;
  }
  function projectDrop(id: string, e: DragEvent) {
    e.preventDefault();
    const from = projectDragging;
    projectDragging = null;
    projectOver = null;
    projectArmed = null;
    if (!from || from === id) return;
    const ids = app.sortedProjects.map((p) => p.id);
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(id);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, from);
    void settings.setProjectOrder(ids);
  }
  function projectDragEnd() {
    projectDragging = null;
    projectOver = null;
    projectArmed = null;
  }

  // ----- Thread drag reorder (within project only) -----
  function threadDragStart(id: string, projectId: string, e: DragEvent) {
    if (threadArmed !== id) {
      e.preventDefault();
      return;
    }
    threadDragging = { id, projectId };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    }
  }
  function threadDragOver(id: string, projectId: string, e: DragEvent) {
    if (!threadDragging || threadDragging.projectId !== projectId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    threadOver = id;
  }
  function threadDrop(id: string, projectId: string, e: DragEvent) {
    e.preventDefault();
    const drag = threadDragging;
    threadDragging = null;
    threadOver = null;
    threadArmed = null;
    if (!drag || drag.projectId !== projectId || drag.id === id) return;
    const ids = app.threadsByProjectSorted(projectId).map((t) => t.id);
    const fromIdx = ids.indexOf(drag.id);
    const toIdx = ids.indexOf(id);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, drag.id);
    void settings.setThreadOrder(projectId, ids);
  }
  function threadDragEnd() {
    threadDragging = null;
    threadOver = null;
    threadArmed = null;
  }

  // ----- Sidebar resize -----
  function startResize(e: MouseEvent) {
    e.preventDefault();
    resizing = true;
    document.addEventListener("mousemove", onResize);
    document.addEventListener("mouseup", stopResize);
  }
  function onResize(e: MouseEvent) {
    if (!asideEl) return;
    const rect = asideEl.getBoundingClientRect();
    const next = e.clientX - rect.left;
    void settings.setSidebarWidth(next);
  }
  function stopResize() {
    resizing = false;
    document.removeEventListener("mousemove", onResize);
    document.removeEventListener("mouseup", stopResize);
  }

  // ----- Confirm handlers -----
  function requestRemoveThread(id: string) {
    confirmThreadId = id;
  }
  function confirmRemoveThread() {
    if (confirmThreadId) onCloseThread(confirmThreadId);
    confirmThreadId = null;
  }
  function cancelRemoveThread() {
    confirmThreadId = null;
  }

  function requestRemoveProject(id: string) {
    closeMenu();
    confirmProjectId = id;
  }
  function confirmRemoveProject() {
    if (confirmProjectId) onRemoveProject(confirmProjectId);
    confirmProjectId = null;
  }
  function cancelRemoveProject() {
    confirmProjectId = null;
  }

  const pendingThread = $derived(
    confirmThreadId ? app.threads.find((t) => t.id === confirmThreadId) : null,
  );
  const pendingProject = $derived(
    confirmProjectId ? app.projects.find((p) => p.id === confirmProjectId) : null,
  );
</script>

<svelte:window onclick={closeMenu} />

<aside
  bind:this={asideEl}
  class="relative flex h-full shrink-0 flex-col border-r border-border bg-[var(--color-surface)] {resizing
    ? 'select-none'
    : ''}"
  style:width="{settings.state.sidebarWidth}px"
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

    {#each app.sortedProjects as project (project.id)}
      {@const isSelected = app.currentProjectId === project.id}
      {@const isProjectDragged = projectDragging === project.id}
      {@const isProjectOver = projectOver === project.id && projectDragging !== project.id}
      <div
        class="mb-1.5 transition {isProjectDragged ? 'opacity-40' : ''} {isProjectOver
          ? 'border-t-2 border-t-foreground/40'
          : ''}"
        draggable={projectArmed === project.id}
        ondragstart={(e) => projectDragStart(project.id, e)}
        ondragover={(e) => projectDragOver(project.id, e)}
        ondrop={(e) => projectDrop(project.id, e)}
        ondragend={projectDragEnd}
        role="listitem"
      >
        <div
          class="group/project relative flex items-center gap-1.5 rounded-md px-1.5 py-1.5 transition {isSelected
            ? 'bg-accent/40'
            : ''}"
        >
          <span
            class="flex size-3.5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/0 transition group-hover/project:text-muted-foreground/50 active:cursor-grabbing"
            onmousedown={() => (projectArmed = project.id)}
            onmouseup={() => (projectArmed = null)}
            onmouseleave={() => (projectArmed = null)}
            role="button"
            tabindex="-1"
            aria-label="Drag project"
            title="Drag to reorder"
          >
            <GripVertical class="size-3" />
          </span>
          <div
            class="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded bg-[var(--color-surface-3)]"
          >
            {#if project.icon}
              <img
                src={project.icon}
                alt=""
                class="size-full object-cover"
                loading="lazy"
                draggable="false"
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

          <button
            type="button"
            class="rounded p-1 text-muted-foreground/0 transition hover:bg-accent hover:text-foreground group-hover/project:text-muted-foreground"
            onclick={(e) => toggleMenu(project.id, e)}
            aria-label="Project options"
            title="More"
          >
            <MoreHorizontal class="size-3" />
          </button>

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
                  requestRemoveProject(project.id);
                }}
              >
                <Trash2 class="size-3" />
                Remove project
              </button>
            </div>
          {/if}
        </div>

        {#if app.threadsByProjectSorted(project.id).length > 0}
          <ul class="ml-3 space-y-0.5 border-l border-border/60 pl-2">
            {#each app.threadsByProjectSorted(project.id) as thread (thread.id)}
              {@const isThreadDragged = threadDragging?.id === thread.id}
              {@const isThreadOver =
                threadOver === thread.id && threadDragging?.id !== thread.id}
              {@const isActive =
                app.activeThreadId === thread.id && app.view === "terminal"}
              <li
                class="group/thread"
                draggable={threadArmed === thread.id}
                ondragstart={(e) => threadDragStart(thread.id, thread.projectId, e)}
                ondragover={(e) => threadDragOver(thread.id, thread.projectId, e)}
                ondrop={(e) => threadDrop(thread.id, thread.projectId, e)}
                ondragend={threadDragEnd}
                role="listitem"
              >
                <div
                  class="flex items-center gap-1.5 rounded-md px-1.5 py-1.5 transition {isActive
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'} {isThreadDragged
                    ? 'opacity-40'
                    : ''} {isThreadOver ? 'border-t-2 border-t-foreground/40' : ''}"
                >
                  <span
                    class="flex size-3 shrink-0 cursor-grab items-center justify-center text-muted-foreground/0 transition group-hover/thread:text-muted-foreground/50 active:cursor-grabbing"
                    onmousedown={() => (threadArmed = thread.id)}
                    onmouseup={() => (threadArmed = null)}
                    onmouseleave={() => (threadArmed = null)}
                    role="button"
                    tabindex="-1"
                    aria-label="Drag thread"
                    title="Drag to reorder"
                  >
                    <GripVertical class="size-2.5" />
                  </span>
                  <StatusDot status={thread.status} />
                  <span class="relative flex size-3.5 shrink-0 items-center justify-center">
                    <span
                      class="absolute inset-0 flex items-center justify-center transition-opacity group-hover/thread:opacity-0"
                    >
                      <ShortcutIcon iconKey={thread.iconKey} size={12} />
                    </span>
                    <button
                      type="button"
                      class="absolute inset-0 flex items-center justify-center rounded text-muted-foreground/70 opacity-0 transition hover:bg-danger/20 hover:text-danger group-hover/thread:opacity-100"
                      onclick={(e) => {
                        e.stopPropagation();
                        requestRemoveThread(thread.id);
                      }}
                      aria-label="Close {thread.label}"
                      title="Close thread"
                    >
                      <X class="size-3" />
                    </button>
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
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  </div>

  <button
    type="button"
    class="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition hover:bg-foreground/10"
    onmousedown={startResize}
    aria-label="Resize sidebar"
    title="Resize sidebar"
    tabindex="-1"
  ></button>
</aside>

<ConfirmDialog
  open={pendingThread !== null}
  title="Close thread?"
  message={pendingThread
    ? `Close ${pendingThread.title ?? pendingThread.label}? Running process will be killed.`
    : ""}
  confirmLabel="Close thread"
  danger
  onConfirm={confirmRemoveThread}
  onCancel={cancelRemoveThread}
/>

<ConfirmDialog
  open={pendingProject !== null}
  title="Remove project?"
  message={pendingProject
    ? `Remove ${pendingProject.name}? All its threads will be killed and dropped.`
    : ""}
  confirmLabel="Remove project"
  danger
  onConfirm={confirmRemoveProject}
  onCancel={cancelRemoveProject}
/>
