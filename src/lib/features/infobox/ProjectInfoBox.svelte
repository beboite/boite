<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { workspace } from "$lib/backend";
  import { threadGitRoot } from "$lib/features/thread/cwd";
  import { gitStore, gitScope } from "$lib/features/git/store.svelte";
  import { todos } from "$lib/features/todo/store.svelte";
  import { ownsPoll, releasePoll } from "./poll-owner";
  import {
    INFO_BOX_ANCHORS,
    INFO_BOX_GUTTER_REM,
    anchorForPoint,
    clampToPane,
    snapPoint,
    toastAlignFor,
    toastStackFor,
  } from "./anchor";
  import { settings } from "$lib/features/settings/store.svelte";
  import { DUR } from "$lib/theme/motion";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import {
    followToastSnap,
    remeasureToastClaims,
    toastInset,
  } from "$lib/features/notifications/anchor.svelte";
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { formatAgo, formatSpan } from "$lib/shared/utils/relative-time";
  import { t } from "$lib/i18n/index.svelte";
  import { parseCombo, iconKeyForKind } from "$lib/features/fastpick/combo";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import { visibleStatus } from "$lib/domain/thread-status";
  import { threadActivitySince } from "$lib/features/thread/activity.svelte";
  import { projectUsage, formatTokens } from "$lib/features/project/usage.svelte";
  import { basename } from "$lib/shared/utils/path";
  import type { IconKey, InfoBoxAnchor, Thread } from "$lib/types";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
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
   * progress or next up, the dirty count, worktree isolation and the latest
   * commit, read at a glance and never clicked. Hovering (or focusing) the box
   * unfolds the rest of the backlog, the log and the token count, and leaving
   * folds it back. A button folds the whole card to its header; a drag docks it
   * on any of the eight edges.
   *
   * It reads the same stores the panels read, scoped the same way GitPanel is:
   * the thread's worktree when it has one, so an agent committing in its own
   * checkout is what the box describes, not the project folder it forked from.
   *
   * `thread` is what makes it a per-pane box: split view mounts one over every
   * terminal, each describing the checkout that terminal actually runs in.
   * Without it the box falls back to the selected project and its active
   * thread, which is what a single mount over the whole pane area wants.
   *
   * Position and folded state live on the device settings, so every thread and
   * every group draws the same dock.
   */

  const AUTO_REFRESH_MS = 10_000;
  const HOVER_LOG = 6;
  const DRAG_THRESHOLD = 4;

  /**
   * `visible` is false for a box whose pane is off screen, another group, or
   * a view drawn over the terminals. Those panes stay mounted, so without it
   * every thread in the window would poll git for a pane nobody is looking at.
   * `focused` is which pane the toast stack should follow when several boxes
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

  const collapsed = $derived(settings.state.infoBoxCollapsed);
  const dock = $derived(settings.state.infoBoxAnchor);

  let hostEl = $state<HTMLElement | null>(null);
  let cardEl = $state<HTMLElement | null>(null);
  let pane = $state({ w: 0, h: 0 });
  let boxSize = $state({ w: 320, h: 40 });

  const gutter = $derived.by(() => {
    if (typeof window === "undefined") return INFO_BOX_GUTTER_REM * 16;
    const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return INFO_BOX_GUTTER_REM * (Number.isFinite(root) ? root : 16);
  });

  let dragging = $state(false);
  let dragPos = $state({ x: 0, y: 0 });
  let hoverSnap = $state<InfoBoxAnchor | null>(null);
  // The dock the pointer is aiming at while dragging, so the stack flips to
  // above/left before the drop rather than jumping after it.
  const liveDock = $derived(hoverSnap ?? dock);
  const stack = $derived(toastStackFor(liveDock));
  const align = $derived(toastAlignFor(liveDock));

  const settled = $derived(snapPoint(pane, boxSize, gutter, dock));
  const left = $derived(dragging ? dragPos.x : settled.x);
  const top = $derived(dragging ? dragPos.y : settled.y);

  $effect(() => {
    const host = hostEl;
    const card = cardEl;
    if (!host || !card) return;
    const read = () => {
      const hr = host.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      if (hr.width > 0 && hr.height > 0) pane = { w: hr.width, h: hr.height };
      if (cr.width > 0 && cr.height > 0) boxSize = { w: cr.width, h: cr.height };
    };
    const observer = new ResizeObserver(read);
    observer.observe(host);
    observer.observe(card);
    read();
    return () => observer.disconnect();
  });

  $effect(() => {
    void left;
    void top;
    void boxSize.h;
    void visible;
    void focused;
    void stack;
    void align;
    remeasureToastClaims();
  });

  // Same clock as the dashboard rows, so "2 h" reads the same in both and
  // stops ticking while the window is hidden.
  $effect(() => relativeClock.subscribe());

  function ago(tsSeconds: number): string {
    if (!tsSeconds) return "";
    return formatAgo(relativeClock.now - tsSeconds * 1000);
  }

  type DragSession = {
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    paneX: number;
    paneY: number;
    armed: boolean;
  };
  let session: DragSession | null = null;

  function pointerFromButton(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest("button"));
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (pointerFromButton(e.target)) return;
    if (!hostEl) return;
    e.preventDefault();
    const host = hostEl.getBoundingClientRect();
    session = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: left,
      originY: top,
      paneX: host.left,
      paneY: host.top,
      armed: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!session || e.pointerId !== session.pointerId) return;
    const dx = e.clientX - session.startX;
    const dy = e.clientY - session.startY;
    if (!session.armed) {
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      session.armed = true;
      dragging = true;
    }
    const next = clampToPane(
      pane,
      boxSize,
      gutter,
      session.originX + dx,
      session.originY + dy,
    );
    dragPos = next;
    // Aimed at the pointer, not at the box: the card is clamped inside the pane
    // and is wide, so its own centre barely moves near an edge. Throw the
    // cursor at the corner you want and release, the card follows.
    hoverSnap = anchorForPoint(
      pane,
      e.clientX - session.paneX,
      e.clientY - session.paneY,
      dock,
    );
  }

  function onPointerUp(e: PointerEvent) {
    if (!session || e.pointerId !== session.pointerId) return;
    const armed = session.armed;
    const snap = armed
      ? anchorForPoint(pane, e.clientX - session.paneX, e.clientY - session.paneY, dock)
      : null;
    session = null;
    dragging = false;
    hoverSnap = null;
    if (snap) settings.setInfoBoxAnchor(snap);
    // The card eases to the dock over --dur-3. ResizeObserver ignores left/top,
    // so without this the stack stays at the drop point while the box leaves.
    if (armed) followToastSnap(DUR.slow);
  }

  function ghostStyle(anchor: InfoBoxAnchor): string {
    const p = snapPoint(pane, boxSize, gutter, anchor);
    return `left:${p.x}px;top:${p.y}px;width:${boxSize.w}px;height:${boxSize.h}px`;
  }

  const toastParams = $derived({
    standing: visible && hasContent,
    focused,
    stack,
    align,
  });
</script>

{#if hasContent}
  <div class="host" bind:this={hostEl}>
    {#if dragging}
      <div class="snaps" aria-hidden="true">
        {#each INFO_BOX_ANCHORS as anchor (anchor)}
          {@const p = snapPoint(pane, boxSize, gutter, anchor)}
          <div
            class="dot"
            class:near={anchor === hoverSnap}
            style:left="{p.x + boxSize.w / 2}px"
            style:top="{p.y + boxSize.h / 2}px"
          ></div>
          {#if anchor === hoverSnap}
            <div class="ghost" style={ghostStyle(anchor)}></div>
          {/if}
        {/each}
      </div>
    {/if}

    <!-- role=group, not status: status is a live region, and a box that refreshes
         every ten seconds would re-announce itself to a screen reader on every
         branch or commit change, unprompted. The tabindex is what makes the hover
         expansion reachable from a keyboard (focus-within), which is exactly the
         combination the a11y rule cannot see. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- use:toastInset: the toast stack attaches to this box, below it, or
         above it when the box is on a bottom edge. On the card, so the unfolded
         log is measured too. Given `visible` and `focused` because a box in
         another group is laid out and measures the same way while nobody can
         see it. -->
    <div
      bind:this={cardEl}
      class="card"
      class:dragging
      class:collapsed
      class:group={!dragging && !collapsed}
      role="group"
      aria-label={t("infoBox.label")}
      tabindex="0"
      style:left="{left}px"
      style:top="{top}px"
      use:toastInset={toastParams}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    >
      <div class="shell">
        <div class="toolbar">
          <span class="grip" aria-hidden="true" use:tip={t("infoBox.drag")}>
            <GripVertical class="size-3" />
          </span>
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

        <!-- Branch, ahead and behind, what is dirty, and the worktree this
             thread runs in. The one row a folded card keeps: it is the answer
             to "where am I", and the rest is detail under it. -->
        {#if isRepo}
          <div class="row">
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

            {#if conflictsCount > 0}
              <span
                class="flex shrink-0 items-center gap-0.5 rounded bg-[var(--color-danger)]/15 px-1 text-2xs font-semibold text-[var(--color-danger)]"
                use:tip={t("infoBox.conflicts", { count: conflictsCount })}
              >
                <AlertTriangle class="size-2.5" />{conflictsCount}
              </span>
            {:else if stagedCount > 0 || unstagedCount > 0}
              <span class="flex shrink-0 items-center gap-1 font-mono text-2xs">
                {#if stagedCount > 0}
                  <span class="font-medium text-[var(--color-success)]">+{stagedCount}</span>
                {/if}
                {#if unstagedCount > 0}
                  <span class="font-medium text-[var(--color-warning)]">~{unstagedCount}</span>
                {/if}
              </span>
            {/if}

            {#if isWorktree}
              <span
                class="ml-auto flex shrink-0 items-center gap-1 rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-2xs text-muted-foreground"
                use:tip={threadHere?.worktreePath ?? ""}
              >
                <FolderGit2 class="size-3 text-muted-2" />
                <span class="max-w-[4.5rem] truncate">
                  {worktreeName || t("infoBox.worktreeTag")}
                </span>
              </span>
            {/if}
          </div>
        {/if}

        <!-- Which agent is behind this terminal, and what it is doing right
             now. Off while folded: a card folded to its header is one line. -->
        {#if !collapsed && threadHere}
          <div class="row">
            <span class="relative flex size-3.5 shrink-0 items-center justify-center">
              <ShortcutIcon iconKey={agentIconKey} size={14} color={agentColor} />
            </span>
            <span class="max-w-[9rem] truncate font-medium text-foreground">{agentName}</span>

            {#if threadStatus === "running"}
              <span
                class="ml-auto flex shrink-0 items-center gap-1 text-2xs text-[var(--color-success)]"
              >
                <Loader2 class="size-3 animate-spin" />
                <span>
                  {statusSpan > 0
                    ? t("project.threadWorking", { span: formatSpan(statusSpan) })
                    : t("status.running")}
                </span>
              </span>
            {:else if threadStatus === "waiting"}
              <span
                class="ml-auto flex shrink-0 items-center gap-1 text-2xs font-medium text-[var(--color-warning)]"
              >
                <Clock class="size-3 animate-pulse" />
                <span>
                  {statusSpan > 0
                    ? t("project.threadWaiting", { span: formatSpan(statusSpan) })
                    : t("status.waiting")}
                </span>
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
              <span
                class="ml-auto flex shrink-0 items-center gap-1 text-2xs text-[var(--color-danger)]"
              >
                <span>{t("status.error")}</span>
              </span>
            {/if}
          </div>
        {/if}

        <!-- The work in progress: what an agent claimed, or the next open task
             when nothing is claimed. A folded card keeps it only when there is
             no repository, since then it is the only line the box has. -->
        {#if claimed.length > 0 && (!collapsed || !isRepo)}
          <div
            class="row"
            use:tip={t("infoBox.claimedTitle", { agent: claimed[0].claimedBy ?? "" })}
          >
            <span class="relative flex size-3.5 shrink-0 items-center justify-center">
              <ShortcutIcon iconKey={claimed[0].claimedBy as IconKey} size={14} />
            </span>
            <span class="min-w-0 flex-1 truncate text-foreground">{claimed[0].title}</span>
            <!-- What this row is. An agent's title can be anything, a test name
                 included, and the agent's own icon beside it says who without
                 ever saying what: the line read as a stray message sitting above
                 the commit. The tag is the one part that cannot truncate. -->
            <span class="tag">{t("infoBox.claimedTag")}</span>
            {#if claimed.length > 1}
              <span class="tag">{t("infoBox.moreClaimed", { count: claimed.length - 1 })}</span>
            {/if}
          </div>
        {:else if !collapsed && openTodos.length > 0}
          <div class="row">
            <ListTodo class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate text-foreground">{openTodos[0].title}</span>
            <span class="tag">{t("infoBox.openTag")}</span>
            {#if openTodos.length > 1}
              <span class="tag">{t("infoBox.moreClaimed", { count: openTodos.length - 1 })}</span>
            {/if}
          </div>
        {/if}

        {#if !collapsed && commits.length > 0}
          <div class="row">
            <GitCommitHorizontal class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="shrink-0 font-mono text-2xs text-muted-foreground">
              {commits[0].shortSha}
            </span>
            <span class="min-w-0 flex-1 truncate text-foreground">
              {commits[0].summary}
            </span>
            <span class="shrink-0 text-2xs text-muted-2">
              {ago(commits[0].time)}
            </span>
          </div>
        {/if}

        <!-- The unfold: the rest of the claimed work, the next open tasks, the
             task counts, the rest of the log and what the project has spent. A
             grid row going 0fr to 1fr animates height without measuring
             anything. Off while folded or while a drag is live, so the card
             does not grow under the pointer. -->
        {#if !collapsed && (commits.length > 1 || claimed.length > 1 || openTodos.length > (claimed.length > 0 ? 0 : 1) || totalTokens > 0)}
          <div
            class="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr]"
          >
            <div class="min-h-0 overflow-hidden">
              {#if claimed.length > 1}
                <div class="border-t border-border/60 py-0.5">
                  {#each claimed.slice(1) as item (item.id)}
                    <div
                      class="row dim"
                      use:tip={t("infoBox.claimedTitle", { agent: item.claimedBy ?? "" })}
                    >
                      <span class="flex size-3.5 shrink-0 items-center justify-center">
                        <ShortcutIcon iconKey={item.claimedBy as IconKey} size={14} />
                      </span>
                      <span class="truncate text-foreground">{item.title}</span>
                    </div>
                  {/each}
                </div>
              {/if}

              {#if openTodos.length > 0}
                {@const nextOpen =
                  claimed.length > 0 ? openTodos.slice(0, 3) : openTodos.slice(1, 4)}
                {#if nextOpen.length > 0}
                  <div class="border-t border-border/60 py-0.5">
                    {#each nextOpen as item (item.id)}
                      <div class="row dim text-muted-foreground">
                        <Circle class="size-3 shrink-0 text-muted-2" />
                        <span class="truncate text-foreground">{item.title}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
              {/if}

              {#if allTodos.length > 0}
                <div class="row dim border-t border-border/40">
                  <span class="flex items-center gap-2 text-2xs text-muted-2">
                    <span>{claimed.length} {t("infoBox.claimedSummary")}</span>
                    <span>·</span>
                    <span>{openTodos.length} {t("infoBox.openSummary")}</span>
                    {#if doneTodos.length > 0}
                      <span>·</span>
                      <span>{doneTodos.length} {t("infoBox.doneSummary")}</span>
                    {/if}
                  </span>
                </div>
              {/if}

              {#if commits.length > 1}
                <div class="border-t border-border/60 py-0.5">
                  {#each commits.slice(1) as commit (commit.sha)}
                    <div class="row dim">
                      <span class="w-3.5 shrink-0"></span>
                      <span class="shrink-0 font-mono text-2xs text-muted-foreground">
                        {commit.shortSha}
                      </span>
                      <span class="min-w-0 flex-1 truncate text-foreground">
                        {commit.summary}
                      </span>
                      <span class="shrink-0 text-2xs text-muted-2">
                        {ago(commit.time)}
                      </span>
                    </div>
                  {/each}
                </div>
              {/if}

              {#if totalTokens > 0}
                <div
                  class="row dim justify-between border-t border-border/60 bg-[var(--color-surface-2)]"
                >
                  <span class="flex items-center gap-1 text-2xs text-muted-foreground">
                    <Zap class="size-3 text-muted-foreground" />
                    <span>{t("infoBox.tokensUsed", { tokens: formatTokens(totalTokens) })}</span>
                  </span>
                  {#if (report?.sessions ?? 0) > 0}
                    <span class="text-2xs text-muted-foreground">
                      {report?.sessions} {t("stats.sessions")}
                    </span>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .host {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: var(--z-pane-overlay);
  }

  .snaps {
    position: absolute;
    inset: 0;
  }

  .dot {
    position: absolute;
    width: 6px;
    height: 6px;
    margin: -3px 0 0 -3px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-foreground) 28%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-surface) 55%, transparent);
    transition:
      transform var(--dur-2) ease,
      background-color var(--dur-2) ease;
  }

  .dot.near {
    transform: scale(1.45);
    background: var(--color-foreground);
  }

  .ghost {
    position: absolute;
    border-radius: var(--radius-lg);
    border: 1px solid color-mix(in srgb, var(--color-foreground) 28%, transparent);
    background: color-mix(in srgb, var(--color-surface-2) 55%, transparent);
    box-shadow: var(--shadow-e2);
  }

  .card {
    position: absolute;
    pointer-events: auto;
    width: 20rem;
    max-width: calc(100% - 1.5rem);
    outline: none;
    user-select: none;
    cursor: grab;
    touch-action: none;
    transition:
      left var(--dur-3) ease,
      top var(--dur-3) ease,
      box-shadow var(--dur-2) ease;
  }

  /* The box is grabbed and dragged, so a pointer landing on it must not draw a
     focus box around the thing being moved. The keyboard reaching it is the
     other case entirely: it floats over a terminal, and without this there is
     nothing on screen saying the keys now go to the card. */
  .card:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-foreground) 45%, transparent);
    outline-offset: 2px;
  }

  .card.dragging {
    cursor: grabbing;
    transition: none;
    z-index: 1;
  }

  .card.collapsed {
    width: auto;
    min-width: 10rem;
  }

  .shell {
    overflow: hidden;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: color-mix(in srgb, var(--color-surface) 95%, transparent);
    box-shadow: var(--shadow-e2);
    backdrop-filter: blur(12px);
    transition: box-shadow var(--dur-2) ease;
  }

  .card:hover .shell,
  .card:focus-visible .shell,
  .card.dragging .shell {
    box-shadow: var(--shadow-e3);
  }

  .card.dragging .shell {
    transform: scale(1.015);
  }

  .toolbar {
    position: absolute;
    inset: 0 0 auto 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 1.5rem;
    padding: 0 0.35rem 0 0.4rem;
    pointer-events: none;
  }

  .grip {
    display: inline-flex;
    color: var(--color-muted-foreground);
    opacity: 0;
    transition: opacity var(--dur-1) ease;
  }

  .fold {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: var(--radius-xs);
    color: var(--color-muted-foreground);
    opacity: 0;
    transition:
      opacity var(--dur-1) ease,
      background-color var(--dur-1) ease,
      color var(--dur-1) ease;
  }

  .card:hover .grip,
  .card:focus-within .grip,
  .card:hover .fold,
  .card:focus-within .fold,
  .card.collapsed .fold,
  .card.dragging .grip {
    opacity: 1;
  }

  .fold:hover,
  .fold:focus-visible {
    background: var(--color-surface-3);
    color: var(--color-foreground);
    opacity: 1;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3rem 1.75rem 0.3rem 1.4rem;
    font-size: var(--text-xs);
  }

  .row.dim {
    padding-top: 0.125rem;
    padding-bottom: 0.125rem;
  }

  .tag {
    flex-shrink: 0;
    border-radius: var(--radius-xs);
    background: var(--color-surface-3);
    padding: 0 0.25rem;
    font-size: var(--text-2xs);
    color: var(--color-muted-foreground);
  }
</style>
