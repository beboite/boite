<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { resizeHandle } from "$lib/shared/actions/resizeHandle";
  import GitPanel from "$lib/features/git/GitPanel.svelte";
  import ExplorerPanel from "$lib/features/explorer/ExplorerPanel.svelte";
  import TodoPanel from "$lib/features/todo/TodoPanel.svelte";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import X from "@lucide/svelte/icons/x";

  let panelEl: HTMLElement | null = $state(null);
  let resizingX = $state(false);

  function onResizeX(e: PointerEvent) {
    if (!panelEl) return;
    const rect = panelEl.getBoundingClientRect();
    settings.setRightPanelWidth(rect.right - e.clientX);
  }

  function selectTab(tab: "git" | "explorer" | "todo") {
    void settings.setRightPanel(tab);
  }

  function close() {
    void settings.setRightPanel(null);
  }
</script>

<aside
  bind:this={panelEl}
  class="relative flex h-full shrink-0 flex-col border-l border-border bg-[var(--color-surface)] {resizingX ? 'select-none' : ''}"
  style:width="{settings.state.rightPanelWidth}px"
>
  <div class="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-[var(--color-titlebar)] px-1.5">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition {settings.state.rightPanel === 'git' ? 'bg-[var(--color-surface-2)] text-foreground' : 'text-muted-foreground hover:text-foreground'}"
      onclick={() => selectTab("git")}
      aria-pressed={settings.state.rightPanel === "git"}
    >
      <GitBranch class="size-3.5" />
      <span>Git</span>
    </button>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition {settings.state.rightPanel === 'explorer' ? 'bg-[var(--color-surface-2)] text-foreground' : 'text-muted-foreground hover:text-foreground'}"
      onclick={() => selectTab("explorer")}
      aria-pressed={settings.state.rightPanel === "explorer"}
    >
      <FolderTree class="size-3.5" />
      <span>Files</span>
    </button>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition {settings.state.rightPanel === 'todo' ? 'bg-[var(--color-surface-2)] text-foreground' : 'text-muted-foreground hover:text-foreground'}"
      onclick={() => selectTab("todo")}
      aria-pressed={settings.state.rightPanel === "todo"}
    >
      <ListTodo class="size-3.5" />
      <span>Todo</span>
    </button>
    <button
      type="button"
      class="ml-auto rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
      onclick={close}
      title="Close panel"
      aria-label="Close panel"
    >
      <X class="size-3.5" />
    </button>
  </div>

  <div class="min-h-0 min-w-0 flex-1">
    {#if settings.state.rightPanel === "git"}
      <GitPanel />
    {:else if settings.state.rightPanel === "explorer"}
      <ExplorerPanel />
    {:else if settings.state.rightPanel === "todo"}
      <TodoPanel />
    {/if}
  </div>

  <button
    type="button"
    class="absolute -left-px top-0 z-10 h-full w-1 cursor-col-resize transition hover:bg-foreground/10 after:absolute after:inset-y-0 after:-inset-x-1.5 after:content-[''] {resizingX ? 'bg-foreground/20' : 'bg-transparent'}"
    use:resizeHandle={{
      onResize: onResizeX,
      onStateChange: (r) => (resizingX = r),
    }}
    aria-label="Resize panel"
    tabindex="-1"
  ></button>
</aside>
