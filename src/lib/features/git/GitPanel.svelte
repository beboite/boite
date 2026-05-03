<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { gitStore } from "./store.svelte";
  import type { ChangeEntry } from "./api";

  type SectionMode = "staged" | "unstaged" | "conflict";
  interface SectionArgs {
    label: string;
    count: number;
    entries: ChangeEntry[];
    mode: SectionMode;
    open: boolean;
    toggle: () => void;
  }
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import GitCommit from "@lucide/svelte/icons/git-commit-horizontal";
  import Plus from "@lucide/svelte/icons/plus";
  import Minus from "@lucide/svelte/icons/minus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";

  const project = $derived(
    app.currentProjectId
      ? app.projects.find((p) => p.id === app.currentProjectId) ?? null
      : null,
  );

  let panelEl: HTMLElement | null = $state(null);
  let resizing = $state(false);

  $effect(() => {
    if (!project) return;
    gitStore.ensure(project.id, project.cwd);
    void gitStore.refresh(project.id);
  });

  const gs = $derived(project ? gitStore.get(project.id) : null);

  let stagedOpen = $state(true);
  let changesOpen = $state(true);
  let conflictsOpen = $state(true);
  let logOpen = $state(true);

  function refresh() {
    if (project) void gitStore.refresh(project.id);
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

  function startResize(e: MouseEvent) {
    e.preventDefault();
    resizing = true;
    document.addEventListener("mousemove", onResize);
    document.addEventListener("mouseup", stopResize);
  }
  function onResize(e: MouseEvent) {
    if (!panelEl) return;
    const rect = panelEl.getBoundingClientRect();
    const next = rect.right - e.clientX;
    settings.setGitPanelWidth(next);
  }
  function stopResize() {
    resizing = false;
    document.removeEventListener("mousemove", onResize);
    document.removeEventListener("mouseup", stopResize);
  }

  function statusColor(s: string): string {
    if (s === "M") return "text-amber-400";
    if (s === "A") return "text-emerald-400";
    if (s === "D") return "text-red-400";
    if (s === "R") return "text-sky-400";
    if (s === "?") return "text-emerald-300";
    if (s === "U") return "text-red-500";
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

  function fmtTime(ts: number): string {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      year: sameYear ? undefined : "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<aside
  bind:this={panelEl}
  class="relative flex h-full shrink-0 flex-col border-l border-border bg-[var(--color-surface)] {resizing
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
        <span class="flex items-center gap-0.5 text-[10.5px] text-muted-foreground">
          <ArrowUp class="size-3" />{gs.ahead}
        </span>
      {/if}
      {#if gs.behind > 0}
        <span class="flex items-center gap-0.5 text-[10.5px] text-muted-foreground">
          <ArrowDown class="size-3" />{gs.behind}
        </span>
      {/if}
    {:else}
      <span class="truncate text-xs text-muted-foreground">Not a git repo</span>
    {/if}
    <div class="ml-auto flex items-center gap-1">
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
        onclick={refresh}
        disabled={!project || gs?.loading}
        title="Refresh"
        aria-label="Refresh git status"
      >
        <RefreshCw class="size-3.5 {gs?.loading ? 'animate-spin' : ''}" />
      </button>
    </div>
  </header>

  {#if !project}
    <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
      Pick a project.
    </div>
  {:else if !gs?.isRepo}
    <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
      This folder is not a git repository.
    </div>
  {:else}
    <div class="flex min-h-0 flex-1 flex-col">
      <!-- Commit box -->
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
          disabled={gs.committing || gs.staged.length === 0 || !gs.message.trim()}
        >
          <GitCommit class="size-3.5" />
          Commit ({gs.staged.length})
        </button>
      </div>

      <!-- Top: changes -->
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {#if gs.conflicts.length > 0}
          {@render section({
            label: "Merge changes",
            count: gs.conflicts.length,
            entries: gs.conflicts,
            mode: "conflict",
            open: conflictsOpen,
            toggle: () => (conflictsOpen = !conflictsOpen),
          })}
        {/if}
        {#if gs.staged.length > 0}
          {@render section({
            label: "Staged",
            count: gs.staged.length,
            entries: gs.staged,
            mode: "staged",
            open: stagedOpen,
            toggle: () => (stagedOpen = !stagedOpen),
          })}
        {/if}
        {#if gs.unstaged.length > 0}
          {@render section({
            label: "Changes",
            count: gs.unstaged.length,
            entries: gs.unstaged,
            mode: "unstaged",
            open: changesOpen,
            toggle: () => (changesOpen = !changesOpen),
          })}
        {/if}
        {#if gs.staged.length === 0 && gs.unstaged.length === 0 && gs.conflicts.length === 0}
          <div class="px-3 py-4 text-center text-[11px] text-muted-foreground">
            Working tree clean.
          </div>
        {/if}

        <!-- Bottom: log -->
        <div class="mt-1 border-t border-border">
          <button
            type="button"
            class="flex w-full items-center gap-1 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
            onclick={() => (logOpen = !logOpen)}
          >
            <ChevronDown class="size-3 transition {logOpen ? '' : '-rotate-90'}" />
            <span>Commits</span>
            <span class="ml-1 text-muted-foreground/60">{gs.log.length}</span>
          </button>
          {#if logOpen}
            <div class="flex flex-col">
              {#each gs.log as c (c.sha)}
                <div
                  class="group flex items-start gap-2 px-2 py-1.5 hover:bg-[var(--color-surface-2)]"
                  title={c.sha}
                >
                  <span class="mt-1 size-1.5 shrink-0 rounded-full bg-foreground/40"></span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5">
                      <span class="truncate text-[11.5px] text-foreground/90">
                        {c.summary}
                      </span>
                      {#each c.refs as r (r)}
                        <span class="shrink-0 rounded bg-[var(--color-surface-3)] px-1 py-px font-mono text-[9px] text-muted-foreground">
                          {r.replace(/^HEAD -> /, "")}
                        </span>
                      {/each}
                    </div>
                    <div class="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/70">
                      <span>{c.shortSha}</span>
                      <span class="truncate">{c.author}</span>
                      <span>·</span>
                      <span>{fmtTime(c.time)}</span>
                    </div>
                  </div>
                </div>
              {/each}
              {#if gs.log.length === 0}
                <div class="px-3 py-3 text-center text-[10.5px] text-muted-foreground/70">
                  No commits.
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- Resize handle (left edge) -->
  <button
    type="button"
    class="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition hover:bg-foreground/10"
    onmousedown={startResize}
    aria-label="Resize git panel"
    tabindex="-1"
  ></button>
</aside>

{#snippet section({ label, count, entries, mode, open, toggle }: SectionArgs)}
  <div class="flex flex-col">
    <button
      type="button"
      class="flex items-center gap-1 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
      onclick={toggle}
    >
      <ChevronDown class="size-3 transition {open ? '' : '-rotate-90'}" />
      <span>{label}</span>
      <span class="ml-1 text-muted-foreground/60">{count}</span>
      {#if mode !== "conflict"}
        <span class="ml-auto flex gap-0.5">
          {#if mode === "staged"}
            <span
              class="rounded p-0.5 text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground"
              role="button"
              tabindex="-1"
              title="Unstage all"
              onclick={(e) => {
                e.stopPropagation();
                if (project) void gitStore.unstage(project.id, entries.map((x) => x.path));
              }}
              onkeydown={() => {}}
            >
              <Minus class="size-3" />
            </span>
          {:else}
            <span
              class="rounded p-0.5 text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground"
              role="button"
              tabindex="-1"
              title="Stage all"
              onclick={(e) => {
                e.stopPropagation();
                if (project) void gitStore.stage(project.id, entries.map((x) => x.path));
              }}
              onkeydown={() => {}}
            >
              <Plus class="size-3" />
            </span>
          {/if}
        </span>
      {/if}
    </button>
    {#if open}
      {#each entries as entry (entry.path + ":" + entry.staged + ":" + entry.conflicted)}
        <div
          class="group/row flex items-center gap-2 px-2 py-1 text-[11.5px] hover:bg-[var(--color-surface-2)]"
          title={entry.path}
        >
          <span class="min-w-0 flex-1 truncate text-foreground/85">
            {basename(entry.path)}
            {#if dirname(entry.path)}
              <span class="ml-1 text-muted-foreground/60">{dirname(entry.path)}</span>
            {/if}
          </span>
          <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover/row:opacity-100">
            {#if mode === "staged"}
              <button
                type="button"
                class="rounded p-0.5 text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground"
                title="Unstage"
                onclick={() => project && gitStore.unstage(project.id, [entry.path])}
              >
                <Minus class="size-3" />
              </button>
            {:else if mode === "unstaged"}
              <button
                type="button"
                class="rounded p-0.5 text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground"
                title="Discard"
                onclick={() => {
                  if (!project) return;
                  if (
                    confirm(`Discard changes to ${entry.path}?\nThis cannot be undone.`)
                  ) {
                    void gitStore.discard(project.id, [entry.path]);
                  }
                }}
              >
                <Trash2 class="size-3" />
              </button>
              <button
                type="button"
                class="rounded p-0.5 text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground"
                title="Stage"
                onclick={() => project && gitStore.stage(project.id, [entry.path])}
              >
                <Plus class="size-3" />
              </button>
            {/if}
          </div>
          <span class="w-3 shrink-0 text-center font-mono text-[11px] {statusColor(entry.status)}">
            {entry.status}
          </span>
        </div>
      {/each}
    {/if}
  </div>
{/snippet}
