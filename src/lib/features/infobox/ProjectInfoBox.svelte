<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { workspace } from "$lib/backend";
  import { threadGitRoot } from "$lib/features/thread/cwd";
  import { gitStore, gitScope } from "$lib/features/git/store.svelte";
  import { todos } from "$lib/features/todo/store.svelte";
  import { ownsPoll, releasePoll } from "./poll-owner";
  import {
    INFO_BOX_ANCHORS,
    INFO_BOX_GUTTER_REM,
    clampToPane,
    nearestAnchor,
    snapPoint,
    toastAlignFor,
    toastStackFor,
  } from "./anchor";
  import { settings } from "$lib/features/settings/store.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { remeasureToastClaims, toastInset } from "$lib/features/notifications/anchor.svelte";
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { formatAgo } from "$lib/shared/utils/relative-time";
  import { t } from "$lib/i18n/index.svelte";
  import type { IconKey, InfoBoxAnchor, Thread } from "$lib/types";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";

  /**
   * The project's vitals, in one box over the terminals.
   *
   * This replaces the docked column for whoever turned the experiment on: not a
   * place to operate on the repository, a place to know where you are. Which
   * branch this thread is on, which todo an agent has claimed, and what the
   * last commit was. Hovering (or focusing) the box unfolds the rest of the
   * log, up to ten commits, and leaving folds it back. A button folds the
   * whole card to its header; a drag docks it on any of the eight edges.
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
  const HOVER_LOG = 10;
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

  // What the agents are on right now. Most recently touched first, because the
  // collapsed box has one line to spend on it.
  const claimed = $derived(
    todos
      .forProject(project?.id ?? null)
      .filter((item) => item.state === "claimed")
      .sort((a, b) => b.updatedAt - a.updatedAt),
  );

  const mine = $derived(scope !== null && readScope === scope);
  const commits = $derived(mine ? gs?.log.slice(0, HOVER_LOG) ?? [] : []);
  const isRepo = $derived(mine && (gs?.isRepo ?? false));

  // Nothing to say, no box: a project with no repository and no claimed work
  // would be a frame around two empty lines.
  const hasContent = $derived(isRepo || claimed.length > 0);

  const collapsed = $derived(settings.state.infoBoxCollapsed);
  const dock = $derived(settings.state.infoBoxAnchor);
  const stack = $derived(toastStackFor(dock));
  const align = $derived(toastAlignFor(dock));

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
    session = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: left,
      originY: top,
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
    hoverSnap = nearestAnchor(pane, boxSize, gutter, next.x, next.y);
  }

  function onPointerUp(e: PointerEvent) {
    if (!session || e.pointerId !== session.pointerId) return;
    const snap = session.armed
      ? nearestAnchor(pane, boxSize, gutter, dragPos.x, dragPos.y)
      : null;
    session = null;
    dragging = false;
    hoverSnap = null;
    if (snap) settings.setInfoBoxAnchor(snap);
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
          <span class="grip" aria-hidden="true" title={t("infoBox.drag")}>
            <GripVertical class="size-3" />
          </span>
          <button
            type="button"
            class="fold"
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("infoBox.expand") : t("infoBox.collapse")}
            title={collapsed ? t("infoBox.expand") : t("infoBox.collapse")}
            onclick={() => settings.setInfoBoxCollapsed(!collapsed)}
          >
            {#if collapsed}
              <ChevronsUpDown class="size-3.5" />
            {:else}
              <ChevronsDownUp class="size-3.5" />
            {/if}
          </button>
        </div>

        {#if isRepo}
          <div class="row">
            <GitBranch class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate font-medium text-foreground">
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
          </div>
        {/if}

        {#if claimed.length > 0 && (!collapsed || !isRepo)}
          <div
            class="row"
            title={t("infoBox.claimedTitle", { agent: claimed[0].claimedBy ?? "" })}
          >
            <span class="relative flex size-3.5 shrink-0 items-center justify-center">
              <ShortcutIcon iconKey={claimed[0].claimedBy as IconKey} size={14} />
            </span>
            <span class="truncate text-foreground/90">{claimed[0].title}</span>
            <!-- What this row is. An agent's title can be anything, a test name
                 included, and the agent's own icon beside it says who without
                 ever saying what: the line read as a stray message sitting above
                 the commit. The tag is the one part that cannot truncate. -->
            <span class="tag">{t("infoBox.claimedTag")}</span>
            {#if claimed.length > 1}
              <span class="tag">{t("infoBox.moreClaimed", { count: claimed.length - 1 })}</span>
            {/if}
          </div>
        {/if}

        {#if !collapsed && commits.length > 0}
          <div class="row">
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

        <!-- The unfold: rows two to ten of the log, plus the rest of the claimed
             work. A grid row going 0fr to 1fr animates height without measuring
             anything. Off while folded or while a drag is live, so the card
             does not grow under the pointer. -->
        {#if !collapsed && (commits.length > 1 || claimed.length > 1)}
          <div
            class="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr]"
          >
            <div class="min-h-0 overflow-hidden">
              {#if claimed.length > 1}
                <div class="border-t border-border/60 py-0.5">
                  {#each claimed.slice(1) as item (item.id)}
                    <div
                      class="row dim"
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
              {#if commits.length > 1}
                <div class="border-t border-border/60 py-0.5">
                  {#each commits.slice(1) as commit (commit.sha)}
                    <div class="row dim">
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
    z-index: 5;
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
