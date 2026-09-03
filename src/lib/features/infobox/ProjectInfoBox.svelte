<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { workspace } from "$lib/backend";
  import { threadGitRoot } from "$lib/features/thread/cwd";
  import { gitStore, gitScope } from "$lib/features/git/store.svelte";
  import { todos } from "$lib/features/todo/store.svelte";
  import { ownsPoll, releasePoll } from "./poll-owner";
  import {
    INFO_BOX_GUTTER_PX,
    INFO_BOX_LOG,
    INFO_BOX_POPOVER_PX,
    INFO_BOX_ROW_PX,
    popoverLeft,
  } from "./strip";
  import { settings } from "$lib/features/settings/store.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import { remeasureToastClaims, toastInset } from "$lib/features/notifications/anchor.svelte";
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
  import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
  import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Circle from "@lucide/svelte/icons/circle";
  import Zap from "@lucide/svelte/icons/zap";

  /**
   * The project's vitals, in one row above the terminals.
   *
   * This replaces the docked column for whoever turned the experiment on: not a
   * place to operate on the repository, a place to know where you are. Which
   * branch this thread is on, which agent and model is active, and the latest
   * commit, read at a glance and never clicked. The rest of the backlog, the
   * log and the token count are one click on the commit cell away, and a hover
   * over it opens the same thing.
   *
   * It is a strip rather than a card on purpose. The card floated over the
   * terminal's top-right corner and covered the first 330 px of the first four
   * lines of output for the whole session (audit finding 4), which is where a
   * command's own first lines land. The strip takes 32 px off the top of the
   * column instead, so nothing is ever drawn over output. There is one
   * position, so the eight docks and the drag that picked between them are
   * gone, `infoBoxAnchor` with them.
   *
   * It reads the same stores the panels read, scoped the same way GitPanel is:
   * the thread's worktree when it has one, so an agent committing in its own
   * checkout is what the box describes, not the project folder it forked from.
   *
   * `thread` is what makes it a per-pane strip: split view mounts one over
   * every terminal, each describing the checkout that terminal actually runs
   * in, and each spanning its own column rather than the group. Without it the
   * box falls back to the selected project and its active thread.
   *
   * The folded state lives on the device settings, so every thread and every
   * group draws the same row.
   */

  const AUTO_REFRESH_MS = 10_000;

  /**
   * `visible` is false for a box whose pane is off screen, another group, or
   * a view drawn over the terminals. Those panes stay mounted, so without it
   * every thread in the window would poll git for a pane nobody is looking at.
   * `focused` is which pane the toast stack should follow when several strips
   * are standing.
   */
  type Props = { thread?: Thread | null; visible?: boolean; focused?: boolean };
  let { thread = null, visible = true, focused = false }: Props = $props();

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
  // the git panel: this box is always mounted, so without the hidden guard a
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
  const commits = $derived(mine ? gs?.log.slice(0, INFO_BOX_LOG) ?? [] : []);
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
  // The span reads as the state's age, so it only replaces the plain label
  // while the state is one that is being waited out.
  const statusLabel = $derived.by(() => {
    if (threadStatus === "running") {
      return statusSpan > 0
        ? t("project.threadWorking", { span: formatSpan(statusSpan) })
        : t("status.running");
    }
    if (threadStatus === "waiting") {
      return statusSpan > 0
        ? t("project.threadWaiting", { span: formatSpan(statusSpan) })
        : t("status.waiting");
    }
    if (threadStatus === "ready") return t("status.ready");
    if (threadStatus === "idle") return t("status.idle");
    if (threadStatus === "stopped") return t("status.asleep");
    if (threadStatus === "error" || threadStatus === "exited") return t("status.error");
    return "";
  });

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

  const collapsed = $derived(settings.state.infoBoxCollapsed);

  let stripEl = $state<HTMLElement | null>(null);
  let logEl = $state<HTMLElement | null>(null);
  let columnWidth = $state(0);
  let anchorX = $state(0);

  /**
   * The log is pinned by a click and shown by a hover.
   *
   * The audit could not verify the ten-commit hover at all: it opened on a
   * pointer resting over a floating card and closed the moment the pointer
   * left, so there was no way to read it and no way to reach it with a
   * keyboard. The click is the way in that stays, Escape is the way out, and
   * the hover is the one that was already there.
   */
  let pinned = $state(false);
  let hovering = $state(false);
  const logOpen = $derived(commits.length > 0 && (pinned || hovering));

  // The task the row shows when there is no repository to hang a commit off.
  const topTodo = $derived(claimed[0] ?? openTodos[0] ?? null);

  const popLeft = $derived(
    popoverLeft(columnWidth, INFO_BOX_POPOVER_PX, anchorX, INFO_BOX_GUTTER_PX),
  );

  $effect(() => {
    const el = stripEl;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) columnWidth = r.width;
      const trigger = logEl;
      if (trigger) anchorX = trigger.getBoundingClientRect().left - r.left;
    };
    const observer = new ResizeObserver(read);
    observer.observe(el);
    read();
    return () => observer.disconnect();
  });

  // The strip never moves, but it appears, folds and unfolds, and the toast
  // stack sits under whichever one is standing.
  $effect(() => {
    void collapsed;
    void visible;
    void focused;
    remeasureToastClaims();
  });

  // Same clock as the dashboard rows, so "2 h" reads the same in both and
  // stops ticking while the window is hidden.
  $effect(() => relativeClock.subscribe());

  function ago(tsSeconds: number): string {
    if (!tsSeconds) return "";
    return formatAgo(relativeClock.now - tsSeconds * 1000);
  }

  function measureAnchor() {
    const el = stripEl;
    const trigger = logEl;
    if (!el || !trigger) return;
    anchorX = trigger.getBoundingClientRect().left - el.getBoundingClientRect().left;
  }

  function toggleLog() {
    measureAnchor();
    pinned = !pinned;
  }

  // Escape closes what a click opened. Hover and focus close themselves.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !pinned) return;
    e.stopPropagation();
    pinned = false;
    logEl?.focus();
  }

  const toastParams = $derived({
    standing: visible,
    focused,
    // The strip is at the top of the column and spans it, so the stack hangs
    // under it and lines up with its right edge.
    stack: "below" as const,
    align: "right" as const,
  });
