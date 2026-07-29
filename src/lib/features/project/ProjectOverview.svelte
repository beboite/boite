<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { gitStore } from "$lib/features/git/store.svelte";
  import { todos } from "$lib/features/todo/store.svelte";
  import { launchShortcut } from "$lib/features/thread/api";
  import { threadCwd } from "$lib/features/thread/cwd";
  import { resolveIconKey } from "$lib/shared/icons/detect";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import { t } from "$lib/i18n/index.svelte";
  import type { Project, Thread } from "$lib/types";

  /**
   * What is true about a project right now, above its chat.
   *
   * Every number here is read from a store the side panels already keep — the
   * git state, the todo list, the threads. Nothing is fetched twice and nothing
   * new is computed: this is the same truth those panels show, in the shape you
   * want when you have just opened a project and are deciding what to do.
   */
  type Props = { project: Project; onOpenThread: (threadId: string) => void };
  let { project, onOpenThread }: Props = $props();

  const threads = $derived(app.threadsByProjectSorted(project.id));
  const git = $derived(gitStore.get(project.id));
  const openTodos = $derived(todos.forProject(project.id).filter((x) => x.state !== "done"));
  const claimedTodos = $derived(
    todos.forProject(project.id).filter((x) => x.state === "claimed"),
  );
  const changed = $derived(
    git ? git.staged.length + git.unstaged.length + git.conflicts.length : 0,
  );
  // Threads running somewhere other than the project folder. Since worktree
  // isolation these are the norm for agents, and which of them holds what is
  // the question you cannot answer from the sidebar.
  const isolated = $derived(threads.filter((x) => !!x.worktreePath));

  onMount(() => {
    void todos.ensureLoaded();
  });

  // The git panel refreshes while it is open; this page may be the only thing
  // looking, so it asks once on arrival rather than drawing an empty card.
  // `ensure` first, always: `refresh` reads the directory the store was told
  // about and returns silently when nobody has told it one.
  $effect(() => {
    const id = project.id;
    const cwd = project.gitRoot ?? project.cwd;
    gitStore.ensure(id, cwd);
    void gitStore.refresh(id, { reloadLog: true }).catch(() => {});
  });

  function launch(shortcutId: string) {
    const shortcut = settings.state.shortcuts.find((s) => s.id === shortcutId);
    if (shortcut) void launchShortcut(shortcut, project.id);
  }

  function shortPath(thread: Thread): string {
    const cwd = threadCwd(thread, project);
    if (!cwd) return "";
    const at = cwd.lastIndexOf("/");
    return at >= 0 ? cwd.slice(at + 1) : cwd;
  }
</script>

