<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { workspace } from "$lib/backend";
  import { threadGitRoot } from "$lib/features/thread/cwd";
  import { gitStore, gitScope } from "$lib/features/git/store.svelte";
  import { todos } from "$lib/features/todo/store.svelte";
  import { ownsPoll, releasePoll } from "./poll-owner";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { toastInset } from "$lib/features/notifications/anchor.svelte";
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { formatAgo, formatSpan } from "$lib/shared/utils/relative-time";
  import { t } from "$lib/i18n/index.svelte";
  import { parseCombo, iconKeyForKind } from "$lib/features/fastpick/combo";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import { visibleStatus } from "$lib/domain/thread-status";
  import { threadActivitySince } from "$lib/features/thread/activity.svelte";
  import { projectUsage, formatTokens } from "$lib/features/project/usage.svelte";
  import { basename } from "$lib/shared/utils/path";
  import type { IconKey, Thread } from "$lib/types";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
  import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Circle from "@lucide/svelte/icons/circle";
  import Loader2 from "@lucide/svelte/icons/loader-2";
  import Clock from "@lucide/svelte/icons/clock";
  import Zap from "@lucide/svelte/icons/zap";

  /**
   * The project's vitals, in one box over the terminals.
   *
   * This replaces the docked column for whoever turned the experiment on: not a
   * place to operate on the repository, a place to know where you are. Which
   * branch this thread is on, which agent and model is active, which todo is in
   * progress or next up, dirty changes count, worktree isolation, and the latest
   * commits — read at a glance, never clicked. Hovering (or focusing) the box
   * unfolds the rest of the backlog, recent commits log, and token consumption.
   *
   * It reads the same stores the panels read, scoped the same way GitPanel is:
   * the thread's worktree when it has one, so an agent committing in its own
   * checkout is what the box describes, not the project folder it forked from.
   *
   * `thread` is what makes it a per-pane box: split view mounts one over every
   * terminal, each describing the checkout that terminal actually runs in.
   * Without it the box falls back to the selected project and its active
   * thread, which is what a single mount over the whole pane area wants.
   */

  const AUTO_REFRESH_MS = 10_000;
  const HOVER_LOG = 6;

  /**
   * `visible` is false for a box whose pane is off screen — another group, or
   * a view drawn over the terminals. Those panes stay mounted, so without it
   * every thread in the window would poll git for a pane nobody is looking at.
   */
  type Props = { thread?: Thread | null; visible?: boolean };
  let { thread = null, visible = true }: Props = $props();

  const project = $derived.by(() => {
    const id = thread?.projectId ?? app.currentProjectId;
    return id ? app.projects.find((p) => p.id === id) ?? null : null;
  });

  // Unpinned, only a thread of the project on screen: the active thread can
  // live in another project while this box describes the selected one.
  const threadHere = $derived(
    thread ??
      (app.activeThread && app.activeThread.projectId === project?.id
        ? app.activeThread
        : null),
  );

  const gitRoot = $derived(project ? threadGitRoot(threadHere, project) : null);
  const scope = $derived(project && gitRoot ? gitScope(project.id, gitRoot) : null);
  const gs = $derived(gitStore.get(scope));

  /**
   * The last checkout this box has actually read, as opposed to the one it is
   * pointed at now.
   *
   * A thread's worktree is not known the moment its row exists: it is created
   * around the launch, so the box resolves the project folder first and the
   * worktree a moment later. The store answers instantly for the folder, which
   * is the checkout every other thread of the project is describing, so a fresh
   * thread wore its neighbour's branch and last commit until its own directory
   * landed. Nothing is drawn for a checkout this box has not been answered
   * about. Not reset when the pane goes off screen: coming back to the same
   * directory is the case where showing ten-second-old numbers is the point.
   */
  let readScope = $state<string | null>(null);

  $effect(() => {
    if (!project || !gitRoot || !visible) return;
    const registered = gitStore.ensure(project.id, gitRoot);
    void gitStore.refresh(registered).then(() => {
      readScope = registered;
      return gitStore.autoFetch(registered);
    });
  });

  // The slow safety net, same period, same hidden-window and offline guards as
  // the git panel — this box is always mounted, so without the hidden guard a
  // minimised window would keep spawning git processes for the life of the app.
  // Gated on isRepo: a folder the first refresh found bare has nothing to poll.
  const pollToken = Symbol("infobox-poll");

  $effect(() => {
    const id = scope;
    if (!id || !isRepo || !visible) return;
    const poke = () => {
      if (document.hidden) return;
      // Asked every time, not once: whoever owns this repository's poll may
      // have unmounted since the last tick, and then this box inherits it.
      if (!ownsPoll(id, pollToken)) return;
      const remoteScoped =
        workspace.mode === "remote" ||
        (workspace.isDynamic && project?.origin === "remote");
      if (remoteScoped && workspace.connection !== "connected") return;
      void gitStore.refresh(id);
      void gitStore.autoFetch(id);
    };
    // Focus/visibility pokes give the instant refresh when the user comes back,
    // instead of waiting out whatever is left of the interval.
    const timer = setInterval(poke, AUTO_REFRESH_MS);
    window.addEventListener("focus", poke);
    document.addEventListener("visibilitychange", poke);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", poke);
      document.removeEventListener("visibilitychange", poke);
      releasePoll(id, pollToken);
    };
  });

  $effect(() => {
    void todos.ensureLoaded();
  });

  // Git state helpers
  const mine = $derived(scope !== null && readScope === scope);
  const commits = $derived(mine ? gs?.log.slice(0, HOVER_LOG) ?? [] : []);
  const isRepo = $derived(mine && (gs?.isRepo ?? false));
  const stagedCount = $derived(mine ? (gs?.staged.length ?? 0) : 0);
  const unstagedCount = $derived(mine ? (gs?.unstaged.length ?? 0) : 0);
  const conflictsCount = $derived(mine ? (gs?.conflicts.length ?? 0) : 0);
  const isWorktree = $derived(Boolean(threadHere?.worktreePath));
  const worktreeName = $derived(
    threadHere?.worktreePath ? basename(threadHere.worktreePath) : "",
  );

  // Agent / Thread context helpers
  const combo = $derived(
    threadHere ? parseCombo(threadHere.cmd, threadHere.args) : null,
  );
  const agentIconKey = $derived(
    (threadHere?.iconKey ??
      (combo ? iconKeyForKind(combo.harness) : null) ??
      "terminal") as IconKey,
  );
  const agentColor = $derived(threadHere ? threadIconColor(threadHere) : null);
  const agentName = $derived(
    combo
      ? combo.model
      : (threadHere?.title ?? threadHere?.label ?? threadHere?.cmd ?? ""),
  );
  const threadStatus = $derived(
    threadHere ? visibleStatus(threadHere.status, Boolean(threadHere.ptyId)) : null,
  );
  const activitySince = $derived(
    threadHere ? (threadActivitySince(threadHere.id) ?? threadHere.createdAt) : 0,
  );
  const statusSpan = $derived(
    activitySince > 0 ? Math.max(0, relativeClock.now - activitySince) : 0,
  );

  // Todo helpers: active claimed, open backlog, done summary
  const allTodos = $derived(todos.forProject(project?.id ?? null));
  const claimed = $derived(
    allTodos
      .filter((item) => item.state === "claimed")
      .sort((a, b) => b.updatedAt - a.updatedAt),
  );
  const openTodos = $derived(
    allTodos
      .filter((item) => item.state === "open")
      .sort((a, b) => a.position - b.position),
  );
  const doneTodos = $derived(
    allTodos.filter((item) => item.state === "done"),
  );

  // Token usage helper (read if already cached in projectUsage store)
  const report = $derived(project ? projectUsage.report(project.id) : null);
  const totalTokens = $derived.by(() => {
    if (!report?.models) return 0;
    return report.models.reduce((acc, m) => acc + m.total, 0);
  });

  // Nothing to say, no box: a project with no repository and no tasks or thread
  const hasContent = $derived(
    isRepo || claimed.length > 0 || openTodos.length > 0 || threadHere !== null,
  );

  // Same clock as the dashboard rows, so "2 h" reads the same in both and
  // stops ticking while the window is hidden.
  $effect(() => relativeClock.subscribe());

  function ago(tsSeconds: number): string {
    if (!tsSeconds) return "";
    return formatAgo(relativeClock.now - tsSeconds * 1000);
  }
