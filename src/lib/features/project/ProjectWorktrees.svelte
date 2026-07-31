<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { backendForPath } from "$lib/backend";
  import { settings } from "$lib/features/settings/store.svelte";
  import { isScratch } from "$lib/features/project/scratch";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { logger } from "$lib/shared/services/logger.svelte";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { basename } from "$lib/shared/utils/path";
  import { t } from "$lib/i18n/index.svelte";
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Lock from "@lucide/svelte/icons/lock";
  import type { WorktreeEntry } from "$lib/backend/types";
  import type { IconKey, Project } from "$lib/types";

  /**
   * Every worktree of the project's repository, read from the repository.
   *
   * Not from the thread rows: a thread that was deleted leaves its worktree on
   * disk, holding whatever the agent had not committed, and nothing in Boite
   * showed it. That straggler is the reason this panel exists — the ones a
   * thread still owns were already visible on the overview.
   */
  type Props = { project: Project };
  let { project }: Props = $props();

  /**
   * Whether the next agent thread here opens its own worktree.
   *
   * The project's answer when it has one, the app's otherwise — a project
   * nobody has decided for still follows the global default, so moving that
   * still moves it. Unchecking is not retroactive and cannot be: a thread's
   * directory is fixed when it is born, and moving a running one out from under
   * its agent would lose whatever is in it.
   */
  const autoWorktrees = $derived(project.worktrees ?? settings.state.threadWorktrees);
  // Scratch is the home folder, not a repository. It never opened a worktree
  // and never will, so a switch on it would be one that does nothing.
  const canToggle = $derived(!isScratch(project));

  let entries = $state<WorktreeEntry[]>([]);
  let loading = $state(false);
  let failed = $state<string | null>(null);
  let busy = $state<Record<string, true>>({});
  // The switch writes to the database. Left free, a second click during that
  // write raced the first and the row could settle on the value nobody picked.
  let togglingAuto = $state(false);

  const repo = $derived(project.gitRoot ?? project.cwd);
  // Which thread is standing in which directory, so a row can say who is using
  // it before anyone is asked whether it can go.
  const holders = $derived.by(() => {
    const map = new Map<string, { label: string; iconKey: IconKey }>();
    for (const thread of app.threads) {
      if (thread.worktreePath) {
        map.set(thread.worktreePath, {
          label: thread.title ?? thread.label,
          iconKey: thread.iconKey,
        });
      }
    }
    return map;
  });

  const dirtyCount = $derived(entries.filter((w) => !w.main && holdsWork(w)).length);

  function holdsWork(w: WorktreeEntry): boolean {
    return w.dirty || w.orphanCommits;
  }

  async function load() {
    if (loading) return;
    loading = true;
    failed = null;
    try {
      entries = await backendForPath(project.cwd).worktree.list(repo);
    } catch (err) {
      // A project that is not a repository has no worktrees rather than an
      // error worth a toast, but the panel still has to say which it is.
      failed = String(err);
      entries = [];
    } finally {
      loading = false;
    }
  }

  // Re-reads whenever the project changes, and once on mount. Every flag here
  // costs a git process, so nothing polls: the button is the refresh.
  //
  // Untracked, because `load` reads `loading` and then writes it: tracked, the
  // effect takes a dependency on its own write and re-runs the moment the read
  // finishes.
  $effect(() => {
    void project.id;
    untrack(() => void load());
  });

  async function toggleAuto(enabled: boolean) {
    if (togglingAuto) return;
    togglingAuto = true;
    try {
      await app.setProjectWorktrees(project.id, enabled);
    } finally {
      togglingAuto = false;
    }
  }

  /**
   * Removes a worktree, after saying plainly what removing it destroys.
   *
   * `force` is only ever the user answering for themselves. The unforced call
   * refuses while the directory holds work, which is what makes the automatic
   * cleanup safe, so a panel that always forced would quietly undo that.
   */
  async function remove(w: WorktreeEntry) {
    const holder = holders.get(w.path);
    const detail = w.dirty && w.orphanCommits
      ? t("worktree.holdsBoth")
      : w.dirty
        ? t("worktree.holdsChanges")
        : w.orphanCommits
          ? t("worktree.holdsCommits")
          : null;
    const ok = await confirmDialog.ask({
      title: t("worktree.removeTitle", { name: basename(w.path) }),
      message: [detail, holder ? t("worktree.inUseBy", { thread: holder.label }) : null]
        .filter(Boolean)
        .join(" ") || t("worktree.removeClean"),
      confirmLabel: t("worktree.removeConfirm"),
      danger: true,
    });
    if (!ok) return;
    busy[w.path] = true;
    try {
      await backendForPath(project.cwd).worktree.remove(repo, w.path, holdsWork(w));
      await load();
    } catch (err) {
      logger.warn("worktree", `could not remove ${w.path}`, String(err));
      notifications.error(String(err));
    } finally {
      delete busy[w.path];
    }
  }
