<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { explorerStore } from "./store.svelte";
  import TreeNode from "./TreeNode.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";

  const project = $derived(
    app.currentProjectId
      ? app.projects.find((p) => p.id === app.currentProjectId) ?? null
      : null,
  );

  const root = $derived(project?.cwd ?? null);
  const entries = $derived(root ? explorerStore.entriesByPath[root] ?? null : null);
  const loading = $derived(root ? !!explorerStore.loading[root] : false);
  const err = $derived(root ? explorerStore.errorByPath[root] ?? null : null);
  const filterActive = $derived(explorerStore.filterText.trim().length > 0);
  const hitCount = $derived(explorerStore.searchHits.length);
  const searching = $derived(explorerStore.searching);

  let filterInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (root) {
      void explorerStore.load(root);
      void explorerStore.loadGitStatus(root);
    }
  });

  function refresh() {
    if (root) void explorerStore.refresh(root);
  }

  function collapseAll() {
    explorerStore.collapseAll();
  }

  function onFilterInput(e: Event) {
    const value = (e.currentTarget as HTMLInputElement).value;
    explorerStore.setFilter(value, root);
  }

  function clearFilter() {
    explorerStore.clearFilter();
    filterInput?.focus();
  }

  function onFilterKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      clearFilter();
    }
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

  <div class="shrink-0 border-b border-border px-2 py-1.5">
    <div
      class="flex items-center gap-1.5 rounded bg-[var(--color-surface)] px-2 py-1 text-[11.5px] focus-within:bg-[var(--color-surface-2)]"
    >
      <Search class="size-3 shrink-0 text-muted-foreground/70" />
      <input
        bind:this={filterInput}
        type="text"
        placeholder="Filter files…"
        value={explorerStore.filterText}
        oninput={onFilterInput}
        onkeydown={onFilterKey}
        disabled={!root}
        class="min-w-0 flex-1 bg-transparent text-foreground/90 outline-none placeholder:text-muted-foreground/60 disabled:opacity-40"
      />
      {#if filterActive}
        <button
          type="button"
          class="shrink-0 rounded p-0.5 text-muted-foreground/70 transition hover:bg-[var(--color-surface-3)] hover:text-foreground"
          onclick={clearFilter}
          title="Clear filter (Esc)"
          aria-label="Clear filter"
        >
          <X class="size-3" />
        </button>
      {/if}
    </div>
    {#if filterActive}
      <div class="mt-1 px-1 text-[10px] text-muted-foreground/70">
        {#if searching}
          Searching…
        {:else if hitCount === 0}
          No matches.
        {:else if hitCount === 1}
          1 match.
        {:else}
          {hitCount} matches.
        {/if}
      </div>
    {/if}
  </div>

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
