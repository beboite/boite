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
  import { formatAgo } from "$lib/shared/utils/relative-time";
  import { t } from "$lib/i18n/index.svelte";
  import type { IconKey, Thread } from "$lib/types";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";

  /**
   * The project's vitals, in one box over the terminals.
   *
   * This replaces the docked column for whoever turned the experiment on: not a
   * place to operate on the repository, a place to know where you are. Which
   * branch this thread is on, which todo an agent has claimed, and what the
   * last commit was — read at a glance, never clicked. Hovering (or focusing)
   * the box unfolds the rest of the log, up to ten commits, and leaving folds
   * it back.
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
  const HOVER_LOG = 10;

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
    class="group w-80 max-w-full select-none outline-none"
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
      {#if isRepo}
        <div class="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-xs">
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

      {#if claimed.length > 0}
        <div
          class="flex items-center gap-1.5 px-2.5 py-1 text-xs"
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
      {/if}

      {#if commits.length > 0}
        <div class="flex items-center gap-1.5 px-2.5 py-1 text-xs">
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
           anything. -->
      {#if commits.length > 1 || claimed.length > 1}
        <div
          class="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr]"
        >
          <div class="min-h-0 overflow-hidden">
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
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}