<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
  <!-- Threads, and how to start one. The launcher is here rather than only in
       the top bar because this page is where someone decides to begin. -->
  <section class="rounded-lg border border-border bg-[var(--color-surface)] p-3">
    <h2 class="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {t("project.threads")}
    </h2>
    {#if threads.length === 0}
      <p class="mb-2 text-[12px] text-muted-foreground">{t("project.noThreads")}</p>
    {:else}
      <ul class="mb-2 flex flex-col gap-0.5">
        {#each threads as thread (thread.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] text-foreground/85 transition hover:bg-accent hover:text-foreground"
              onclick={() => onOpenThread(thread.id)}
            >
              <StatusDot
                status={thread.status}
                asleep={thread.autoSlept ?? false}
                keepAwake={(thread.keepAwake ?? false) && !!thread.ptyId}
              />
              <ShortcutIcon iconKey={thread.iconKey} size={13} color={threadIconColor(thread)} />
              <span class="min-w-0 flex-1 truncate">{thread.title ?? thread.label}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="flex flex-wrap gap-1.5">
      {#each settings.state.shortcuts as shortcut (shortcut.id)}
        {@const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command)}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-surface-2)] px-2 py-1 text-[11.5px] text-foreground/85 transition hover:border-border hover:text-foreground disabled:opacity-40"
          disabled={!shortcut.command.trim()}
          onclick={() => launch(shortcut.id)}
          title={shortcut.command}
        >
          <ShortcutIcon {iconKey} size={13} color={shortcut.iconColor ?? null} />
          {shortcut.label}
        </button>
      {/each}
    </div>
  </section>

  <!-- Git. A summary, not a panel: branch, how far from upstream, what is
       uncommitted, and the last few commits. -->
  <section class="rounded-lg border border-border bg-[var(--color-surface)] p-3">
    <h2
      class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
    >
      <GitBranch class="size-3.5" />
      {t("project.git")}
    </h2>
    {#if !git?.loaded}
      <p class="text-[12px] text-muted-foreground">{t("common.loading")}</p>
    {:else if !git.isRepo}
      <p class="text-[12px] text-muted-foreground">{t("project.notARepo")}</p>
    {:else}
      <p class="truncate text-[13px] font-medium text-foreground" title={git.branch ?? ""}>
        {git.branch ?? t("project.detached")}
      </p>
      <p class="mt-0.5 text-[11.5px] text-muted-foreground">
        {#if git.ahead || git.behind}
          {t("project.aheadBehind", { ahead: git.ahead, behind: git.behind })} ·
        {/if}
        {changed === 0 ? t("project.clean") : t("project.changedFiles", { count: changed })}
      </p>
      {#if git.log.length > 0}
        <ul class="mt-2 flex flex-col gap-0.5">
          {#each git.log.slice(0, 4) as commit (commit.sha)}
            <li class="truncate text-[11.5px] text-muted-foreground" title={commit.summary}>
              <span class="font-mono text-foreground/60">{commit.shortSha}</span>
              {commit.summary}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>

  <!-- Todos. Claimed is called out separately: it means an agent says it is
       done and only the user can confirm that, which is a thing to act on. -->
  <section class="rounded-lg border border-border bg-[var(--color-surface)] p-3">
    <h2
      class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
    >
      <ListTodo class="size-3.5" />
      {t("project.todos")}
    </h2>
    {#if openTodos.length === 0}
      <p class="text-[12px] text-muted-foreground">{t("project.noTodos")}</p>
    {:else}
      {#if claimedTodos.length > 0}
        <p class="mb-1.5 text-[11.5px] text-[var(--color-warning)]">
          {t("project.awaitingYou", { count: claimedTodos.length })}
        </p>
      {/if}
      <ul class="flex flex-col gap-0.5">
        {#each openTodos.slice(0, 5) as todo (todo.id)}
          <li class="flex items-start gap-1.5 text-[12px] text-foreground/85">
            <span
              class="mt-1.5 size-1 shrink-0 rounded-full"
              style:background-color={todo.state === "claimed"
                ? "var(--color-warning)"
                : "var(--color-muted-foreground, currentColor)"}
            ></span>
            <!-- The title alone: the card's description is a paragraph, and
                 this is a five-line summary, not the panel. -->
            <span class="min-w-0 flex-1 truncate" title={todo.title}>{todo.title}</span>
          </li>
        {/each}
      </ul>
      {#if openTodos.length > 5}
        <p class="mt-1 text-[11px] text-muted-foreground">
          {t("project.andMore", { count: openTodos.length - 5 })}
        </p>
      {/if}
    {/if}
  </section>

  <!-- Where the code actually is, and who is holding a copy of it. -->
  <section
    class="rounded-lg border border-border bg-[var(--color-surface)] p-3 sm:col-span-2 lg:col-span-3"
  >
    <h2
      class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
    >
      <FolderTree class="size-3.5" />
      {t("project.workspace")}
    </h2>
    <p class="truncate font-mono text-[11.5px] text-muted-foreground" title={project.cwd}>
      {project.cwd}
    </p>
    {#if project.gitRoot && project.gitRoot !== project.cwd}
      <p class="truncate font-mono text-[11px] text-muted-foreground/70" title={project.gitRoot}>
        {t("project.repoAt", { path: project.gitRoot })}
      </p>
    {/if}
    {#if isolated.length > 0}
      <ul class="mt-2 flex flex-col gap-0.5">
        {#each isolated as thread (thread.id)}
          <li class="flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <ShortcutIcon iconKey={thread.iconKey} size={12} color={threadIconColor(thread)} />
            <span class="truncate text-foreground/80">{thread.title ?? thread.label}</span>
            <span class="truncate font-mono" title={thread.worktreePath}>{shortPath(thread)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="mt-2 text-[11.5px] text-muted-foreground">
        {settings.state.threadWorktrees
          ? t("project.noWorktrees")
          : t("project.worktreesOff")}
      </p>
    {/if}
  </section>
</div>