</script>

<section class="rounded-lg border border-border bg-[var(--color-surface)]">
  <header class="flex items-center gap-2 border-b border-border px-3 py-2">
    <FolderGit2 class="size-4 shrink-0 text-muted-foreground" />
    <h2 class="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {t("worktree.title")}
    </h2>
    <span class="flex-1"></span>
    {#if dirtyCount > 0}
      <span class="text-xs text-[var(--color-warning)]">
        {t("worktree.dirtyCount", { count: dirtyCount })}
      </span>
    {/if}
    {#if canToggle}
      <label
        class="flex select-none items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground {togglingAuto
          ? 'cursor-wait opacity-60'
          : 'cursor-pointer'}"
        title={autoWorktrees ? t("worktree.autoOnHint") : t("worktree.autoOffHint")}
      >
        <input
          type="checkbox"
          class="size-3 accent-[var(--color-foreground)]"
          checked={autoWorktrees}
          disabled={togglingAuto}
          aria-busy={togglingAuto}
          onchange={(e) => void toggleAuto(e.currentTarget.checked)}
        />
        {t("worktree.autoLabel")}
      </label>
    {/if}
    <button
      type="button"
      class="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
      onclick={load}
      disabled={loading}
      title={t("worktree.refresh")}
      aria-label={t("worktree.refresh")}
    >
      <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
    </button>
  </header>

  <!-- Dimmed while the switch is off, list and all. The worktrees already on
       disk are still real and still removable — the setting only decides what
       the next thread does — so this reads as "not what happens here any more"
       rather than as a disabled control. -->
  <div class:opacity-50={canToggle && !autoWorktrees}>
  {#if failed}
    <!-- git's own words, kept: "not a repository" and "git: command not found"
         are different problems with different fixes, and one generic line made
         them look like the same one. -->
    <div class="px-3 py-4 text-center" role="status">
      <p class="text-sm text-muted-foreground">{t("worktree.unreadable")}</p>
      <p class="mt-1 break-words font-mono text-xs leading-snug text-muted-foreground/70">
        {failed}
      </p>
    </div>
  {:else if entries.length === 0}
    <p class="px-3 py-4 text-center text-sm text-muted-foreground">
      {loading
        ? t("worktree.loading")
        : canToggle && !autoWorktrees
          ? t("worktree.offHere")
          : t("worktree.none")}
    </p>
  {:else}
    <!-- Capped and scrolled: this sits on the dashboard beside five other
         cards now, and a repository with a dozen worktrees used to push all of
         them off the screen. -->
    <ul class="max-h-56 divide-y divide-border overflow-y-auto">
      {#each entries as w (w.path)}
        {@const holder = holders.get(w.path)}
        <li class="flex items-start gap-2.5 px-3 py-1.5">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate text-base text-foreground/90" title={w.path}>
                {basename(w.path)}
              </span>
              {#if w.main}
                <span
                  class="shrink-0 rounded-full border border-border px-1.5 py-px text-2xs uppercase tracking-wide text-muted-foreground"
                >
                  {t("worktree.main")}
                </span>
              {/if}
              {#if w.locked}
                <Lock class="size-3 shrink-0 text-muted-foreground" />
              {/if}
            </div>

            <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span class="font-mono text-muted-foreground">
                {w.branch ?? t("worktree.detachedAt", { head: w.head.slice(0, 7) })}
              </span>
              {#if w.dirty}
                <span class="text-[var(--color-warning)]">{t("worktree.dirty")}</span>
              {/if}
              {#if w.orphanCommits}
                <span class="text-[var(--color-warning)]">{t("worktree.orphan")}</span>
              {/if}
              {#if w.prunable}
                <span class="text-muted-foreground">{t("worktree.prunable")}</span>
              {/if}
              {#if !w.main && !holdsWork(w) && !w.prunable}
                <span class="text-muted-foreground">{t("worktree.empty")}</span>
              {/if}
            </div>

            {#if holder}
              <p class="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShortcutIcon iconKey={holder.iconKey} size={11} />
                <span class="truncate">{t("worktree.heldBy", { thread: holder.label })}</span>
              </p>
            {/if}
          </div>

          <!-- The repository's own checkout is in the list so the count adds
               up, and it is the one thing here that must never be removable. -->
          {#if !w.main}
            <button
              type="button"
              class="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-[var(--color-danger)] disabled:opacity-40"
              onclick={() => remove(w)}
              disabled={busy[w.path] === true}
              title={t("worktree.remove")}
              aria-label={t("worktree.remove")}
            >
              <Trash2 class="size-3.5" />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  </div>
</section>