</script>

<div
  bind:this={stripEl}
  class="strip"
  class:collapsed
  role="group"
  aria-label={t("infoBox.label")}
  style:height="{INFO_BOX_ROW_PX}px"
  use:toastInset={toastParams}
>
  <!-- Branch, ahead and behind, what is dirty, and the worktree this thread
       runs in. The cell a folded row keeps: it is the answer to "where am I",
       and the rest is detail beside it. -->
  {#if isRepo}
    <span class="cell">
      <GitBranch class="size-3.5 shrink-0 text-muted-foreground" />
      <span class="max-w-[10rem] truncate font-medium text-foreground">
        {gs?.branch ?? t("git.detached")}
      </span>
      {#if (gs?.ahead ?? 0) > 0}
        <span class="flex shrink-0 items-center text-xs text-muted-foreground">
          <ArrowUp class="size-3" />{gs?.ahead}
        </span>
      {/if}
      {#if (gs?.behind ?? 0) > 0}
        <span class="flex shrink-0 items-center text-xs text-muted-foreground">
          <ArrowDown class="size-3" />{gs?.behind}
        </span>
      {/if}

      {#if conflictsCount > 0}
        <span
          class="flex shrink-0 items-center gap-0.5 rounded bg-[var(--color-danger)]/15 px-1 text-xs font-semibold text-[var(--color-danger)]"
          use:tip={t("infoBox.conflicts", { count: conflictsCount })}
        >
          <AlertTriangle class="size-2.5" />{conflictsCount}
        </span>
      {:else if stagedCount > 0 || unstagedCount > 0}
        <span class="flex shrink-0 items-center gap-1 font-mono text-xs">
          {#if stagedCount > 0}
            <span class="font-medium text-[var(--color-success)]">+{stagedCount}</span>
          {/if}
          {#if unstagedCount > 0}
            <span class="font-medium text-[var(--color-warning)]">~{unstagedCount}</span>
          {/if}
        </span>
      {/if}
    </span>
  {/if}

  <!-- Which agent is behind this terminal, and what it is doing right now. The
       dot survives the fold: it is the one live datum, and the card that this
       replaced dropped it exactly when it was folded out of the way. -->
  {#if threadHere && threadStatus}
    <span class="cell state">
      <span class="relative flex size-3.5 shrink-0 items-center justify-center">
        <ShortcutIcon iconKey={agentIconKey} size={14} color={agentColor} />
      </span>
      {#if !collapsed}
        <span class="max-w-[9rem] truncate font-medium text-foreground">{agentName}</span>
      {/if}
      <StatusDot status={threadStatus} />
      {#if !collapsed && statusLabel}
        <span class="shrink-0 text-xs text-muted-foreground">{statusLabel}</span>
      {/if}
    </span>
  {/if}

  {#if !collapsed && isWorktree}
    <span
      class="cell rounded bg-[var(--color-surface-3)] px-1.5 text-xs text-muted-foreground"
      use:tip={threadHere?.worktreePath ?? ""}
    >
      <FolderGit2 class="size-3 text-muted-2" />
      <span class="max-w-[6rem] truncate">
        {worktreeName || t("infoBox.worktreeTag")}
      </span>
    </span>
  {/if}

  <!-- The last commit, and the way into everything the row has no space for.
       Hover keeps working; the click is what makes it readable and reachable. -->
  {#if !collapsed && commits.length > 0}
    <div
      class="log"
      role="group"
      aria-label={t("infoBox.log")}
      onpointerenter={() => {
        measureAnchor();
        hovering = true;
      }}
      onpointerleave={() => (hovering = false)}
    >
      <button
        bind:this={logEl}
        type="button"
        class="trigger"
        aria-expanded={logOpen}
        aria-label={t("infoBox.log")}
        onclick={toggleLog}
        onkeydown={onKeyDown}
      >
        <GitCommitHorizontal class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="shrink-0 font-mono text-xs text-muted-foreground">
          {commits[0].shortSha}
        </span>
        <span class="min-w-0 flex-1 truncate text-left text-foreground">
          {commits[0].summary}
        </span>
        <span class="shrink-0 text-xs text-muted-2">{ago(commits[0].time)}</span>
      </button>

      {#if logOpen}
        <!-- Anchored to the strip rather than to the pointer: it is the same
             list the hover showed, and it stays put while it is read. -->
        <div
          class="popover"
          style:left="{popLeft}px"
          style:width="{INFO_BOX_POPOVER_PX}px"
        >
          {#if claimed.length > 0}
            <div class="section">
              {#each claimed as item (item.id)}
                <div
                  class="line"
                  use:tip={t("infoBox.claimedTitle", { agent: item.claimedBy ?? "" })}
                >
                  <span class="flex size-3.5 shrink-0 items-center justify-center">
                    <ShortcutIcon iconKey={item.claimedBy as IconKey} size={14} />
                  </span>
                  <span class="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
                  <span class="tag">{t("infoBox.claimedTag")}</span>
                </div>
              {/each}
            </div>
          {/if}

          {#if openTodos.length > 0}
            <div class="section">
              {#each openTodos.slice(0, 4) as item (item.id)}
                <div class="line">
                  <ListTodo class="size-3.5 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
                  <span class="tag">{t("infoBox.openTag")}</span>
                </div>
              {/each}
              {#if openTodos.length > 4}
                <div class="line">
                  <Circle class="size-3 shrink-0 text-muted-2" />
                  <span class="text-xs text-muted-2">
                    {t("infoBox.moreClaimed", { count: openTodos.length - 4 })}
                  </span>
                </div>
              {/if}
            </div>
          {/if}

          {#if allTodos.length > 0}
            <div class="section">
              <div class="line">
                <span class="flex items-center gap-2 text-xs text-muted-2">
                  <span>{claimed.length} {t("infoBox.claimedSummary")}</span>
                  <span>·</span>
                  <span>{openTodos.length} {t("infoBox.openSummary")}</span>
                  {#if doneTodos.length > 0}
                    <span>·</span>
                    <span>{doneTodos.length} {t("infoBox.doneSummary")}</span>
                  {/if}
                </span>
              </div>
            </div>
          {/if}

          <div class="section">
            {#each commits as commit (commit.sha)}
              <div class="line">
                <span class="shrink-0 font-mono text-xs text-muted-foreground">
                  {commit.shortSha}
                </span>
                <span class="min-w-0 flex-1 truncate text-foreground">{commit.summary}</span>
                <span class="shrink-0 text-xs text-muted-2">{ago(commit.time)}</span>
              </div>
            {/each}
          </div>

          {#if totalTokens > 0}
            <div class="section">
              <div class="line justify-between">
                <span class="flex items-center gap-1 text-xs text-muted-foreground">
                  <Zap class="size-3 text-muted-foreground" />
                  <span>{t("infoBox.tokensUsed", { tokens: formatTokens(totalTokens) })}</span>
                </span>
                {#if (report?.sessions ?? 0) > 0}
                  <span class="text-xs text-muted-foreground">
                    {report?.sessions} {t("stats.sessions")}
                  </span>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {:else if !collapsed && topTodo}
    <!-- No repository, so no commit cell and no log to open. The work in
         progress is what the row has left to say, and it says it flat. -->
    <div class="log">
      <span
        class="cell min-w-0 flex-1 justify-end"
        use:tip={claimed.length > 0
          ? t("infoBox.claimedTitle", { agent: topTodo.claimedBy ?? "" })
          : t("infoBox.openTag")}
      >
        <ListTodo class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="min-w-0 truncate text-foreground">{topTodo.title}</span>
        <span class="tag">
          {claimed.length > 0 ? t("infoBox.claimedTag") : t("infoBox.openTag")}
        </span>
      </span>
    </div>
  {/if}

  <button
    type="button"
    class="fold"
    aria-expanded={!collapsed}
    aria-label={collapsed ? t("infoBox.expand") : t("infoBox.collapse")}
    use:tip={collapsed ? t("infoBox.expand") : t("infoBox.collapse")}
    onclick={() => settings.setInfoBoxCollapsed(!collapsed)}
  >
    {#if collapsed}
      <ChevronsUpDown class="size-3.5" />
    {:else}
      <ChevronsDownUp class="size-3.5" />
    {/if}
  </button>
</div>

<style>
  /* One row across the top of the column the terminal is drawn in. The
     terminal is inset by exactly `INFO_BOX_ROW_PX` in `+page.svelte`, which is
     what makes "no output under the box" a fact rather than a hope. */
  .strip {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: var(--z-pane-overlay);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    padding: 0 0.25rem 0 0.5rem;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  /* Shrinkable rather than fixed: a 420px column holds the branch, the agent
     and the worktree tag only if each of them gives up its own slack first,
     and every one of them has a `truncate` span to give it with. */
  .cell {
    display: inline-flex;
    flex: 0 1 auto;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }

  /* The row folds to the branch and the state, and both stay where they were:
     a fold that moved them would read as two different rows. */
  .strip.collapsed .state {
    gap: 0.25rem;
  }

  .log {
    position: relative;
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    align-items: center;
    justify-content: flex-end;
  }

  .trigger {
    display: flex;
    min-width: 0;
    max-width: 100%;
    align-items: center;
    gap: 0.375rem;
    border-radius: var(--radius-xs);
    padding: 0.125rem 0.375rem;
    color: inherit;
    transition: background-color var(--dur-1) ease;
  }

  .trigger:hover {
    background: var(--color-surface-2);
  }

  .trigger:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-foreground) 45%, transparent);
    outline-offset: 1px;
  }

  .popover {
    position: absolute;
    top: calc(100% + 0.25rem);
    z-index: 1;
    overflow: hidden;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: color-mix(in srgb, var(--color-surface) 96%, transparent);
    box-shadow: var(--shadow-e3);
    backdrop-filter: blur(12px);
    white-space: nowrap;
  }

  .section + .section {
    border-top: 1px solid var(--color-border);
  }

  .line {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.2rem 0.5rem;
    font-size: var(--text-sm);
  }

  .tag {
    flex-shrink: 0;
    border-radius: var(--radius-xs);
    background: var(--color-surface-3);
    padding: 0 0.25rem;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .fold {
    display: inline-flex;
    flex-shrink: 0;
    margin-left: auto;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: var(--radius-xs);
    color: var(--color-muted-foreground);
    transition:
      background-color var(--dur-1) ease,
      color var(--dur-1) ease;
  }

  .fold:hover {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  .fold:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-foreground) 45%, transparent);
    outline-offset: 1px;
  }
</style>
