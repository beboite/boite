<script lang="ts">
  import { onMount } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { app } from "$lib/app/store.svelte";
  import { gitStore, gitScope } from "$lib/features/git/store.svelte";
  import { todos } from "$lib/features/todo/store.svelte";
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
  import Plus from "@lucide/svelte/icons/plus";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import { t } from "$lib/i18n/index.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import type { Project, Thread } from "$lib/types";

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
  // the putting-away looking like it did not take.
  const threads = $derived(
    app.threadsByProjectSorted(project.id).filter((x) => !isSettled(x)),
  );
  const running = $derived(
    threads.filter((x) => x.status === "running" || x.status === "waiting").length,
  );
  // The page is about the project, so it watches the project's own checkout.
  // The git panel may be pointed at a thread's worktree at the same time; the
  // two are separate scopes and no longer reset each other.
  const gitTarget = $derived(gitScope(project.id, project.gitRoot ?? project.cwd));
  const git = $derived(gitStore.get(gitTarget));
  // One pass over the todo table, filtered three ways, instead of three passes.
  const projectTodos = $derived(todos.forProject(project.id));
  const openTodos = $derived(projectTodos.filter((x) => x.state !== "done"));
  const claimedTodos = $derived(projectTodos.filter((x) => x.state === "claimed"));
  const doneTodos = $derived(projectTodos.filter((x) => x.state === "done"));
  const changed = $derived(
    git ? git.staged.length + git.unstaged.length + git.conflicts.length : 0,
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
  // about and returns silently when nobody has told it one.
  $effect(() => {
    const registered = gitStore.ensure(project.id, project.gitRoot ?? project.cwd);
    void gitStore.refresh(registered, { reloadLog: true }).catch(() => {});
  });

  /**
   * How long this terminal has been doing what it is doing.
   *
   * The status says what; nothing said for how long, which is the difference
   * between an agent thinking and an agent stuck. Falls back to when the row
   * was made, so a thread that has not moved since the app started still reads
   * as old rather than as brand new.
   */
  // The dashboard is where a task occurs to you, so it takes one here rather
  // than sending you to the panel. Adding keeps the focus: a list is usually
  // written as a burst of lines, not one.
  let todoDraft = $state("");
  async function addTodo() {
    const title = todoDraft.trim();
    if (!title) return;
    todoDraft = "";
    await todos.add(project.id, title);
  }

  function activity(thread: Thread): string {
    const since = threadActivitySince(thread.id) ?? thread.createdAt;
    const span = Math.max(0, relativeClock.now - since);
    // The status the dot shows, not the one the row stores: a thread parked by a
    // workspace switch still holds its PTY, and calling that one "never started"
    // would contradict the green dot beside it.
    const status = visibleStatus(thread.status, !!thread.ptyId);
    if (status === "running") return t("project.threadWorking", { span: formatSpan(span) });
    if (status === "waiting") return t("project.threadWaiting", { span: formatSpan(span) });
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
      {#if running > 0}
        <span class="text-xs text-[var(--color-success)]">
          {t("project.threadsRunning", { count: running })}
        </span>
      {/if}
    {/snippet}
    {#snippet actions()}
      <!-- The per-project override, three states: absent inherits the global
           answer. Only drawn while that experiment is armed, so switching it
           off restores one global orchestrator without erasing the choices. -->
      {#if settings.state.experimentOrchestrator && settings.state.experimentOrchestratorPerProject}
        <select
          class="rounded-md border border-border bg-[var(--color-surface-2)] px-1.5 py-0.5 text-xs text-muted-foreground outline-none focus:border-foreground/30"
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
      <p class="px-3.5 pb-3 text-sm text-muted-foreground">{t("project.noThreads")}</p>
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
                <span class="block truncate text-base text-foreground/80">
                  {thread.title ?? thread.label}
                </span>
                <span class="block truncate text-xs text-muted-foreground/80">
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
          <span class="flex shrink-0 items-center text-xs text-muted-foreground">
            <ArrowUp class="size-3" />{git.ahead}
          </span>
        {/if}
        {#if git.behind > 0}
          <span class="flex shrink-0 items-center text-xs text-muted-foreground">
            <ArrowDown class="size-3" />{git.behind}
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
              <span class="min-w-0 flex-1 truncate text-foreground/80">
                {commit.summary}
              </span>
              <!-- The one thing the sha never said. A dashboard is read for
                   "when did anything last happen here". -->
              <span class="shrink-0 text-xs text-muted-foreground/70">
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
       while the docked column is one click away. The info-box experiment takes
       that column away, and then this is the entire todo surface — so it draws
       the same cards the panel does, with the same tick, confirm, edit, drag
       and delete on every one. Claimed is still called out separately: it means
       an agent says it is done and only the user can confirm that. -->
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
        onclick={() => todos.clearDone(project.id)}
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
      <!-- Capped rather than free: the card sits in a grid row with two others,
           and a project with forty todos would otherwise decide how tall every
           card beside it is. -->
      <TodoList
        projectId={project.id}
        class="max-h-80 min-h-0 flex-1 scroll-pane overflow-y-auto border-t border-border"
      />
      <!-- Creation lives on the card either way: an empty list is exactly where
           the first todo gets written. -->
      <form
        class="flex shrink-0 items-center gap-1.5 border-t border-border px-3.5 py-2"
        onsubmit={(e) => {
          e.preventDefault();
          void addTodo();
        }}
      >
        <Plus class="size-3.5 shrink-0 text-muted-foreground/70" />
        <input
          type="text"
          bind:value={todoDraft}
          placeholder={t("project.addTodo")}
          aria-label={t("project.addTodo")}
          class="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
      </form>
    </div>
  </DashboardCard>

  <!-- What the agent did, turn by turn, and the way back out of one. Beside the
       git card on purpose: they read the same repository and answer the two
       halves of "what changed here". -->
  <ThreadTurns {project} />

  <!-- Two cards' worth of grid, and each component places itself: the token
       calendar wants the width, the figures beside it do not. -->
  <ProjectUsage {project} />

  <ProjectStats {project} openTodos={openTodos.length} commits={git?.commitCount ?? 0} />

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
    class="truncate px-1 text-xs text-muted-foreground/70 lg:col-span-3"
    use:tip={project.cwd}
  >
    {project.cwd}{#if project.gitRoot && project.gitRoot !== project.cwd}
      · {t("project.repoAt", { path: project.gitRoot })}
    {/if}
  </p>
</div>
