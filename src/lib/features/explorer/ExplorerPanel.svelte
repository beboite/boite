<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { t } from "$lib/i18n/index.svelte";
  import { scrollIntoViewSmooth } from "$lib/theme/motion";
  import { projectDisplayName } from "$lib/shared/project-label";
  import { workspace } from "$lib/backend";
  import { settings } from "$lib/features/settings/store.svelte";
  import { threadCwd } from "$lib/features/thread/cwd";
  import { onDestroy } from "svelte";
  import { explorerStore, normalizePath } from "./store.svelte";
  import { treeMenu } from "./treeMenu.svelte";
  import TreeNode, { provideTreeCursor, treeRowId } from "./TreeNode.svelte";
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import PanelDockActions from "$lib/features/panes/PanelDockActions.svelte";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";

  const AUTO_REFRESH_MS = 10_000;

  // The pane's project when it has one, the selected project otherwise: the
  // mobile tab has no pane around it.
  // The column's close action, passed only by SidePanel: see PanelDockActions.
  type Props = {
    projectId?: string | null;
    onClose?: () => void;
  };
  let { projectId = null, onClose }: Props = $props();

  const project = $derived.by(() => {
    const id = projectId ?? app.currentProjectId;
    return id ? app.projects.find((p) => p.id === id) ?? null : null;
  });

  // Follows the active thread into its worktree: the point of the tree is to
  // show what the agent on screen is actually looking at. Entries are cached
  // by path, so switching roots costs nothing and switching back is instant.
  const threadHere = $derived(
    app.activeThread && app.activeThread.projectId === project?.id ? app.activeThread : null,
  );
  const root = $derived.by(() => {
    const dir = threadCwd(threadHere, project);
    return dir ? normalizePath(dir) : null;
  });
  const entries = $derived(root ? explorerStore.entriesByPath[root] ?? null : null);
  const err = $derived(root ? explorerStore.errorByPath[root] ?? null : null);
  const filterActive = $derived(explorerStore.filterText.trim().length > 0);
  const hitCount = $derived(explorerStore.searchHits.length);
  const truncated = $derived(explorerStore.searchTruncated);
  const searching = $derived(explorerStore.searching);

  let filterInput = $state<HTMLInputElement | null>(null);
  let treeEl = $state<HTMLElement | null>(null);
  let manualRefreshing = $state(false);

  /**
   * The tree is one tab stop that names its current row through
   * aria-activedescendant, rather than a roving tabindex over the rows.
   *
   * Rows come and go under a filter, a collapse and the 10s refresh, and a
   * roving tabindex living on one of them means the whole tree loses its tab
   * stop the moment that row unmounts. The container cannot unmount.
   */
  let activePath = $state<string | null>(null);
  let treeFocused = $state(false);

  provideTreeCursor({
    get activePath() {
      return activePath;
    },
    get focused() {
      return treeFocused;
    },
    setActive(path: string) {
      activePath = path;
      // One focus story: a click lands DOM focus on the row's button, and from
      // there the container's keydown handler would be navigating a cursor the
      // browser no longer agrees with.
      treeEl?.focus();
    },
  });

  // A filter, a collapse or a vanished directory retires rows, and an
  // aria-activedescendant naming a row that is no longer in the DOM is a
  // dangling reference.
  $effect(() => {
    void entries;
    void explorerStore.filterText;
    void Object.keys(explorerStore.expanded).length;
    if (activePath && !rowFor(activePath)) activePath = null;
  });

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
      // Don't queue directory reads against a dropped remote socket.
      const remoteScoped =
        workspace.mode === "remote" ||
        (workspace.isDynamic && project?.origin === "remote");
      if (remoteScoped && workspace.connection !== "connected") return;
      void explorerStore.refresh(r);
    };
    const periodMs = settings.state.mobileLayout ? 20_000 : AUTO_REFRESH_MS;
    const interval = window.setInterval(poke, periodMs);
    window.addEventListener("focus", poke);
    document.addEventListener("visibilitychange", poke);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", poke);
      document.removeEventListener("visibilitychange", poke);
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
      return;
    }
    // Filtering and then walking the hits is the whole point of the box, and Tab
    // from here is a long way round to the first row.
    if (e.key === "ArrowDown") {
      e.preventDefault();
      treeEl?.focus();
    }
  }

  function treeRows(): HTMLElement[] {
    if (!treeEl) return [];
    return Array.from(treeEl.querySelectorAll<HTMLElement>("[data-tree-row]"));
  }

  function rowFor(path: string): HTMLElement | null {
    return treeEl?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`) ?? null;
  }

  /** Move the cursor and keep it on screen: nothing scrolls a row into view for
   *  us now that the rows never take DOM focus. */
  function moveTo(rows: HTMLElement[], index: number) {
    const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    const path = row?.dataset.path;
    if (!path) return;
    activePath = path;
    scrollIntoViewSmooth(row);
  }

  function cursorIndex(rows: HTMLElement[]): number {
    return activePath ? rows.findIndex((r) => r.dataset.path === activePath) : -1;
  }

  // A repo-sized tree is hundreds of rows deep, and arrows alone walk it one row
  // at a time. Buffer lifetime is the usual tree convention: a pause ends the
  // prefix, so the next letter starts a new search instead of extending a stale
  // one.
  const TYPE_AHEAD_MS = 800;
  let typeBuffer = "";
  let typeTimer: number | null = null;

  function resetTypeAhead() {
    if (typeTimer !== null) window.clearTimeout(typeTimer);
    typeTimer = window.setTimeout(() => {
      typeTimer = null;
      typeBuffer = "";
    }, TYPE_AHEAD_MS);
  }

  function typeAhead(rows: HTMLElement[], char: string) {
    // One letter pressed again walks its matches; anything else narrows the
    // prefix and searches from where the cursor already is.
    const cycling = typeBuffer.length === 1 && typeBuffer === char;
    typeBuffer = cycling ? char : typeBuffer + char;
    resetTypeAhead();
    const at = cursorIndex(rows);
    const from = typeBuffer.length === 1 ? at + 1 : Math.max(at, 0);
    for (let k = 0; k < rows.length; k++) {
      const idx = (from + k + rows.length) % rows.length;
      const name = rows[idx].dataset.name?.toLowerCase() ?? "";
      if (name.startsWith(typeBuffer)) {
        moveTo(rows, idx);
        return;
      }
    }
  }

  function onTreeFocusIn() {
    treeFocused = true;
    const rows = treeRows();
    if (rows.length === 0) return;
    // Entering the tree has to land somewhere, or the first arrow press would be
    // the one that picks a row and nothing would say where it started.
    if (!activePath || !rows.some((r) => r.dataset.path === activePath)) {
      activePath = rows[0].dataset.path ?? null;
    }
  }

  function onTreeFocusOut(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && treeEl?.contains(next)) return;
    treeFocused = false;
    typeBuffer = "";
  }

  function onTreeKeydown(e: KeyboardEvent) {
    const rows = treeRows();
    if (rows.length === 0) return;
    const idx = cursorIndex(rows);
    const current = idx >= 0 ? rows[idx] : null;
    const path = current?.dataset.path ?? null;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveTo(rows, idx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveTo(rows, idx < 0 ? 0 : idx - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveTo(rows, 0);
    } else if (e.key === "End") {
      e.preventDefault();
      moveTo(rows, rows.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      if (!current) return;
      // Space on a scroll container is page-down; here it is the row's activate.
      e.preventDefault();
      current.click();
    } else if (e.key === "ArrowRight" && path) {
      e.preventDefault();
      if (current?.dataset.dir === "1" && !explorerStore.expanded[path]) {
        void explorerStore.toggle(path);
      } else {
        moveTo(rows, idx + 1);
      }
    } else if (e.key === "ArrowLeft" && path) {
      e.preventDefault();
      if (current?.dataset.dir === "1" && explorerStore.expanded[path]) {
        void explorerStore.toggle(path);
        return;
      }
      const parent = path.slice(0, path.lastIndexOf("/"));
      const parentIdx = rows.findIndex((r) => r.dataset.path === parent);
      if (parentIdx >= 0) moveTo(rows, parentIdx);
    } else if (
      e.key.length === 1 &&
      e.key !== " " &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      // Never swallowed from a modifier combo: the app's global dispatcher owns
      // those and the filter box is one of the things they open.
      e.preventDefault();
      typeAhead(rows, e.key.toLowerCase());
    }
  }

  onDestroy(() => {
    if (typeTimer !== null) window.clearTimeout(typeTimer);
  });
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
    <FolderTree class="size-4 text-muted-foreground" />
    {#if project}
      <span class="truncate text-xs font-medium text-foreground">
        {projectDisplayName(project)}
      </span>
    {:else}
      <span class="truncate text-xs text-muted-foreground">
        {t("explorer.noProject")}
      </span>
    {/if}
    <button
      type="button"
      class="ml-auto rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
      onclick={collapseAll}
      disabled={!root}
      use:tip={t("explorer.collapseAll")}
      aria-label={t("explorer.collapseAll")}
    >
      <ChevronsDownUp class="size-3.5" />
    </button>
    <button
      type="button"
      class="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
      onclick={refresh}
      disabled={!root || manualRefreshing}
      use:tip={t("explorer.refresh")}
      aria-label={t("explorer.refresh")}
    >
      <RefreshCw class="size-3.5 {manualRefreshing ? 'animate-spin' : ''}" />
    </button>
    {#if onClose}
      <PanelDockActions {onClose} />
    {/if}
  </header>

  <div class="shrink-0 border-b border-border px-2 py-1.5">
    <div
      class="flex items-center gap-1.5 rounded bg-[var(--color-surface)] px-2 py-1 text-sm focus-within:bg-[var(--color-surface-2)]"
    >
      <Search class="size-3 shrink-0 text-muted-2" />
      <input
        bind:this={filterInput}
        type="text"
        placeholder={t("explorer.filterPlaceholder")}
        value={explorerStore.filterText}
        oninput={onFilterInput}
        onkeydown={onFilterKey}
        disabled={!root}
        class="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-2 disabled:opacity-40"
      />
      {#if filterActive}
        <button
          type="button"
          class="shrink-0 rounded p-0.5 text-muted-2 transition hover:bg-accent hover:text-foreground"
          onclick={clearFilter}
          use:tip={t("explorer.clearFilterTitle")}
          aria-label={t("explorer.clearFilter")}
        >
          <X class="size-3" />
        </button>
      {/if}
    </div>
    {#if filterActive}
      <div class="mt-1 px-1 text-2xs text-muted-2">
        {#if searching}
          {t("explorer.searching")}
        {:else if hitCount === 0}
          {t("explorer.noMatches")}
        {:else if truncated}
          {t("explorer.matchesTruncated", { count: hitCount })}
        {:else if hitCount === 1}
          {t("explorer.matchOne")}
        {:else}
          {t("explorer.matchMany", { count: hitCount })}
        {/if}
      </div>
    {/if}
  </div>

  <div
    bind:this={treeEl}
    class="min-h-0 flex-1 overflow-auto py-1"
    role="tree"
    aria-label={t("explorer.fileTree")}
    aria-activedescendant={activePath ? treeRowId(activePath) : undefined}
    tabindex="0"
    onkeydown={onTreeKeydown}
    onfocusin={onTreeFocusIn}
    onfocusout={onTreeFocusOut}
  >
    {#if !project}
      <div class="px-3 py-4 text-center text-xs text-muted-2">
        {t("explorer.pickProject")}
      </div>
    {:else if err && !entries}
      <div class="px-3 py-4 text-center text-xs text-[var(--color-danger)]">
        {err}
      </div>
    {:else if !entries}
      <!-- Rows rather than the word "Loading": a tree that arrives in one frame
           after a blank panel reads as a jump, and one that arrives over its own
           outline reads as the tree it already looked like. -->
      <div class="flex flex-col gap-1.5 px-3 py-2" aria-hidden="true">
        {#each [70, 52, 61, 44, 66, 38] as width, i (i)}
          <div class="skeleton h-3" style:width="{width}%"></div>
        {/each}
      </div>
      <!-- The skeleton is decoration and hidden from the tree, so this is the
           only thing left to say the rows are still coming. -->
      <span class="sr-only">{t("common.loading")}</span>
    {:else if entries.length === 0}
      <div class="px-3 py-4 text-center text-xs text-muted-2">
        {t("explorer.emptyFolder")}
      </div>
    {:else}
      {#each entries as entry (entry.path)}
        <TreeNode {entry} depth={0} />
      {/each}
    {/if}
  </div>
</div>

{#if treeMenu.menu}
  <ContextMenu
    items={treeMenu.menu.items}
    x={treeMenu.menu.x}
    y={treeMenu.menu.y}
    onClose={() => treeMenu.close()}
  />
{/if}
