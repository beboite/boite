<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { workspace } from "$lib/backend";
  import { threadGitRoot } from "$lib/features/thread/cwd";
  import { isScratch } from "$lib/domain/project";
  import {
    settings,
    GIT_SPLIT_MAX,
    GIT_SPLIT_MIN,
  } from "$lib/features/settings/store.svelte";
  import { gitStore, gitScope } from "./store.svelte";
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { revealEditor } from "$lib/features/editor/reveal";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { registerEscape, restoreFocus } from "$lib/shared/keyboard/overlay";
  import { basename, dirname } from "$lib/shared/utils/path";
  import { resizeHandle } from "$lib/shared/actions/resizeHandle";
  import GitGraph from "./GitGraph.svelte";
  import BranchChangesDialog from "./BranchChangesDialog.svelte";
  import { t } from "$lib/i18n/index.svelte";
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

  // Git is a full tab on a phone, so the rows and their actions have to be
  // finger-sized there while the desktop panel keeps its density.
  const mobile = $derived(settings.state.mobileLayout);

  // The pane's project when it has one, the selected project otherwise: the
  // mobile tab has no pane around it, and a panel in a pane belongs to the
  // group it was opened in rather than to whatever the sidebar points at.
  type Props = { projectId?: string | null };
  let { projectId = null }: Props = $props();

  const project = $derived.by(() => {
    const id = projectId ?? app.currentProjectId;
    return id ? app.projects.find((p) => p.id === id) ?? null : null;
  });

  // The thread whose checkout the panel should describe. Only when it belongs
  // to the project on screen: the active thread can live in another project
  // while this panel shows the one the user selected.
  const threadHere = $derived(
    app.activeThread && app.activeThread.projectId === project?.id ? app.activeThread : null,
  );

  // The repo the panel operates on: the active thread's worktree when it has
  // one, then a persisted nested repo when the project folder itself isn't a
  // repo, otherwise the folder.
  const gitRoot = $derived(project ? threadGitRoot(threadHere, project) : null);

  // Which checkout every call below is about. The dashboard watches the project
  // folder at the same time, so naming the pair keeps the two from overwriting
  // each other's branch, status and log.
  const scope = $derived(
    project && gitRoot ? gitScope(project.id, gitRoot) : null,
  );

  let bodyEl: HTMLElement | null = $state(null);
  let resizingY = $state(false);
  let branchMenuEl: HTMLDivElement | null = $state(null);
  let branchPanelEl: HTMLDivElement | null = $state(null);
  let newBranchInput: HTMLInputElement | null = $state(null);
  let branchMenuOpen = $state(false);
  let newBranchName = $state("");
  let branchAction = $state<{ name: string; create: boolean } | null>(null);

  $effect(() => {
    if (!project || !gitRoot) return;
    const registered = gitStore.ensure(project.id, gitRoot);
    // Local refresh first, then a background fetch once we know it's a repo.
    void gitStore.refresh(registered).then(() => gitStore.autoFetch(registered));
  });

  // Not a repo → look for nested repos to offer. Idempotent in the store, so
  // re-runs of this effect are free.
  //
  // Never on Scratch. Its folder is the home directory, and the scan walks
  // three levels of it: on Windows that is the whole of `AppData` plus every
  // dependency tree under it, minutes of directory reads for a list of
  // repositories nobody opened this panel to see.
  $effect(() => {
    if (!project || !scope || isScratch(project)) return;
    const state = gitStore.get(scope);
    if (state?.loaded && !state.isRepo && !project.gitRoot) {
      void gitStore.scanRepos(scope, project.cwd);
    }
  });

  $effect(() => {
    if (!project || !scope) return;
    const id = scope;
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

  const gs = $derived(gitStore.get(scope));

  let stagedOpen = $state(true);
  let changesOpen = $state(true);
  let conflictsOpen = $state(true);
  let commitsOpen = $state(true);

  const totalChanges = $derived(
    gs ? gs.staged.length + gs.unstaged.length + gs.conflicts.length : 0,
  );
  const topPercent = $derived(settings.state.gitSplitFraction * 100);

  function fetch() {
    if (scope) void gitStore.fetch(scope);
  }

  function push() {
    if (scope) void gitStore.push(scope);
  }

  function pull() {
    if (scope) void gitStore.pull(scope);
  }

  function initRepo() {
    if (scope) void gitStore.init(scope);
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
    if (branchMenuOpen) void gitStore.loadBranches(scope);
  }

  // Same shape as ConfirmDialog: the dropdown used to open with the keyboard on
  // the trigger behind it, and close leaving focus on <body>.
  $effect(() => {
    if (!branchMenuOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const surface = branchPanelEl;
    (newBranchInput ?? branchPanelEl)?.focus();
    return () => restoreFocus(previous, surface);
  });

  $effect(() => {
    if (!branchMenuOpen) return;
    return registerEscape(() => (branchMenuOpen = false));
  });

  function branchRows(): HTMLElement[] {
    return Array.from(
      branchPanelEl?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
  }

  function branchFocusables(): HTMLElement[] {
    return Array.from(
      branchPanelEl?.querySelectorAll<HTMLElement>(
        "input:not(:disabled), button:not(:disabled)",
      ) ?? [],
    );
  }

  function onBranchMenuKeydown(e: KeyboardEvent) {
    const active = document.activeElement as HTMLElement | null;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      const items = branchRows();
      if (items.length === 0) return;
      e.preventDefault();
      const last = items.length - 1;
      if (e.key === "Home") return void items[0].focus();
      if (e.key === "End") return void items[last].focus();
      const idx = active ? items.indexOf(active) : -1;
      const down = e.key === "ArrowDown";
      // From the name field, which is where the dropdown opens, the two
      // directions have to mean "first" and "last" rather than an offset from -1.
      if (idx < 0) items[down ? 0 : last].focus();
      else items[(idx + (down ? 1 : -1) + items.length) % items.length].focus();
      return;
    }
    if (e.key === "Tab") {
      // Trapped: Tab out of the dropdown left it hanging over a panel the
      // keyboard had already left.
      e.preventDefault();
      const all = branchFocusables();
      if (all.length === 0) return;
      const idx = active ? all.indexOf(active) : -1;
      const last = all.length - 1;
      if (idx < 0) all[e.shiftKey ? last : 0].focus();
      else all[(idx + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
    }
    // Enter needs nothing: the field submits its form, the rows are buttons.
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
      scope,
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
    if (scope) void gitStore.commit(scope);
  }

  function loadMoreCommits() {
    if (scope) void gitStore.loadMore(scope);
  }

  function onResizeY(e: PointerEvent) {
    if (!bodyEl) return;
    const rect = bodyEl.getBoundingClientRect();
    if (rect.height <= 0) return;
    const fraction = (e.clientY - rect.top) / rect.height;
    settings.setGitSplitFraction(fraction);
  }

  // The handle was `tabindex="-1"`, so the two sections could only be resized
  // with a pointer. 24px a press, 96 with Shift, turned into a fraction of the
  // body it divides; the store clamps both ends.
  const RESIZE_STEP_PX = 24;
  const RESIZE_BIG_STEP_PX = 96;

  function onResizeYKeydown(e: KeyboardEvent) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const height = bodyEl?.getBoundingClientRect().height ?? 0;
    if (height <= 0) return;
    const step = e.shiftKey ? RESIZE_BIG_STEP_PX : RESIZE_STEP_PX;
    const delta = (e.key === "ArrowDown" ? step : -step) / height;
    settings.setGitSplitFraction(settings.state.gitSplitFraction + delta);
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
    if (scope) void gitStore.stage(scope, files);
  }
  function unstagePaths(files: string[]) {
    if (scope) void gitStore.unstage(scope, files);
  }
  function markResolved(path: string) {
    if (scope) void gitStore.stage(scope, [path]);
  }
  async function discardEntry(entry: ChangeEntry) {
    if (!project) return;
    const untracked = entry.status === "?";
    const ok = await confirmDialog.ask({
      title: untracked ? t("git.confirmDeleteTitle") : t("git.confirmDiscardTitle"),
      message: untracked
        ? t("git.confirmDeleteMsg", { path: entry.path })
        : t("git.confirmDiscardMsg", { path: entry.path }),
      confirmLabel: untracked ? t("git.confirmDeleteLabel") : t("git.confirmDiscardLabel"),
      danger: true,
    });
    if (ok) void gitStore.discard(scope, [entry]);
  }

  async function openDiff(entry: ChangeEntry) {
    if (!project) return;
    const repo = gitRoot ?? project.cwd;
    if (entry.status === "?" || entry.conflicted) {
      const sep = repo.includes("\\") ? "\\" : "/";
      const root = repo.endsWith(sep) ? repo : repo + sep;
      await editorStore.open(root + entry.path.replace(/[\\/]/g, sep));
      revealEditor();
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
    revealEditor();
  }

</script>

<svelte:window onpointerdown={closeBranchMenuOnOutsideClick} />

<!-- On a phone this panel is a full-bleed tab, so in landscape on a notched
     device the cutout would sit over the first characters of every path. -->
<div
  class="flex h-full min-h-0 flex-col {resizingY ? 'select-none' : ''}"
  style={mobile
    ? "padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px);"
    : undefined}
>
  <header
    class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3"
  >
    <!-- The icon belongs to whichever of the two things is drawn, never to
         both: the branch button carries its own, and a second one sitting in
         front of it read as two branch marks side by side. -->
    {#if gs?.isRepo}
      <div bind:this={branchMenuEl} class="relative min-w-0">
        <button
          type="button"
          class="flex max-w-44 items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
          onclick={toggleBranchMenu}
          disabled={gs.switchingBranch}
          aria-haspopup="menu"
          aria-expanded={branchMenuOpen}
          use:tip={t("git.changeBranch")}
        >
          <GitBranch class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate">{gs.branch ?? t("git.detached")}</span>
          <ChevronDown class="size-3 shrink-0 text-muted-foreground transition {branchMenuOpen ? 'rotate-180' : ''}" />
        </button>

        {#if branchMenuOpen}
          <div
            bind:this={branchPanelEl}
            class="surface-popover absolute left-0 top-full z-[var(--z-dropdown)] mt-1 w-64 overflow-hidden outline-none"
            role="menu"
            tabindex="-1"
            onkeydown={onBranchMenuKeydown}
          >
            <form class="flex gap-1.5 border-b border-border p-2" onsubmit={createBranch}>
              <input
                bind:this={newBranchInput}
                class="min-w-0 flex-1 rounded border border-edge bg-[var(--color-background)] px-2 py-1 text-sm text-foreground placeholder:text-muted-2 focus:border-foreground/30 focus:outline-none focus-visible:focus-ring-inset"
                placeholder={t("git.newBranchPlaceholder")}
                aria-label={t("git.newBranchPlaceholder")}
                bind:value={newBranchName}
                disabled={gs.switchingBranch}
              />
              <button
                type="submit"
                class="rounded border border-edge bg-[var(--color-surface-2)] p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
                disabled={!newBranchName.trim() || gs.switchingBranch}
                use:tip={t("git.createBranch")}
                aria-label={t("git.createBranch")}
              >
                <Plus class="size-3.5" />
              </button>
            </form>

            <div class="max-h-64 scroll-pane overflow-y-auto py-1">
              {#if gs.branchesLoading && !gs.branchesLoaded}
                <div class="px-3 py-3 text-center text-sm text-muted-foreground">
                  {t("git.loadingBranches")}
                </div>
              {:else if gs.branches.length === 0}
                <div class="px-3 py-3 text-center text-sm text-muted-foreground">
                  {t("git.noLocalBranches")}
                </div>
              {:else}
                {#each gs.branches as branch (branch.name)}
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-accent focus-visible:bg-[var(--color-surface-2)] focus-visible:outline-none disabled:opacity-60"
                    class:text-foreground={branch.current}
                    class:text-muted-foreground={!branch.current}
                    onclick={() => requestBranchChange(branch.name, false)}
                    disabled={branch.current || gs.switchingBranch}
                    role="menuitem"
                    use:tip={branch.name}
                  >
                    <Check class="size-3.5 shrink-0 {branch.current ? 'opacity-100' : 'opacity-0'}" />
                    <span class="min-w-0 flex-1 truncate text-sm">{branch.name}</span>
                  </button>
                {/each}
              {/if}
            </div>
          </div>
        {/if}
      </div>
      {#if gs.ahead > 0}
        <span
          class="flex items-center gap-0.5 text-xs text-muted-foreground"
        >
          <ArrowUp class="size-3" />{gs.ahead}
        </span>
      {/if}
      {#if gs.behind > 0}
        <span
          class="flex items-center gap-0.5 text-xs text-muted-foreground"
        >
          <ArrowDown class="size-3" />{gs.behind}
        </span>
      {/if}
    {:else}
      <GitBranch class="size-4 text-muted-foreground" />
      <span class="truncate text-xs text-muted-foreground">{t("git.notAGitRepo")}</span>
    {/if}
    {#if project?.gitRoot}
      <button
        type="button"
        class="group/root flex min-w-0 shrink items-center gap-1 rounded-full border border-edge bg-[var(--color-surface-2)] px-1.5 py-0.5 text-2xs text-muted-foreground transition hover:text-foreground"
        use:tip={t("git.nestedRepo", { path: project.gitRoot })}
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
        class="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
        onclick={pull}
        disabled={!gs?.isRepo || !gs.upstream || gs.pulling}
        use:tip={t("git.pullFf")}
        aria-label={t("git.pull")}
      >
        <ArrowDownToLine class="size-3.5 {gs?.pulling ? 'animate-pulse' : ''}" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
        onclick={push}
        disabled={!gs?.isRepo || gs.pushing || (gs.upstream !== null && gs.ahead === 0)}
        use:tip={gs?.upstream ? t("git.push") : t("git.publishBranch")}
        aria-label={t("git.push")}
      >
        <ArrowUpFromLine class="size-3.5 {gs?.pushing ? 'animate-pulse' : ''}" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
        onclick={fetch}
        disabled={!gs?.isRepo || gs.fetching}
        use:tip={t("git.fetchRemote")}
        aria-label={t("git.fetchRemote")}
      >
        <CloudDownload class="size-3.5 {gs?.fetching ? 'animate-pulse' : ''}" />
      </button>
    </div>
  </header>

  {#if !project}
    <div
      class="flex flex-1 items-center justify-center px-3 text-center text-sm text-muted-foreground"
    >
      {t("git.pickProject")}
    </div>
  {:else if !gs || !gs.loaded}
    <div class="flex flex-1 flex-col gap-2 px-3 py-3" aria-hidden="true">
      <div class="skeleton h-4 w-2/5"></div>
      <div class="skeleton h-12 w-full"></div>
      {#each [80, 64, 72, 56] as width, i (i)}
        <div class="skeleton h-3" style:width="{width}%"></div>
      {/each}
    </div>
  {:else if !gs.isRepo}
    <div class="flex flex-1 flex-col scroll-pane overflow-y-auto">
      <div
        class="flex flex-col items-center gap-3 px-3 py-6 text-center text-sm text-muted-foreground"
      >
        <span>{t("git.notRepoDesc")}</span>
        {#if gs.scanning}
          <span class="text-sm text-muted-2">
            {t("git.scanningNested")}
          </span>
        {/if}
        <button
          type="button"
          class="rounded-md border border-edge bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-foreground transition hover:bg-accent hover:text-foreground"
          onclick={initRepo}
        >
          {t("git.initRepo")}
        </button>
      </div>
      {#if !gs.scanning && gs.repos.length > 0}
        <div
          class="flex h-7 shrink-0 items-center gap-1.5 border-y border-border px-3"
        >
          <span
            class="text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {t("git.repositoriesFound")}
          </span>
          <span
            class="rounded-full bg-[var(--color-surface-2)] px-1.5 text-2xs text-muted-foreground"
          >
            {gs.repos.length}
          </span>
        </div>
        {#each gs.repos as repo (repo)}
          <button
            type="button"
            class="flex items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground transition hover:bg-accent hover:text-foreground"
            use:tip={repo}
            onclick={() => selectRepo(repo)}
          >
            <FolderGit2 class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 truncate">{repoLabel(repo)}</span>
          </button>
        {/each}
      {/if}
    </div>
  {:else}
    <div
      bind:this={bodyEl}
      class="grid min-h-0 min-w-0 w-full flex-1 {resizingY ? '' : 'transition-[grid-template-rows] duration-150'}"
      style:grid-template-rows={commitsOpen
        ? `${topPercent}% 4px minmax(0, 1fr)`
        : "minmax(0, 1fr) 28px"}
    >
      <!-- Changes (top) -->
      <section class="flex min-h-0 min-w-0 w-full flex-col">
        <div
          class="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-3"
        >
          <span
            class="text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {t("git.changes")}
          </span>
          {#if totalChanges > 0}
            <span
              class="rounded-full bg-[var(--color-surface-2)] px-1.5 text-2xs text-muted-foreground"
            >
              {totalChanges}
            </span>
          {/if}
        </div>

        <div class="shrink-0 border-b border-border p-2">
          <textarea
            class="w-full resize-none rounded-md border border-edge bg-[var(--color-background)] px-2 py-1.5 text-sm text-foreground placeholder:text-muted-2 focus:border-foreground/30 focus:outline-none focus-visible:focus-ring-inset"
            rows="2"
            placeholder={t("git.commitPlaceholder")}
            aria-label={t("git.commitLabel")}
            bind:value={gs.message}
            onkeydown={commitKey}
            disabled={gs.committing}
          ></textarea>
          {#if totalChanges > 0}
            <button
              type="button"
              class="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-edge bg-[var(--color-surface-2)] px-2 py-1 text-sm font-medium text-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              onclick={doCommit}
              disabled={gs.committing ||
                gs.staged.length === 0 ||
                !gs.message.trim()}
            >
              {t("git.commitBtn", { count: gs.staged.length })}
            </button>
          {:else}
            {@const canPush = gs.upstream === null || gs.ahead > 0}
            <button
              type="button"
              class="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-edge bg-[var(--color-surface-2)] px-2 py-1 text-sm font-medium text-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              onclick={push}
              disabled={gs.pushing || !canPush}
            >
              {#if gs.upstream === null}
                <ArrowUpFromLine class="size-3.5" />
                {t("git.publishBranch")}
              {:else if gs.ahead > 0}
                <ArrowUpFromLine class="size-3.5 {gs.pushing ? 'animate-pulse' : ''}" />
                {t("git.pushCount", { count: gs.ahead })}
              {:else}
                <Check class="size-3.5 text-[var(--color-success)]" />
                {t("git.upToDate")}
              {/if}
            </button>
          {/if}
        </div>

        <div class="min-h-0 flex-1 scroll-pane overflow-y-auto">
          {#if gs.conflicts.length > 0}
            {@render section({
              label: t("git.mergeChanges"),
              entries: gs.conflicts,
              mode: "conflict",
              open: conflictsOpen,
              toggle: () => (conflictsOpen = !conflictsOpen),
            })}
          {/if}
          {#if gs.staged.length > 0}
            {@render section({
              label: t("git.staged"),
              entries: gs.staged,
              mode: "staged",
              open: stagedOpen,
              toggle: () => (stagedOpen = !stagedOpen),
            })}
          {/if}
          {#if gs.unstaged.length > 0}
            {@render section({
              label: t("git.changes"),
              entries: gs.unstaged,
              mode: "unstaged",
              open: changesOpen,
              toggle: () => (changesOpen = !changesOpen),
            })}
          {/if}
          {#if totalChanges === 0}
            <div
              class="px-3 py-4 text-center text-sm text-muted-2"
            >
              {t("git.workingTreeClean")}
            </div>
          {/if}
        </div>
      </section>

      {#if commitsOpen}
        <!-- A separator rather than a button: it sits at a fraction between two
             bounds and the arrows move it, which is not what pressing a button
             means. The two rules below read `separator` as decoration; a
             separator with a value and bounds is the window-splitter pattern,
             and it is focusable and keyboard-driven by definition. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          use:resizeHandle={{
            onResize: onResizeY,
            onStateChange: (r) => (resizingY = r),
          }}
          class="relative z-10 h-1 translate-y-[2px] cursor-row-resize transition hover:bg-foreground/10 focus-visible:focus-ring-inset focus-visible:bg-foreground/20 after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] {resizingY ? 'bg-foreground/20' : 'bg-transparent'}"
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={Math.round(settings.state.gitSplitFraction * 100)}
          aria-valuemin={Math.round(GIT_SPLIT_MIN * 100)}
          aria-valuemax={Math.round(GIT_SPLIT_MAX * 100)}
          aria-label={t("git.resizeSections")}
          tabindex="0"
          onkeydown={onResizeYKeydown}
        ></div>
      {/if}

      <!-- Commits (bottom) -->
      <section class="flex min-h-0 min-w-0 w-full flex-col border-t border-border">
        <button
          type="button"
          class="flex h-7 shrink-0 items-center gap-1.5 px-3 text-left transition hover:bg-accent {commitsOpen ? 'border-b border-edge' : ''}"
          onclick={() => (commitsOpen = !commitsOpen)}
          aria-expanded={commitsOpen}
        >
          <ChevronDown class="size-3 text-muted-foreground transition {commitsOpen ? '' : '-rotate-90'}" />
          <span
            class="text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {t("git.commits")}
          </span>
          {#if gs.log.length > 0}
            <span
              class="rounded-full bg-[var(--color-surface-2)] px-1.5 text-2xs text-muted-foreground"
            >
              {gs.commitCount || gs.log.length}{gs.commitCount
                ? ""
                : gs.logHasMore
                  ? "+"
                  : ""}
            </span>
          {/if}
        </button>
        {#if commitsOpen}
          <div class="flex min-h-0 min-w-0 w-full flex-1 flex-col scroll-pane overflow-y-auto overflow-x-hidden">
            {#if gs.log.length === 0}
              <div
                class="px-3 py-4 text-center text-sm text-muted-2"
              >
                {t("git.noCommits")}
              </div>
            {:else}
              <GitGraph commits={gs.log} />
              {#if gs.logHasMore}
                <div class="border-t border-border p-2 shrink-0">
                  <button
                    type="button"
                    class="w-full rounded-md border border-edge bg-[var(--color-surface-2)] px-2 py-1 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
                    onclick={loadMoreCommits}
                    disabled={gs.logLoadingMore}
                  >
                    {gs.logLoadingMore ? t("git.loadingMore") : t("git.loadMoreCommits")}
                  </button>
                </div>
              {/if}
            {/if}
          </div>
        {/if}
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
        class="flex flex-1 items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground transition hover:text-foreground"
        onclick={toggle}
      >
        <ChevronDown class="size-3 transition {open ? '' : '-rotate-90'}" />
        <span>{label}</span>
        <span class="text-muted-2">{entries.length}</span>
      </button>
      {#if mode === "staged"}
        <button
          type="button"
          class="flex shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground {mobile
            ? 'size-11'
            : 'p-0.5'}"
          use:tip={t("git.unstageAll")}
          aria-label={t("git.unstageAll")}
          onclick={() => unstagePaths(entries.map((x) => x.path))}
        >
          <Minus class={mobile ? "size-4" : "size-3"} />
        </button>
      {:else if mode === "unstaged"}
        <button
          type="button"
          class="flex shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground {mobile
            ? 'size-11'
            : 'p-0.5'}"
          use:tip={t("git.stageAll")}
          aria-label={t("git.stageAll")}
          onclick={() => stagePaths(entries.map((x) => x.path))}
        >
          <Plus class={mobile ? "size-4" : "size-3"} />
        </button>
      {/if}
    </div>
    {#if open}
      {#each entries as entry (entry.path + ":" + entry.staged + ":" + entry.conflicted)}
        <div
          class="group/row flex items-center gap-1.5 hover:bg-accent {mobile
            ? 'min-h-11 px-3 text-base'
            : 'px-2 py-1 text-sm'}"
          use:tip={entry.path}
        >
          <!-- The padding is on the button, not the row: it is what makes the
               whole 44px band open the diff instead of a 22px strip through the
               middle of it. -->
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-foreground hover:text-foreground {mobile
              ? 'py-3'
              : ''}"
            onclick={() => openDiff(entry)}
          >
            {basename(entry.path)}
            {#if dirname(entry.path)}
              <span class="ml-1 text-muted-2"
                >{dirname(entry.path)}</span
              >
            {/if}
          </button>
          <!-- Touch has no hover: hidden behind `group-hover/row` these were
               invisible on a phone and still hit-testable, so a tap in the right
               few pixels discarded a file with nothing on screen to explain it.
               Shown outright there instead. -->
          <div
            class="flex shrink-0 items-center {mobile
              ? 'gap-1'
              : 'gap-0.5 opacity-0 transition group-hover/row:opacity-100 group-focus-within/row:opacity-100'}"
          >
            {#if mode === "staged"}
              <button
                type="button"
                class="flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground {mobile
                  ? 'size-11'
                  : 'p-0.5'}"
                use:tip={t("git.unstage")}
                aria-label={t("git.unstageFile")}
                onclick={() => unstagePaths([entry.path])}
              >
                <Minus class={mobile ? "size-4" : "size-3"} />
              </button>
            {:else if mode === "unstaged"}
              <button
                type="button"
                class="flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground {mobile
                  ? 'size-11'
                  : 'p-0.5'}"
                use:tip={entry.status === "?" ? t("git.deleteFile") : t("git.discard")}
                aria-label={entry.status === "?" ? t("git.deleteFile") : t("git.discard")}
                onclick={() => discardEntry(entry)}
              >
                <Trash2 class={mobile ? "size-4" : "size-3"} />
              </button>
              <button
                type="button"
                class="flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground {mobile
                  ? 'size-11'
                  : 'p-0.5'}"
                use:tip={t("git.stage")}
                aria-label={t("git.stageFile")}
                onclick={() => stagePaths([entry.path])}
              >
                <Plus class={mobile ? "size-4" : "size-3"} />
              </button>
            {:else if mode === "conflict"}
              <button
                type="button"
                class="flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground {mobile
                  ? 'size-11'
                  : 'p-0.5'}"
                use:tip={t("git.markResolvedTitle")}
                aria-label={t("git.markResolved")}
                onclick={() => markResolved(entry.path)}
              >
                <Check class={mobile ? "size-4" : "size-3"} />
              </button>
            {/if}
          </div>
          <span
            class="w-4 shrink-0 text-center font-bold text-xs {statusColor(
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
