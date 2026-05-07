<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { explorerStore } from "./store.svelte";
  import TreeNode from "./TreeNode.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
  import FolderTree from "@lucide/svelte/icons/folder-tree";

  const project = $derived(
    app.currentProjectId
      ? app.projects.find((p) => p.id === app.currentProjectId) ?? null
      : null,
  );

  const root = $derived(project?.cwd ?? null);
  const entries = $derived(root ? explorerStore.entriesByPath[root] ?? null : null);
  const loading = $derived(root ? !!explorerStore.loading[root] : false);
  const err = $derived(root ? explorerStore.errorByPath[root] ?? null : null);

  $effect(() => {
    if (root) void explorerStore.load(root);
  });

  function refresh() {
    if (root) void explorerStore.refresh(root);
  }

  function collapseAll() {
    explorerStore.collapseAll();
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
    <FolderTree class="size-4 text-muted-foreground" />
    {#if project}
      <span class="truncate text-xs font-medium text-foreground/90">
        {project.name}
      </span>
    {:else}
      <span class="truncate text-xs text-muted-foreground">No project</span>
    {/if}
    <button
      type="button"
      class="ml-auto rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
      onclick={collapseAll}
      disabled={!root}
      title="Collapse all"
      aria-label="Collapse all"
    >
      <ChevronsDownUp class="size-3.5" />
    </button>
    <button
      type="button"
      class="rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
      onclick={refresh}
      disabled={!root || loading}
      title="Refresh"
      aria-label="Refresh"
    >
      <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
    </button>
  </header>

  <div class="min-h-0 flex-1 overflow-auto py-1">
    {#if !project}
      <div class="px-3 py-4 text-center text-[11px] text-muted-foreground/70">
        Pick a project.
      </div>
    {:else if err && !entries}
      <div class="px-3 py-4 text-center text-[11px] text-[var(--color-danger)]">
        {err}
      </div>
    {:else if !entries}
      <div class="px-3 py-4 text-center text-[11px] text-muted-foreground/70">
        Loading…
      </div>
    {:else if entries.length === 0}
      <div class="px-3 py-4 text-center text-[11px] text-muted-foreground/70">
        Empty folder.
      </div>
    {:else}
      {#each entries as entry (entry.path)}
        <TreeNode {entry} depth={0} />
      {/each}
    {/if}
  </div>
</div>
