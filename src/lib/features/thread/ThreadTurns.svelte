<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { backendForPath } from "$lib/backend";
  import type { CheckpointFile } from "$lib/backend/types";
  import DashboardCard from "$lib/features/project/DashboardCard.svelte";
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { revealEditor } from "$lib/features/editor/reveal";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { formatAgo, formatSpan } from "$lib/shared/utils/relative-time";
  import { t } from "$lib/i18n/index.svelte";
  import History from "@lucide/svelte/icons/history";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import { checkpointVersion } from "./checkpoints.svelte";
  import { threadGitRoot } from "./cwd";
  import { pairTurns, type Turn } from "./turns";
  import type { Project } from "$lib/types";

  /**
   * What each of an agent's turns changed, and the way back out of one.
   *
   * The rows come from checkpoints, which are git refs nothing else reads, so
   * nothing here is a record Boite keeps: the tree at each end of a turn is in
   * the repository already. What the card cannot offer, and says so before it
   * acts, is undoing the conversation that produced those files.
   */
  type Props = { project: Project };
  let { project }: Props = $props();

  const threads = $derived(app.threadsByProjectSorted(project.id));
  // The terminal on screen when it belongs here, and otherwise the one that
  // moved most recently: the same derivation the git panel makes, so the two
  // never describe different threads at the same time.
  const thread = $derived(
    app.activeThread && app.activeThread.projectId === project.id
      ? app.activeThread
      : (threads[0] ?? null),
  );
  const repo = $derived(threadGitRoot(thread, project));

  let turns = $state.raw<Turn[]>([]);
  let error = $state<string | null>(null);
  let expanded = $state<number | null>(null);
  let files = $state.raw<CheckpointFile[]>([]);
  let reverting = $state(false);

  $effect(() => relativeClock.subscribe());

  $effect(() => {
    const id = thread?.id;
    const path = repo;
    // Read for its dependency, so a turn this thread just finished re-draws the
    // list. Per thread, so another one finishing does not.
    void (id ? checkpointVersion(id) : 0);
    expanded = null;
    files = [];
    if (!id || !path) {
      turns = [];
      return;
    }
    let live = true;
    backendForPath(path)
      .checkpoints.list(path, id)
      .then((list) => {
        if (!live) return;
        error = null;
        turns = pairTurns(list).reverse();
      })
      .catch((err) => {
        if (live) error = String(err);
      });
    return () => {
      live = false;
    };
  });

  async function toggle(turn: Turn) {
    if (expanded === turn.id) {
      expanded = null;
      return;
    }
    expanded = turn.id;
    files = [];
    if (!repo) return;
    try {
      // The patch is not asked for: the card draws a list, and the diff view
      // reads each file's two versions when one is clicked.
      const diff = await backendForPath(repo).checkpoints.diff(
        repo,
        turn.startSha,
        turn.endSha,
        false,
      );
      if (expanded === turn.id) files = diff.files;
    } catch (err) {
      error = String(err);
    }
  }

  async function openFile(turn: Turn, file: CheckpointFile) {
    if (!repo) return;
    await editorStore.openDiff({
      projectId: project.id,
      repoPath: repo,
      file: file.path,
      mode: "turn",
      range: { from: turn.startSha, to: turn.endSha },
    });
    revealEditor();
  }

  async function revert(turn: Turn) {
    const id = thread?.id;
    if (!repo || !id || reverting) return;
    const ok = await confirmDialog.ask({
      title: t("turns.revertTitle"),
      message: t("turns.revertMessage"),
      confirmLabel: t("turns.revertConfirm"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    reverting = true;
    try {
      await backendForPath(repo).checkpoints.restore(repo, id, turn.startSha);
      notifications.success(t("turns.reverted"));
    } catch (err) {
      notifications.error(t("turns.revertFailed", { error: String(err) }));
    } finally {
      reverting = false;
    }
  }
</script>

<DashboardCard title={t("turns.title")} badge={turns.length || null} flush>
  {#snippet icon()}<History class="size-3.5" />{/snippet}
  {#snippet lead()}
    {#if thread}
      <span class="text-xs text-muted-foreground/80">
        {thread.title ?? thread.label}
      </span>
    {/if}
  {/snippet}

  {#if error}
    <p class="px-3.5 pb-3 text-sm text-muted-foreground">
      {t("turns.loadFailed", { error })}
    </p>
  {:else if !thread || !repo}
    <p class="px-3.5 pb-3 text-sm text-muted-foreground">{t("turns.noThread")}</p>
  {:else if turns.length === 0}
    <p class="px-3.5 pb-3 text-sm text-muted-foreground">{t("turns.none")}</p>
  {:else}
    <ul class="flex max-h-64 flex-col scroll-pane overflow-y-auto px-2 pb-2">
      {#each turns as turn (turn.id)}
        <li>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="min-w-0 flex-1 rounded-sm px-1.5 py-1.5 text-left transition hover:bg-accent"
              onclick={() => toggle(turn)}
              aria-expanded={expanded === turn.id}
            >
              <span class="flex items-baseline gap-2">
                <span class="min-w-0 flex-1 truncate text-base text-foreground/80">
                  {t("turns.files", { count: turn.files })}
                </span>
                <span class="shrink-0 tabular-nums text-xs text-muted-foreground/70">
                  {formatAgo(Math.max(0, relativeClock.now - turn.endedAt))}
                </span>
              </span>
              <span class="block truncate text-xs text-muted-foreground/80">
                {t("turns.ran", {
                  span: formatSpan(Math.max(0, turn.endedAt - turn.startedAt)),
                })}
                {#if turn.additions > 0 || turn.deletions > 0}
                  · <span class="text-[var(--color-success)]">+{turn.additions}</span>
                  <span class="text-[var(--color-danger)]">-{turn.deletions}</span>
                {/if}
              </span>
            </button>
            <button
              type="button"
              class="shrink-0 rounded-sm p-1.5 text-muted-foreground/70 transition hover:bg-accent hover:text-foreground disabled:opacity-40"
              onclick={() => revert(turn)}
              disabled={reverting}
              use:tip={t("turns.revert")}
              aria-label={t("turns.revert")}
            >
              <Undo2 class="size-3.5" />
            </button>
          </div>
          {#if expanded === turn.id}
            {#if files.length === 0}
              <p class="px-3 pb-2 text-xs text-muted-foreground/70">{t("turns.empty")}</p>
            {:else}
              <ul class="mb-1 flex flex-col border-l border-border pl-2 ml-2">
                {#each files as file (file.path)}
                  <li>
                    <button
                      type="button"
                      class="flex w-full items-baseline gap-2 rounded-sm px-1.5 py-1 text-left transition hover:bg-accent"
                      onclick={() => openFile(turn, file)}
                    >
                      <span
                        class="w-3 shrink-0 text-center text-2xs font-semibold text-muted-foreground/80"
                      >
                        {file.status}
                      </span>
                      <span class="min-w-0 flex-1 truncate text-xs text-foreground/80">
                        {file.path}
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</DashboardCard>
