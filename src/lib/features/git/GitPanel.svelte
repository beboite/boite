<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { gitStore } from "./store.svelte";
  import GitGraph from "./GitGraph.svelte";
  import type { ChangeEntry } from "./api";
  import CloudDownload from "@lucide/svelte/icons/cloud-download";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Plus from "@lucide/svelte/icons/plus";
  import Minus from "@lucide/svelte/icons/minus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";

  const AUTO_REFRESH_MS = 3000;

  type SectionMode = "staged" | "unstaged" | "conflict";
  interface SectionArgs {
    label: string;
    entries: ChangeEntry[];
    mode: SectionMode;
    open: boolean;
    toggle: () => void;
  }

  const project = $derived(
    app.currentProjectId
      ? app.projects.find((p) => p.id === app.currentProjectId) ?? null
      : null,
  );

  let panelEl: HTMLElement | null = $state(null);
  let bodyEl: HTMLElement | null = $state(null);
  let resizingX = $state(false);
  let resizingY = $state(false);

  $effect(() => {
    if (!project) return;
    gitStore.ensure(project.id, project.cwd);
    void gitStore.refresh(project.id);
  });

  $effect(() => {
    if (!project) return;
    const id = project.id;
    const tick = () => {
      if (!document.hidden) void gitStore.refresh(id);
    };
    const interval = window.setInterval(tick, AUTO_REFRESH_MS);
    const onFocus = () => void gitStore.refresh(id);
    const onVisibility = () => {
      if (!document.hidden) void gitStore.refresh(id);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });

  const gs = $derived(project ? gitStore.get(project.id) : null);

  let stagedOpen = $state(true);
  let changesOpen = $state(true);
  let conflictsOpen = $state(true);

  const totalChanges = $derived(
    gs ? gs.staged.length + gs.unstaged.length + gs.conflicts.length : 0,
  );
  const topPercent = $derived(settings.state.gitSplitFraction * 100);

  function fetch() {
    if (project) void gitStore.fetch(project.id);
  }

  function commitKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      doCommit();
    }
  }

  function doCommit() {
    if (project) void gitStore.commit(project.id);
  }

  function startResizeX(e: MouseEvent) {
    e.preventDefault();
    resizingX = true;
    document.addEventListener("mousemove", onResizeX);
    document.addEventListener("mouseup", stopResizeX);
  }
  function onResizeX(e: MouseEvent) {
    if (!panelEl) return;
    const rect = panelEl.getBoundingClientRect();
    settings.setGitPanelWidth(rect.right - e.clientX);
  }
  function stopResizeX() {
    resizingX = false;
    document.removeEventListener("mousemove", onResizeX);
    document.removeEventListener("mouseup", stopResizeX);
  }

  function startResizeY(e: MouseEvent) {
    e.preventDefault();
    resizingY = true;
    document.addEventListener("mousemove", onResizeY);
    document.addEventListener("mouseup", stopResizeY);
  }
  function onResizeY(e: MouseEvent) {
    if (!bodyEl) return;
    const rect = bodyEl.getBoundingClientRect();
    if (rect.height <= 0) return;
    const fraction = (e.clientY - rect.top) / rect.height;
    settings.setGitSplitFraction(fraction);
  }
  function stopResizeY() {
    resizingY = false;
    document.removeEventListener("mousemove", onResizeY);
    document.removeEventListener("mouseup", stopResizeY);
  }

  function statusColor(s: string): string {
    if (s === "M") return "text-[var(--color-warning)]";
    if (s === "A") return "text-[var(--color-success)]";
    if (s === "D") return "text-[var(--color-danger)]";
    if (s === "R") return "text-[var(--color-success)]";
    if (s === "?") return "text-muted-foreground";
    if (s === "U") return "text-[var(--color-danger)]";
    return "text-muted-foreground";
  }

  function basename(path: string): string {
    const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return idx >= 0 ? path.slice(idx + 1) : path;
  }

  function dirname(path: string): string {
    const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return idx >= 0 ? path.slice(0, idx) : "";
  }

  function stagePaths(files: string[]) {
    if (project) void gitStore.stage(project.id, files);
  }
  function unstagePaths(files: string[]) {
    if (project) void gitStore.unstage(project.id, files);
  }
  function discardPath(path: string) {
    if (!project) return;
    if (confirm(`Discard changes to ${path}?\nThis cannot be undone.`)) {
      void gitStore.discard(project.id, [path]);
    }
  }