</script>

{#if hasContent}
  <!-- role=group, not status: status is a live region, and a box that refreshes
       every ten seconds would re-announce itself to a screen reader on every
       branch or commit change, unprompted. The tabindex is what makes the hover
       expansion reachable from a keyboard (focus-within), which is exactly the
       combination the a11y rule cannot see. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="group w-84 max-w-full select-none outline-none"
    role="group"
    aria-label={t("infoBox.label")}
    tabindex="0"
  >
    <!-- use:toastInset: the toast stack lands in this same corner, and this is
         what sends it below the box instead of on top of it. On the card, so
         the unfolded log is measured too: it grows into exactly the room the
         stack was pushed into and draws under it, so a stack that stayed put
         would hide rows two to ten behind opaque toasts. Given `visible`
         because a box in another group is laid out in the same corner and
         measures the same way while nobody can see it. -->
    <div
      class="overflow-hidden rounded-lg border border-border bg-[var(--color-surface)]/95 shadow-md backdrop-blur transition group-hover:shadow-lg"
      use:toastInset={visible}
    >
      <!-- Line 1: Git Branch, ahead/behind, changes and worktree badge -->
      {#if isRepo}
        <div class="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-xs">
          <GitBranch class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="max-w-[8rem] truncate font-medium text-foreground">
            {gs?.branch ?? t("git.detached")}
          </span>
          {#if (gs?.ahead ?? 0) > 0}
            <span class="flex shrink-0 items-center text-2xs text-muted-foreground">
              <ArrowUp class="size-3" />{gs?.ahead}
            </span>
          {/if}
          {#if (gs?.behind ?? 0) > 0}
            <span class="flex shrink-0 items-center text-2xs text-muted-foreground">
              <ArrowDown class="size-3" />{gs?.behind}
            </span>
          {/if}

          <!-- Changes / Dirty indicator -->
          {#if conflictsCount > 0}
            <span
              class="flex shrink-0 items-center gap-0.5 rounded bg-[var(--color-danger)]/15 px-1 text-2xs font-semibold text-[var(--color-danger)]"
              title={t("infoBox.conflicts", { count: conflictsCount })}
            >
              <AlertTriangle class="size-2.5" />{conflictsCount}
            </span>
          {:else if stagedCount > 0 || unstagedCount > 0}
            <span class="flex shrink-0 items-center gap-1 font-mono text-2xs">
              {#if stagedCount > 0}
                <span class="text-[var(--color-success)] font-medium">+{stagedCount}</span>
              {/if}
              {#if unstagedCount > 0}
                <span class="text-[var(--color-warning)] font-medium">~{unstagedCount}</span>
              {/if}
            </span>
          {/if}

          <!-- Worktree indicator -->
          {#if isWorktree}
            <span
              class="ml-auto flex shrink-0 items-center gap-1 rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-2xs text-muted-foreground"
              title={threadHere?.worktreePath ?? ""}
            >
              <FolderGit2 class="size-3 text-muted-foreground/80" />
              <span class="max-w-[4.5rem] truncate">{worktreeName || t("infoBox.worktreeTag")}</span>
            </span>
          {/if}
        </div>
      {/if}

      <!-- Line 2: Active Agent & Live Thread Status -->
      {#if threadHere}
        <div class="flex items-center gap-1.5 border-t border-border/40 px-2.5 py-1 text-xs">
          <span class="relative flex size-3.5 shrink-0 items-center justify-center">
            <ShortcutIcon iconKey={agentIconKey} size={14} color={agentColor} />
          </span>
          <span class="max-w-[9rem] truncate font-medium text-foreground/90">{agentName}</span>

          {#if threadStatus === "running"}
            <span class="ml-auto flex shrink-0 items-center gap-1 text-2xs text-[var(--color-success)]">
              <Loader2 class="size-3 animate-spin" />
              <span>{statusSpan > 0 ? t("project.threadWorking", { span: formatSpan(statusSpan) }) : t("status.running")}</span>
            </span>
          {:else if threadStatus === "waiting"}
            <span class="ml-auto flex shrink-0 items-center gap-1 text-2xs font-medium text-[var(--color-warning)]">
              <Clock class="size-3 animate-pulse" />
              <span>{statusSpan > 0 ? t("project.threadWaiting", { span: formatSpan(statusSpan) }) : t("status.waiting")}</span>
            </span>
          {:else if threadStatus === "ready"}
            <span class="ml-auto flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
              <span class="size-1.5 rounded-full bg-[var(--color-success)]"></span>
              <span>{t("status.ready")}</span>
            </span>
          {:else if threadStatus === "idle"}
            <span class="ml-auto flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
              <span class="size-1.5 rounded-full bg-muted-foreground/40"></span>
              <span>{t("status.idle")}</span>
            </span>
          {:else if threadStatus === "stopped"}
            <span class="ml-auto flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
              <span class="font-mono">z</span>
              <span>{t("status.asleep")}</span>
            </span>
          {:else if threadStatus === "error" || threadStatus === "exited"}
            <span class="ml-auto flex shrink-0 items-center gap-1 text-2xs text-[var(--color-danger)]">
              <span>{t("status.error")}</span>
            </span>
          {/if}
        </div>
      {/if}

      <!-- Line 3: Active Task (Claimed or Next Open Todo) -->
      {#if claimed.length > 0}
        <div
          class="flex items-center gap-1.5 border-t border-border/40 px-2.5 py-1 text-xs"
          title={t("infoBox.claimedTitle", { agent: claimed[0].claimedBy ?? "" })}
        >
          <span class="relative flex size-3.5 shrink-0 items-center justify-center">
            <ShortcutIcon iconKey={claimed[0].claimedBy as IconKey} size={14} />
          </span>
          <span class="min-w-0 flex-1 truncate text-foreground/90">{claimed[0].title}</span>
          <span
            class="shrink-0 rounded bg-[var(--color-surface-3)] px-1 text-2xs text-muted-foreground"
          >
            {t("infoBox.claimedTag")}
          </span>
          {#if claimed.length > 1}
            <span class="shrink-0 rounded bg-[var(--color-surface-3)] px-1 text-2xs text-muted-foreground">
              {t("infoBox.moreClaimed", { count: claimed.length - 1 })}
            </span>
          {/if}
        </div>
      {:else if openTodos.length > 0}
        <div class="flex items-center gap-1.5 border-t border-border/40 px-2.5 py-1 text-xs">
          <ListTodo class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate text-foreground/80">{openTodos[0].title}</span>
          <span
            class="shrink-0 rounded bg-[var(--color-surface-3)] px-1 text-2xs text-muted-foreground"
          >
            {t("infoBox.openTag")}
          </span>
          {#if openTodos.length > 1}
            <span class="shrink-0 rounded bg-[var(--color-surface-3)] px-1 text-2xs text-muted-foreground">
              {t("infoBox.moreClaimed", { count: openTodos.length - 1 })}
            </span>
          {/if}
        </div>
      {/if}

      <!-- Line 4: Latest Commit -->
      {#if commits.length > 0}
        <div class="flex items-center gap-1.5 border-t border-border/40 px-2.5 py-1 text-xs">
          <GitCommitHorizontal class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="shrink-0 font-mono text-2xs text-muted-foreground">
            {commits[0].shortSha}
          </span>
          <span class="min-w-0 flex-1 truncate text-foreground/90">
            {commits[0].summary}
          </span>
          <span class="shrink-0 text-2xs text-muted-foreground/70">
            {ago(commits[0].time)}
          </span>
        </div>
      {/if}

      <!-- The unfold: remaining claimed items, next open tasks, task summary,
           remaining commits and token usage. -->
      {#if commits.length > 1 || claimed.length > 1 || openTodos.length > (claimed.length > 0 ? 0 : 1) || totalTokens > 0}
        <div
          class="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr]"
        >
          <div class="min-h-0 overflow-hidden">
            <!-- Other claimed items -->
            {#if claimed.length > 1}
              <div class="border-t border-border/60 py-0.5">
                {#each claimed.slice(1) as item (item.id)}
                  <div
                    class="flex items-center gap-1.5 px-2.5 py-0.5 text-xs"
                    title={t("infoBox.claimedTitle", { agent: item.claimedBy ?? "" })}
                  >
                    <span class="flex size-3.5 shrink-0 items-center justify-center">
                      <ShortcutIcon iconKey={item.claimedBy as IconKey} size={14} />
                    </span>
                    <span class="truncate text-foreground/80">{item.title}</span>
                  </div>
                {/each}
              </div>
            {/if}

            <!-- Next open backlog tasks (up to 3) -->
            {#if openTodos.length > 0}
              {@const nextOpen = claimed.length > 0 ? openTodos.slice(0, 3) : openTodos.slice(1, 4)}
              {#if nextOpen.length > 0}
                <div class="border-t border-border/60 py-0.5">
                  {#each nextOpen as item (item.id)}
                    <div class="flex items-center gap-1.5 px-2.5 py-0.5 text-xs text-muted-foreground">
                      <Circle class="size-3 shrink-0 text-muted-foreground/60" />
                      <span class="truncate text-foreground/80">{item.title}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}

            <!-- Todo counts summary -->
            {#if allTodos.length > 0}
              <div class="flex items-center gap-2 border-t border-border/40 px-2.5 py-1 text-2xs text-muted-foreground/70">
                <span>{claimed.length} {t("infoBox.claimedSummary")}</span>
                <span>·</span>
                <span>{openTodos.length} {t("infoBox.openSummary")}</span>
                {#if doneTodos.length > 0}
                  <span>·</span>
                  <span>{doneTodos.length} {t("infoBox.doneSummary")}</span>
                {/if}
              </div>
            {/if}

            <!-- Remaining commits log (up to 6) -->
            {#if commits.length > 1}
              <div class="border-t border-border/60 py-0.5">
                {#each commits.slice(1) as commit (commit.sha)}
                  <div class="flex items-center gap-1.5 px-2.5 py-0.5 text-xs">
                    <span class="w-3.5 shrink-0"></span>
                    <span class="shrink-0 font-mono text-2xs text-muted-foreground">
                      {commit.shortSha}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-foreground/80">
                      {commit.summary}
                    </span>
                    <span class="shrink-0 text-2xs text-muted-foreground/70">
                      {ago(commit.time)}
                    </span>
                  </div>
                {/each}
              </div>
            {/if}

            <!-- Token usage stats footer -->
            {#if totalTokens > 0}
              <div class="flex items-center justify-between border-t border-border/60 bg-[var(--color-surface-2)] px-2.5 py-1 text-2xs text-muted-foreground">
                <span class="flex items-center gap-1">
                  <Zap class="size-3 text-muted-foreground" />
                  <span>{t("infoBox.tokensUsed", { tokens: formatTokens(totalTokens) })}</span>
                </span>
                {#if (report?.sessions ?? 0) > 0}
                  <span>{report?.sessions} {t("stats.sessions")}</span>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}
