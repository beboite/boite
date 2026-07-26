<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { workspace } from "$lib/backend";
  import { settings } from "$lib/features/settings/store.svelte";
  import { gitStore } from "./store.svelte";
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { basename, dirname } from "$lib/shared/utils/path";
  import { resizeHandle } from "$lib/shared/actions/resizeHandle";
  import GitGraph from "./GitGraph.svelte";
  import BranchChangesDialog from "./BranchChangesDialog.svelte";
  import { i18n } from "$lib/i18n/index.svelte";
  import type { ChangeEntry } from "./api";
  import CloudDownload from "@lucide/svelte/icons/cloud-download";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Plus from "@lucide/svelte/icons/plus";
  import Minus from "@lucide/svelte/icons/minus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowUpFromLine from "@lucide/svelte/icons/arrow-up-from-line";
  import ArrowDownToLine from "@lucide/svelte/icons/arrow-down-to-line";
  import X from "@lucide/svelte/icons/x";
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";

  const AUTO_REFRESH_MS = 10_000;

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

  // The repo the panel operates on: a persisted nested repo when the project
  // folder itself isn't one, otherwise the folder.
  const gitRoot = $derived(project ? project.gitRoot ?? project.cwd : null);

  let bodyEl: HTMLElement | null = $state(null);
  let resizingY = $state(false);
  let branchMenuEl: HTMLDivElement | null = $state(null);
  let branchMenuOpen = $state(false);
  let newBranchName = $state("");
  let branchAction = $state<{ name: string; create: boolean } | null>(null);

  $effect(() => {
    if (!project || !gitRoot) return;
    const id = project.id;
    gitStore.ensure(id, gitRoot);
    // Local refresh first, then a background fetch once we know it's a repo.
    void gitStore.refresh(id).then(() => gitStore.autoFetch(id));
  });

  // Not a repo → look for nested repos to offer. Idempotent in the store, so
  // re-runs of this effect are free.
  $effect(() => {
    if (!project) return;
    const state = gitStore.get(project.id);
    if (state?.loaded && !state.isRepo && !project.gitRoot) {
      void gitStore.scanRepos(project.id, project.cwd);
    }
  });

  $effect(() => {
    if (!project) return;
    const id = project.id;
    // autoFetch self-rate-limits, so calling it every tick is cheap; the real
    // network fetch only fires once the configured period has elapsed.
    const poke = () => {
      if (document.hidden) return;
      // A remote workspace mid-reconnect would just pile up RPCs that time out
      // 20s later; skip until the socket is back. Local is always "connected".
      const remoteScoped =
        workspace.mode === "remote" ||
        (workspace.isDynamic && project?.origin === "remote");
      if (remoteScoped && workspace.connection !== "connected") return;
      void gitStore.refresh(id);
      void gitStore.autoFetch(id);
    };
    // The interval is a slow safety net; focus/visibility pokes below give the
    // instant refresh when the user comes back to the app.
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

  function push() {
    if (project) void gitStore.push(project.id);
  }

  function pull() {
    if (project) void gitStore.pull(project.id);
  }

  function initRepo() {
    if (project) void gitStore.init(project.id);
  }

  function repoLabel(repo: string): string {
    if (!project) return repo;
    const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
    const base = norm(project.cwd);
    const r = norm(repo);
    if (r.toLowerCase().startsWith(base.toLowerCase() + "/")) {
      return r.slice(base.length + 1);
    }
    return basename(r) || r;
  }

  function selectRepo(repo: string) {
    if (project) void app.updateProject({ ...project, gitRoot: repo });
  }

  function clearGitRoot() {
    if (project) void app.updateProject({ ...project, gitRoot: null });
  }

  function toggleBranchMenu() {
    if (!project || !gs?.isRepo || gs.switchingBranch) return;
    branchMenuOpen = !branchMenuOpen;
    if (branchMenuOpen) void gitStore.loadBranches(project.id);
  }

  function closeBranchMenuOnOutsideClick(event: PointerEvent) {
    if (
      branchMenuOpen &&
      event.target instanceof Node &&
      !branchMenuEl?.contains(event.target)
    ) {
      branchMenuOpen = false;
    }
  }

  function requestBranchChange(name: string, create: boolean) {
    const trimmed = name.trim();
    if (!project || !trimmed || (!create && trimmed === gs?.branch)) return;
    branchMenuOpen = false;
    const action = { name: trimmed, create };
    if (totalChanges > 0) branchAction = action;
    else void performBranchChange(action, false);
  }

  function createBranch(event: SubmitEvent) {
    event.preventDefault();
    requestBranchChange(newBranchName, true);
  }

  async function performBranchChange(
    action: { name: string; create: boolean },
    stash: boolean,
  ) {
    if (!project) return;
    const changed = await gitStore.changeBranch(
      project.id,
      action.name,
      action.create,
      stash,
    );
    if (changed && action.create) newBranchName = "";
    branchAction = null;
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

  function loadMoreCommits() {
    if (project) void gitStore.loadMore(project.id);
  }

  function onResizeY(e: PointerEvent) {
    if (!bodyEl) return;
    const rect = bodyEl.getBoundingClientRect();
    if (rect.height <= 0) return;
    const fraction = (e.clientY - rect.top) / rect.height;
    settings.setGitSplitFraction(fraction);
  }

  function statusColor(s: string): string {
    if (s === "M") return "text-[var(--color-warning)]";
    if (s === "A") return "text-[var(--color-success)]";
    if (s === "D") return "text-[var(--color-danger)]";
    if (s === "R") return "text-[var(--color-success)]";
    if (s === "?") return "text-[var(--color-success)]";
    if (s === "U") return "text-[var(--color-danger)]";
    return "text-muted-foreground";
  }

  function stagePaths(files: string[]) {
    if (project) void gitStore.stage(project.id, files);
  }
  function unstagePaths(files: string[]) {
    if (project) void gitStore.unstage(project.id, files);
  }
  function markResolved(path: string) {
    if (project) void gitStore.stage(project.id, [path]);
  }
  async function discardEntry(entry: ChangeEntry) {
    if (!project) return;
    const untracked = entry.status === "?";
    const ok = await confirmDialog.ask({
      title: untracked ? "Delete untracked file?" : "Discard changes?",
      message: untracked
        ? `${entry.path} is not tracked by git. Deleting it cannot be undone.`
        : `Working-tree changes to ${entry.path} will be lost. Staged changes are kept.`,
      confirmLabel: untracked ? "Delete" : "Discard",
      danger: true,
    });
    if (ok) void gitStore.discard(project.id, [entry]);
  }

  async function openDiff(entry: ChangeEntry) {
    if (!project) return;
    const repo = gitRoot ?? project.cwd;
    if (entry.status === "?" || entry.conflicted) {
      const sep = repo.includes("\\") ? "\\" : "/";
      const root = repo.endsWith(sep) ? repo : repo + sep;
      await editorStore.openFile(root + entry.path.replace(/[\\/]/g, sep));
      app.view = "editor";
      return;
    }
    const mode = entry.staged ? "staged" : "unstaged";
    await editorStore.openDiff({
      projectId: project.id,
      repoPath: repo,
      file: entry.path,
      mode,
      headFile: entry.origPath ?? undefined,
    });
    app.view = "editor";
  }
</script>

<svelte:window onpointerdown={closeBranchMenuOnOutsideClick} />

<div
  class="flex h-full min-h-0 flex-col {resizingY ? 'select-none' : ''}"
>
  <header
    class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3"
  >
    <GitBranch class="size-4 text-muted-foreground" />
    {#if gs?.isRepo}
      <div bind:this={branchMenuEl} class="relative min-w-0">
        <button
          type="button"
          class="flex max-w-44 items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-foreground/90 transition hover:bg-[var(--color-surface-2)] disabled:opacity-50"
          onclick={toggleBranchMenu}
          disabled={gs.switchingBranch}
          aria-haspopup="menu"
          aria-expanded={branchMenuOpen}
          title={i18n.t("git.change_branch")}
        >
          <GitBranch class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate">{gs.branch ?? "(detached)"}</span>
          <ChevronDown class="size-3 shrink-0 text-muted-foreground transition {branchMenuOpen ? 'rotate-180' : ''}" />
        </button>

        {#if branchMenuOpen}
          <div
            class="absolute left-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-md border border-border bg-[var(--color-surface)] shadow-2xl"
            role="menu"
          >
            <form class="flex gap-1.5 border-b border-border p-2" onsubmit={createBranch}>
              <input
                class="min-w-0 flex-1 rounded border border-border bg-[var(--color-background)] px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
                placeholder={i18n.t("git.new_branch_placeholder")}
                aria-label={i18n.t("git.new_branch_placeholder")}
                bind:value={newBranchName}
                disabled={gs.switchingBranch}
              />
              <button
                type="submit"
                class="rounded border border-border bg-[var(--color-surface-2)] p-1.5 text-muted-foreground transition hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:opacity-40"
                disabled={!newBranchName.trim() || gs.switchingBranch}
                title={i18n.t("git.create_branch")}
                aria-label={i18n.t("git.create_branch")}
              >
                <Plus class="size-3.5" />
              </button>
            </form>

            <div class="max-h-64 overflow-y-auto py-1">
              {#if gs.branchesLoading && !gs.branchesLoaded}
                <div class="px-3 py-3 text-center text-[11px] text-muted-foreground">
                  {i18n.t("git.loading_branches")}
                </div>
              {:else if gs.branches.length === 0}
                <div class="px-3 py-3 text-center text-[11px] text-muted-foreground">
                  {i18n.t("git.no_local_branches")}
                </div>
              {:else}
                {#each gs.branches as branch (branch.name)}
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-[var(--color-surface-2)] disabled:opacity-60"
                    class:text-foreground={branch.current}
                    class:text-muted-foreground={!branch.current}
                    onclick={() => requestBranchChange(branch.name, false)}
                    disabled={branch.current || gs.switchingBranch}
                    role="menuitem"
                    title={branch.name}
                  >
                    <Check class="size-3.5 shrink-0 {branch.current ? 'opacity-100' : 'opacity-0'}" />
                    <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{branch.name}</span>
                  </button>
                {/each}
              {/if}
            </div>
          </div>
        {/if}
      </div>
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
    {#if project?.gitRoot}
      <button
        type="button"
        class="group/root flex min-w-0 shrink items-center gap-1 rounded-full border border-border bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:text-foreground"
        title="Nested repo: {project.gitRoot} — click to switch back to the project folder"
        onclick={clearGitRoot}
      >
        <FolderGit2 class="size-3 shrink-0" />
        <span class="truncate">{repoLabel(project.gitRoot)}</span>
        <X class="size-3 shrink-0 opacity-50 group-hover/root:opacity-100" />
      </button>
    {/if}
    <div class="ml-auto flex items-center gap-0.5">
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
        onclick={pull}
        disabled={!gs?.isRepo || !gs.upstream || gs.pulling}
        title="Pull (fast-forward only)"
        aria-label="Pull"
      >
        <ArrowDownToLine class="size-3.5 {gs?.pulling ? 'animate-pulse' : ''}" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
        onclick={push}
        disabled={!gs?.isRepo || gs.pushing || (gs.upstream !== null && gs.ahead === 0)}
        title={gs?.upstream ? "Push" : "Publish branch"}
        aria-label="Push"
      >
        <ArrowUpFromLine class="size-3.5 {gs?.pushing ? 'animate-pulse' : ''}" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
        onclick={fetch}
        disabled={!gs?.isRepo || gs.fetching}
        title="Fetch from remote"
        aria-label="Fetch from remote"
      >
        <CloudDownload class="size-3.5 {gs?.fetching ? 'animate-pulse' : ''}" />
      </button>
    </div>
  </header>

  {#if !project}
    <div
      class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground"
    >
      Pick a project.
    </div>
  {:else if !gs || !gs.loaded}
    <div
      class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground/70"
    >
      Loading…
    </div>
  {:else if !gs.isRepo}
    <div class="flex flex-1 flex-col overflow-y-auto">
      <div
        class="flex flex-col items-center gap-3 px-3 py-6 text-center text-xs text-muted-foreground"
      >
        <span>This folder is not a git repository.</span>
        {#if gs.scanning}
          <span class="text-[11px] text-muted-foreground/70">
            Scanning for nested repositories…
          </span>
        {/if}
        <button
          type="button"
          class="rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-foreground/85 transition hover:bg-[var(--color-surface-3)] hover:text-foreground"
          onclick={initRepo}
        >
          Initialize repository
        </button>
      </div>
      {#if !gs.scanning && gs.repos.length > 0}
        <div
          class="flex h-7 shrink-0 items-center gap-1.5 border-y border-border px-3"
        >
          <span
            class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Repositories found
          </span>
          <span
            class="rounded-full bg-[var(--color-surface-2)] px-1.5 text-[10px] text-foreground/75"
          >
            {gs.repos.length}
          </span>
        </div>
        {#each gs.repos as repo (repo)}
          <button
            type="button"
            class="flex items-center gap-2 px-3 py-1.5 text-left text-[11px] text-foreground/85 transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
            title={repo}
            onclick={() => selectRepo(repo)}
          >
            <FolderGit2 class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate">{repoLabel(repo)}</span>
          </button>
        {/each}
      {/if}
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
        use:resizeHandle={{
          onResize: onResizeY,
          onStateChange: (r) => (resizingY = r),
        }}
        class="relative h-1 shrink-0 cursor-row-resize transition hover:bg-foreground/10 {resizingY ? 'bg-foreground/20' : 'bg-transparent'}"
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
              {gs.commitCount || gs.log.length}{gs.commitCount
                ? ""
                : gs.logHasMore
                  ? "+"
                  : ""}
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
            {#if gs.logHasMore}
              <div class="border-t border-border p-2">
                <button
                  type="button"
                  class="w-full rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:opacity-50"
                  onclick={loadMoreCommits}
                  disabled={gs.logLoadingMore}
                >
                  {gs.logLoadingMore ? "Loading..." : "Load more commits"}
                </button>
              </div>
            {/if}
          {/if}
        </div>
      </section>
    </div>
  {/if}

</div>

{#if branchAction}
  <BranchChangesDialog
    branch={branchAction.name}
    creating={branchAction.create}
    busy={gs?.switchingBranch ?? false}
    canStash={(gs?.commitCount ?? 0) > 0}
    onCarry={() => void performBranchChange(branchAction!, false)}
    onStash={() => void performBranchChange(branchAction!, true)}
    onCancel={() => (branchAction = null)}
  />
{/if}

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
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-foreground/85 hover:text-foreground"
            onclick={() => openDiff(entry)}
          >
            {basename(entry.path)}
            {#if dirname(entry.path)}
              <span class="ml-1 text-muted-foreground/55"
                >{dirname(entry.path)}</span
              >
            {/if}
          </button>
          <div
            class="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover/row:opacity-100 group-focus-within/row:opacity-100"
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
                title={entry.status === "?" ? "Delete file" : "Discard changes"}
                aria-label={entry.status === "?" ? "Delete file" : "Discard changes"}
                onclick={() => discardEntry(entry)}
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
            {:else if mode === "conflict"}
              <button
                type="button"
                class="rounded p-0.5 text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground"
                title="Mark resolved (stage)"
                aria-label="Mark resolved"
                onclick={() => markResolved(entry.path)}
              >
                <Check class="size-3" />
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
