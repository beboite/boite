<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { app } from "$lib/app/store.svelte";
  import { gitStore, gitScope } from "$lib/features/git/store.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { todos } from "$lib/features/todo/store.svelte";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import TodoList from "$lib/features/todo/TodoList.svelte";
  import DashboardCard from "./DashboardCard.svelte";
  import ProjectWorktrees from "./ProjectWorktrees.svelte";
  import ProjectMcpSettings from "./ProjectMcpSettings.svelte";
  import ProjectUsage from "./ProjectUsage.svelte";
  import ProjectStats from "./ProjectStats.svelte";
  import ThreadTurns from "$lib/features/thread/ThreadTurns.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import { visibleStatus } from "$lib/domain/thread-status";
  import { isSettled } from "$lib/domain/thread-settle";
  import { threadActivitySince } from "$lib/features/thread/activity.svelte";
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { formatAgo, formatSpan } from "$lib/shared/utils/relative-time";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Eraser from "@lucide/svelte/icons/eraser";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import { t } from "$lib/i18n/index.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import type { Project, Thread, TodoItem } from "$lib/types";

  /**
   * What is true about a project right now.
   *
   * Most of it is read from a store the side panels already keep — the git
   * state, the todo list, the threads — so nothing is fetched twice. The two
   * that are not are the worktrees, read from the repository because a
   * straggler nothing owns is exactly what no other panel can show, and the
   * token counts, read from the agents' own transcripts because Boite records
   * none of it itself.
   *
   * Every row that can carry a time carries one. A terminal that says "ready"
   * and a commit that says "abc123" both left out the one thing a glance at a
   * dashboard is for: whether any of this happened recently.
   */
  type Props = { project: Project; onOpenThread: (threadId: string) => void };
  let { project, onOpenThread }: Props = $props();

  // Minus what the project put away. The sidebar's own drawer is the one place
  // a settled thread shows up, so a card here that still counted them would be
  // the putting-away looking like it did not take. The unfiltered list stays
  // because an empty card has two meanings: nothing was ever started, or
  // everything here was put away, and those are not the same sentence.
  const listed = $derived(app.threadsByProjectSorted(project.id));
  const threads = $derived(listed.filter((x) => !isSettled(x)));
  // Waiting is its own count. Folded into "N working" it contradicted the row
  // below that already said "waiting on you".
  const running = $derived(threads.filter((x) => x.status === "running").length);
  const waiting = $derived(threads.filter((x) => x.status === "waiting").length);
  // The page is about the project, so it watches the project's own checkout.
  // The git panel may be pointed at a thread's worktree at the same time; the
  // two are separate scopes and no longer reset each other.
  const gitTarget = $derived(gitScope(project.id, project.gitRoot ?? project.cwd));
  const git = $derived(gitStore.get(gitTarget));
  // One pass over the todo table, filtered three ways, instead of three passes.
  const { openTodos, claimedTodos, doneTodos } = $derived.by(() => {
    const openTodos: TodoItem[] = [];
    const claimedTodos: TodoItem[] = [];
    const doneTodos: TodoItem[] = [];
    for (const item of todos.forProject(project.id)) {
      if (item.state === "done") doneTodos.push(item);
      else {
        openTodos.push(item);
        if (item.state === "claimed") claimedTodos.push(item);
      }
    }
    return { openTodos, claimedTodos, doneTodos };
  });
  // git-status lists a partially staged file in both staged and unstaged, so
  // summing the three arrays counted one path twice.
  const changed = $derived.by(() => {
    if (!git) return 0;
    const paths = new Set<string>();
    for (const entry of git.staged) paths.add(entry.path);
    for (const entry of git.unstaged) paths.add(entry.path);
    for (const entry of git.conflicts) paths.add(entry.path);
    return paths.size;
  });
  const pathTip = $derived(
    project.gitRoot && project.gitRoot !== project.cwd
      ? `${project.cwd} · ${t("project.repoAt", { path: project.gitRoot })}`
      : project.cwd,
  );

  // Every relative label on this page moves off one clock, which stops while the
  // window is hidden and re-reads the moment it comes back.
  $effect(() => relativeClock.subscribe());

  onMount(() => {
    void todos.ensureLoaded();
  });

  // The git panel refreshes while it is open; this page may be the only thing
  // looking, so it asks once on arrival rather than drawing an empty card.
  // `ensure` first, always: `refresh` reads the directory the store was told
  // about and returns silently when nobody has told it one. The log is asked
  // for only when the store has none: the git panel may already have filled
  // it, and forcing a reload on every visit walks the same commits this card
  // is about to draw. Untracked so filling the log does not fire the effect
  // again.
  let lastGitError: string | null = null;
  $effect(() => {
    const registered = gitStore.ensure(project.id, project.gitRoot ?? project.cwd);
    const reloadLog = untrack(() => (gitStore.get(registered)?.log.length ?? 0) === 0);
    void gitStore.refresh(registered, { reloadLog, notifyErrors: true }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (lastGitError !== msg) {
        lastGitError = msg;
        notifications.error(t("git.readFolderFailed"), undefined, msg);
      }
    });
  });

  // Same door as a single remove: the rows do not come back, and the eraser
  // used to skip the question the rest of this surface asks.
  async function clearDone() {
    const count = doneTodos.length;
    if (count === 0) return;
    const ok = await confirmDialog.ask({
      title: t("todo.clearDoneConfirmTitle", { count }),
      message: t("todo.clearDoneConfirmMessage", { count }),
      confirmLabel: t("todo.clearDoneConfirmAction"),
      danger: true,
    });
    if (!ok) return;
    await todos.clearDone(project.id);
  }

  /**
   * How long this terminal has been doing what it is doing.
   *
   * The status says what; nothing said for how long, which is the difference
   * between an agent thinking and an agent stuck. Falls back to when the row
   * was made, so a thread that has not moved since the app started still reads
   * as old rather than as brand new.
   */
  function activity(thread: Thread): string {
    const since = threadActivitySince(thread.id) ?? thread.createdAt;
    const span = Math.max(0, relativeClock.now - since);
    // The status the dot shows, not the one the row stores: a thread parked by a
    // workspace switch still holds its PTY, and calling that one "never started"
    // would contradict the green dot beside it. `ready` is that parked-alive
    // case; falling through would print "done", which is the other lie.
    const status = visibleStatus(thread.status, !!thread.ptyId);
    if (status === "running") return t("project.threadWorking", { span: formatSpan(span) });
    if (status === "waiting") return t("project.threadWaiting", { span: formatSpan(span) });
    if (status === "ready") return t("project.threadReady", { span: formatSpan(span) });
    if (status === "idle") return t("project.threadIdle", { span: formatSpan(span) });
    return t("project.threadFinished", { ago: formatAgo(span) });
  }