</script>

<aside
  bind:this={panelEl}
  class="relative flex h-full shrink-0 flex-col border-l border-border bg-[var(--color-surface)] {resizingX ||
  resizingY
    ? 'select-none'
    : ''}"
  style:width="{settings.state.gitPanelWidth}px"
>
  <header
    class="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3"
  >
    <GitBranch class="size-4 text-muted-foreground" />
    {#if gs?.isRepo}
      <span class="truncate text-xs font-medium text-foreground/90">
        {gs.branch ?? "(detached)"}
      </span>
      {#if gs.ahead > 0}
        <span
          class="flex items-center gap-0.5 text-[10.5px] text-muted-foreground"
        >
          <ArrowUp class="size-3" />{gs.ahead}
        </span>
      {/if}
      {#if gs.behind > 0}
        <span
          class="flex items-center gap-0.5 text-[10.5px] text-muted-foreground"
        >
          <ArrowDown class="size-3" />{gs.behind}
        </span>
      {/if}
    {:else}
      <span class="truncate text-xs text-muted-foreground">Not a git repo</span>
    {/if}
    <button
      type="button"
      class="ml-auto rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
      onclick={fetch}
      disabled={!project || gs?.fetching}
      title="Fetch from remote"
      aria-label="Fetch from remote"
    >
      <CloudDownload class="size-3.5 {gs?.fetching ? 'animate-pulse' : ''}" />
    </button>
  </header>

  {#if !project}
    <div
      class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground"
    >
      Pick a project.
    </div>
  {:else if !gs?.isRepo}
    <div
      class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground"
    >
      This folder is not a git repository.
    </div>
  {:else}
    <div bind:this={bodyEl} class="flex min-h-0 flex-1 flex-col">
      <!-- Changes (top) -->
      <section
        class="flex min-h-0 flex-col"
        style:flex="0 0 {topPercent}%"
      >
        <div
          class="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-3"
        >
          <span
            class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Changes
          </span>
          {#if totalChanges > 0}
            <span
              class="rounded-full bg-[var(--color-surface-2)] px-1.5 text-[10px] text-foreground/75"
            >
              {totalChanges}
            </span>
          {/if}
        </div>

        <div class="shrink-0 border-b border-border p-2">
          <textarea
            class="w-full resize-none rounded-md border border-border bg-[var(--color-background)] px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
            rows="2"
            placeholder="Commit message  (Ctrl+Enter)"
            bind:value={gs.message}
            onkeydown={commitKey}
            disabled={gs.committing}
          ></textarea>
          <button
            type="button"
            class="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 text-xs font-medium text-foreground/85 transition hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onclick={doCommit}
            disabled={gs.committing ||
              gs.staged.length === 0 ||
              !gs.message.trim()}
          >
            Commit ({gs.staged.length})
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto">
          {#if gs.conflicts.length > 0}
            {@render section({
              label: "Merge changes",
              entries: gs.conflicts,
              mode: "conflict",
              open: conflictsOpen,
              toggle: () => (conflictsOpen = !conflictsOpen),
            })}
          {/if}
          {#if gs.staged.length > 0}
            {@render section({
              label: "Staged",
              entries: gs.staged,
              mode: "staged",
              open: stagedOpen,
              toggle: () => (stagedOpen = !stagedOpen),
            })}
          {/if}
          {#if gs.unstaged.length > 0}
            {@render section({
              label: "Changes",
              entries: gs.unstaged,
              mode: "unstaged",
              open: changesOpen,
              toggle: () => (changesOpen = !changesOpen),
            })}
          {/if}
          {#if totalChanges === 0}
            <div
              class="px-3 py-4 text-center text-[11px] text-muted-foreground/70"
            >
              Working tree clean.
            </div>
          {/if}
        </div>
      </section>

      <!-- Splitter -->
      <button
        type="button"
        onmousedown={startResizeY}
        class="relative h-1 shrink-0 cursor-row-resize bg-transparent transition hover:bg-foreground/10"
        aria-label="Resize sections"
        tabindex="-1"
      ></button>

      <!-- Commits (bottom) -->
      <section class="flex min-h-0 flex-1 flex-col border-t border-border">
        <div
          class="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-3"
        >
          <span
            class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Commits
          </span>
          {#if gs.log.length > 0}
            <span
              class="rounded-full bg-[var(--color-surface-2)] px-1.5 text-[10px] text-foreground/75"
            >
              {gs.log.length}
            </span>
          {/if}
        </div>
        <div class="min-h-0 flex-1 overflow-auto">
          {#if gs.log.length === 0}
            <div
              class="px-3 py-4 text-center text-[11px] text-muted-foreground/70"
            >
              No commits.
            </div>
          {:else}
            <GitGraph commits={gs.log} />
          {/if}
        </div>
      </section>
    </div>
  {/if}

  <button
    type="button"
    class="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition hover:bg-foreground/10"
    onmousedown={startResizeX}
    aria-label="Resize git panel"
    tabindex="-1"
  ></button>
</aside>

{#snippet section({ label, entries, mode, open, toggle }: SectionArgs)}
  <div class="flex flex-col">
    <div class="flex items-center gap-1 px-2 py-1">
      <button
        type="button"
        class="flex flex-1 items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition hover:text-foreground"
        onclick={toggle}
      >
        <ChevronDown class="size-3 transition {open ? '' : '-rotate-90'}" />
        <span>{label}</span>
        <span class="text-muted-foreground/50">{entries.length}</span>
      </button>
      {#if mode === "staged"}
        <button
          type="button"
          class="rounded p-0.5 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          title="Unstage all"
          aria-label="Unstage all"
          onclick={() => unstagePaths(entries.map((x) => x.path))}
        >
          <Minus class="size-3" />
        </button>
      {:else if mode === "unstaged"}
        <button
          type="button"
          class="rounded p-0.5 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          title="Stage all"
          aria-label="Stage all"
          onclick={() => stagePaths(entries.map((x) => x.path))}
        >
          <Plus class="size-3" />
        </button>
      {/if}
    </div>
    {#if open}
      {#each entries as entry (entry.path + ":" + entry.staged + ":" + entry.conflicted)}
        <div
          class="group/row flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-[var(--color-surface-2)]"
          title={entry.path}
        >
          <span class="min-w-0 flex-1 truncate text-foreground/85">
            {basename(entry.path)}
            {#if dirname(entry.path)}
              <span class="ml-1 text-muted-foreground/55"
                >{dirname(entry.path)}</span
              >
            {/if}
          </span>
          <div
            class="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover/row:opacity-100"
          >
            {#if mode === "staged"}
              <button
                type="button"
                class="rounded p-0.5 text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground"
                title="Unstage"
                aria-label="Unstage file"
                onclick={() => unstagePaths([entry.path])}
              >
                <Minus class="size-3" />
              </button>
            {:else if mode === "unstaged"}
              <button
                type="button"
                class="rounded p-0.5 text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground"
                title="Discard"
                aria-label="Discard file"
                onclick={() => discardPath(entry.path)}
              >
                <Trash2 class="size-3" />
              </button>
              <button
                type="button"
                class="rounded p-0.5 text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground"
                title="Stage"
                aria-label="Stage file"
                onclick={() => stagePaths([entry.path])}
              >
                <Plus class="size-3" />
              </button>
            {/if}
          </div>
          <span
            class="w-3 shrink-0 text-center font-mono text-[10.5px] {statusColor(
              entry.status,
            )}"
          >
            {entry.status}
          </span>
        </div>
      {/each}
    {/if}
  </div>
{/snippet}
