<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { explorerStore, normalizePath } from "./store.svelte";
  import TreeNode from "./TreeNode.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";

  const AUTO_REFRESH_MS = 3000;

  const project = $derived(
    app.currentProjectId
      ? app.projects.find((p) => p.id === app.currentProjectId) ?? null
      : null,
  );

  const root = $derived(project ? normalizePath(project.cwd) : null);
  const entries = $derived(root ? explorerStore.entriesByPath[root] ?? null : null);
  const err = $derived(root ? explorerStore.errorByPath[root] ?? null : null);
  const filterActive = $derived(explorerStore.filterText.trim().length > 0);
  const hitCount = $derived(explorerStore.searchHits.length);
  const truncated = $derived(explorerStore.searchTruncated);
  const searching = $derived(explorerStore.searching);

  let filterInput = $state<HTMLInputElement | null>(null);
  let treeEl = $state<HTMLElement | null>(null);
  let manualRefreshing = $state(false);

  $effect(() => {
    if (root) {
      void explorerStore.load(root);
      void explorerStore.loadGitStatus(root);
    }
  });

  $effect(() => {
    if (!root) return;
    const r = root;
    const poke = () => {
      if (document.hidden) return;
      void explorerStore.refresh(r);
    };
    const interval = window.setInterval(poke, AUTO_REFRESH_MS);
    window.addEventListener("focus", poke);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", poke);
    };
  });

  async function refresh() {
    if (!root || manualRefreshing) return;
    manualRefreshing = true;
    try {
      await explorerStore.refresh(root);
    } finally {
      manualRefreshing = false;
    }
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

  function treeRows(): HTMLButtonElement[] {
    if (!treeEl) return [];
    return Array.from(
      treeEl.querySelectorAll<HTMLButtonElement>("[data-tree-row]"),
    );
  }

  function onTreeKeydown(e: KeyboardEvent) {
    const rows = treeRows();
    if (rows.length === 0) return;
    const active = document.activeElement;
    const idx =
      active instanceof HTMLButtonElement ? rows.indexOf(active) : -1;
    const current = idx >= 0 ? rows[idx] : null;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      rows[Math.min(idx + 1, rows.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      rows[Math.max(idx - 1, 0)]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      rows[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      rows[rows.length - 1]?.focus();
    } else if (e.key === "ArrowRight" && current) {
      const path = current.dataset.path;
      if (!path) return;
      e.preventDefault();
      if (current.dataset.dir === "1" && !explorerStore.expanded[path]) {
        void explorerStore.toggle(path);
      } else {
        rows[Math.min(idx + 1, rows.length - 1)]?.focus();
      }
    } else if (e.key === "ArrowLeft" && current) {
      const path = current.dataset.path;
      if (!path) return;
      e.preventDefault();
      if (current.dataset.dir === "1" && explorerStore.expanded[path]) {
        void explorerStore.toggle(path);
        return;
      }
      const parent = path.slice(0, path.lastIndexOf("/"));
      rows.find((r) => r.dataset.path === parent)?.focus();
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
      disabled={!root || manualRefreshing}
      title="Refresh"
      aria-label="Refresh"
    >
      <RefreshCw class="size-3.5 {manualRefreshing ? 'animate-spin' : ''}" />
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
        {:else if truncated}
          {hitCount}+ matches — narrow the filter to see them all.
        {:else if hitCount === 1}
          1 match.
        {:else}
          {hitCount} matches.
        {/if}
      </div>
    {/if}
  </div>

  <div
    bind:this={treeEl}
    class="min-h-0 flex-1 overflow-auto py-1"
    role="tree"
    tabindex="-1"
    onkeydown={onTreeKeydown}
  >
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