</script>

<div class="grid gap-3 lg:grid-cols-3">
  <!-- Terminals. The list is the whole card: starting one is the shortcut bar's
       job, one row up. -->
  <DashboardCard
    title={t("project.threads")}
    badge={threads.length || null}
    flush
  >
    {#snippet icon()}<TerminalIcon class="size-3.5" />{/snippet}
    {#snippet lead()}
      {#if running > 0 || waiting > 0}
        <span class="inline-flex items-center justify-end gap-2">
          {#if running > 0}
            <span class="text-xs text-[var(--color-success)]">
              {t("project.threadsRunning", { count: running })}
            </span>
          {/if}
          {#if waiting > 0}
            <span class="text-xs text-[var(--color-warning)]">
              {t("project.threadsWaiting", { count: waiting })}
            </span>
          {/if}
        </span>
      {/if}
    {/snippet}
    {#snippet actions()}
      <!-- The per-project override, three states: absent inherits the global
           answer. Only drawn while the workspace experiment is armed, and
           switching that off restores one global orchestrator without erasing
           the choices. -->
      {#if settings.state.experimentWorkspace}
        <select
          class="rounded-md border border-edge bg-[var(--color-surface-2)] px-1.5 py-0.5 text-xs text-muted-foreground outline-none focus:border-foreground/30"
          aria-label={t("project.orchestrator")}
          value={settings.state.orchestratorByProject[project.id] ?? ""}
          onchange={(e) =>
            void settings.setOrchestratorForProject(
              project.id,
              (e.currentTarget.value || null) as "on" | "off" | null,
            )}
        >
          <option value="">{t("project.orchestratorInherit")}</option>
          <option value="on">{t("project.orchestratorOn")}</option>
          <option value="off">{t("project.orchestratorOff")}</option>
        </select>
      {/if}
    {/snippet}
    {#if threads.length === 0}
      <p class="px-3.5 pb-3 text-sm text-muted-foreground">
        {listed.length > 0 ? t("project.noThreadsSettled") : t("project.noThreads")}
      </p>
    {:else}
      <ul class="flex max-h-64 flex-col scroll-pane overflow-y-auto px-2 pb-2">
        {#each threads as thread (thread.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-start gap-2 rounded-sm px-1.5 py-1.5 text-left transition hover:bg-accent"
              onclick={() => onOpenThread(thread.id)}
            >
              <span class="mt-0.5 flex shrink-0 items-center gap-1.5">
                <StatusDot
                  status={thread.status}
                  asleep={thread.autoSlept ?? false}
                  keepAwake={(thread.keepAwake ?? false) && !!thread.ptyId}
                />
                <ShortcutIcon
                  iconKey={thread.iconKey}
                  size={13}
                  color={threadIconColor(thread)}
                />
              </span>
              <span class="min-w-0 flex-1">
                <span
                  class="block truncate text-base text-foreground"
                  use:tip={thread.title ?? thread.label}
                >
                  {thread.title ?? thread.label}
                </span>
                <span class="block truncate text-xs text-muted-2">
                  {activity(thread)}
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </DashboardCard>

  <!-- Git. A summary, not a panel: branch, how far from upstream, what is
       uncommitted, and the last few commits with when they landed. -->
  <DashboardCard title={t("project.git")}>
    {#snippet icon()}<GitBranch class="size-3.5" />{/snippet}
    {#if !git?.loaded}
      <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
    {:else if git.error}
      <!-- The store keeps the last good lists when a refresh fails, so without
           this branch a moved folder or a missing git still looked clean. -->
      <p class="text-sm text-[var(--color-danger)]">{git.error}</p>
    {:else if !git.isRepo}
      <p class="text-sm text-muted-foreground">{t("project.notARepo")}</p>
    {:else}
      <div class="flex items-baseline gap-2">
        <p
          class="min-w-0 flex-1 truncate font-medium text-md text-foreground"
          use:tip={git.branch ?? ""}
        >
          {git.branch ?? t("project.detached")}
        </p>
        {#if git.ahead > 0}
          <span
            class="flex shrink-0 items-center text-xs text-muted-foreground"
            aria-label={t("project.gitAhead", { count: git.ahead })}
          >
            <ArrowUp class="size-3" aria-hidden="true" />{git.ahead}
          </span>
        {/if}
        {#if git.behind > 0}
          <span
            class="flex shrink-0 items-center text-xs text-muted-foreground"
            aria-label={t("project.gitBehind", { count: git.behind })}
          >
            <ArrowDown class="size-3" aria-hidden="true" />{git.behind}
          </span>
        {/if}
      </div>
      <p class="mt-0.5 text-sm {changed === 0 ? 'text-muted-foreground' : 'text-[var(--color-warning)]'}">
        {changed === 0 ? t("project.clean") : t("project.changedFiles", { count: changed })}
      </p>
      {#if git.log.length > 0}
        <ul class="mt-2.5 flex flex-col gap-1 border-t border-border pt-2">
          {#each git.log.slice(0, 5) as commit (commit.sha)}
            <li class="flex items-baseline gap-2 text-sm" use:tip={commit.summary}>
              <span class="min-w-0 flex-1 truncate text-foreground">
                {commit.summary}
              </span>
              <!-- The one thing the sha never said. A dashboard is read for
                   "when did anything last happen here". -->
              <span class="shrink-0 text-xs text-muted-2">
                {formatAgo(relativeClock.now - commit.time * 1000)}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </DashboardCard>

  <!-- Todos. The list itself, not a summary of it: this card used to be six
       truncated titles with an input under them, which is the right shape only
       while a docked column is one click away. There is no column any more, so
       this is a full todo surface — the same component the pane draws, with the
       same tick, confirm, edit, drag and delete on every card. Claimed is still
       called out separately: it means an agent says it is done and only the
       user can confirm that. -->
  <DashboardCard title={t("project.todos")} badge={openTodos.length || null} flush>
    {#snippet icon()}<ListTodo class="size-3.5" />{/snippet}
    {#snippet lead()}
      {#if claimedTodos.length > 0}
        <span class="text-xs text-[var(--color-warning)]">
          {t("project.awaitingYou", { count: claimedTodos.length })}
        </span>
      {/if}
    {/snippet}
    {#snippet actions()}
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
        onclick={() => void clearDone()}
        disabled={doneTodos.length === 0}
        use:tip={doneTodos.length === 0
          ? t("todo.nothingDone")
          : t("todo.clearDone", { count: doneTodos.length })}
        aria-label={t("todo.clearDoneLabel")}
      >
        <Eraser class="size-3.5" />
      </button>
    {/snippet}
    <div class="flex h-full min-h-0 flex-col">
      <TodoList projectId={project.id} compact />
    </div>
  </DashboardCard>

  <!-- What the agent did, turn by turn, and the way back out of one. Beside the
       git card on purpose: they read the same repository and answer the two
       halves of "what changed here". -->
  <ThreadTurns {project} />

  <!-- Two cards' worth of grid, and each component places itself: the token
       calendar wants the width, the figures beside it do not. -->
  <ProjectUsage {project} />

  <ProjectStats
    {project}
    threadCount={threads.length}
    openTodos={openTodos.length}
    commits={git?.commitCount ?? 0}
    gitLoaded={!!git?.loaded}
    gitIsRepo={!!git?.isRepo}
  />

  <!-- Where the agents actually are, and what this project does with them.
       Two cards from one component, because the switch decides what the list
       below it will hold. The MCP access rows are inside the first of them:
       they were a full-width card of their own holding two lines of text, and
       three columns of nothing under it. -->
  <ProjectWorktrees {project} />

  <ProjectMcpSettings {project} />

  <!-- The paths, as a line rather than a card. They are the one thing here
       that never changes, and a card's worth of chrome around two static
       strings was room the rest of the page wanted. -->
  <p
    class="truncate px-1 text-xs text-muted-2 lg:col-span-3"
    use:tip={pathTip}
  >
    {project.cwd}{#if project.gitRoot && project.gitRoot !== project.cwd}
      · {t("project.repoAt", { path: project.gitRoot })}
    {/if}
  </p>
</div>
