<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { backendForPath } from "$lib/backend";
  import { settings } from "$lib/features/settings/store.svelte";
  import { isScratch } from "$lib/domain/project";
  import { forgetWarmedWorktree } from "$lib/features/thread/api";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { logger } from "$lib/shared/services/logger.svelte";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import AgentAccess from "$lib/features/todo/AgentAccess.svelte";
  import DashboardCard from "./DashboardCard.svelte";
  import { formatBytes, heldKeys, reclaimable, reclaimableBytes } from "./worktree-flush";
  import { pathKey } from "./path";
  import { basename } from "$lib/shared/utils/path";
  import { t } from "$lib/i18n/index.svelte";
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Eraser from "@lucide/svelte/icons/eraser";
  import Lock from "@lucide/svelte/icons/lock";
  import { fade, slide } from "svelte/transition";
  import { DUR, easeOutQuint } from "$lib/theme/motion";
  import type { WorktreeEntry } from "$lib/backend/types";
  import type { IconKey, Project } from "$lib/types";

  /**
   * Two cards: what this project does with worktrees, and which ones exist.
   *
   * They are one component because they are one answer. The switch decides what
   * the list will hold tomorrow, the sweep empties it today, and both have to
   * see the same rows — the sweep's button says how much disk it will give
   * back, and the list is where that space is watched leaving.
   *
   * The list is read from the repository rather than from Boite's thread rows:
   * a thread that was deleted leaves its worktree on disk, holding whatever the
   * agent had not committed, and nothing in Boite showed it.
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
  let sizes = $state<Record<string, number>>({});
  let loading = $state(false);
  let failed = $state<string | null>(null);
  let busy = $state<Record<string, true>>({});
  let sweeping = $state(false);
  // The switch writes to the database. Left free, a second click during that
  // write raced the first and the row could settle on the value nobody picked.
  let togglingAuto = $state(false);

  const repo = $derived(project.gitRoot ?? project.cwd);
  // Which thread is standing in which directory, so a row can say who is using
  // it before anyone is asked whether it can go.
  //
  // Keyed rather than kept as the thread wrote it: a row's path comes back from
  // git, which spells the same Windows directory with forward slashes, and a
  // lookup on the raw string missed every time. See `heldKeys`.
  const holders = $derived.by(() => {
    const map = new Map<string, { label: string; iconKey: IconKey }>();
    for (const thread of app.threads) {
      if (thread.worktreePath) {
        map.set(pathKey(thread.worktreePath), {
          label: thread.title ?? thread.label,
          iconKey: thread.iconKey,
        });
      }
    }
    return map;
  });

  const heldPaths = $derived(heldKeys(holders.keys()));
  const dirtyCount = $derived(entries.filter((w) => !w.main && holdsWork(w)).length);
  const sweepable = $derived(reclaimable(entries, heldPaths));
  const sweepableBytes = $derived(reclaimableBytes(sweepable, sizes));

  function holdsWork(w: WorktreeEntry): boolean {
    return w.dirty || w.orphanCommits;
  }

  async function load() {
    if (loading) return;
    loading = true;
    failed = null;
    try {
      entries = await backendForPath(project.cwd).worktree.list(repo);
      void measure();
    } catch (err) {
      // A project that is not a repository has no worktrees rather than an
      // error worth a toast, but the panel still has to say which it is.
      failed = String(err);
      entries = [];
      sizes = {};
    } finally {
      loading = false;
    }
  }

  /**
   * What the removable ones weigh, asked for after the list is drawn.
   *
   * A walk over every file of every checkout, so it is never in front of the
   * page: the rows appear, and the button learns what it is offering a moment
   * later. A failure leaves the button on its wordless label rather than
   * raising anything — the sweep works either way, it just cannot promise a
   * number.
   */
  async function measure() {
    const paths = entries.filter((w) => !w.main).map((w) => w.path);
    if (paths.length === 0) {
      sizes = {};
      return;
    }
    try {
      const measured = await backendForPath(project.cwd).worktree.sizes(paths);
      const next: Record<string, number> = {};
      paths.forEach((path, i) => {
        next[path] = measured[i] ?? 0;
      });
      sizes = next;
    } catch (err) {
      logger.info("worktree", "could not measure worktrees", String(err));
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

  async function toggleAuto() {
    if (togglingAuto || !canToggle) return;
    togglingAuto = true;
    try {
      await app.setProjectWorktrees(project.id, !autoWorktrees);
    } finally {
      togglingAuto = false;
    }
  }

  /** Takes the row out of the list now, so the card empties as the sweep runs
      rather than all at once when it is over. */
  function drop(path: string) {
    entries = entries.filter((w) => w.path !== path);
    delete sizes[path];
  }

  /**
   * Removes a worktree, after saying plainly what removing it destroys.
   *
   * `force` is only ever the user answering for themselves. The unforced call
   * refuses while the directory holds work, which is what makes the automatic
   * cleanup safe, so a panel that always forced would quietly undo that.
   */
  async function remove(w: WorktreeEntry) {
    const holder = holders.get(pathKey(w.path));
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
      // The pool is primed once per project and has no way to notice a spare
      // going away from here. Without this the project runs without one until
      // the app is restarted.
      if (w.spare) forgetWarmedWorktree(project);
      drop(w.path);
      await load();
    } catch (err) {
      logger.warn("worktree", `could not remove ${w.path}`, String(err));
      notifications.error(String(err));
    } finally {
      delete busy[w.path];
    }
  }

  /**
   * Gives back every worktree that costs nothing to lose.
   *
   * One at a time and unforced, deliberately. Unforced means the backend is
   * still the thing deciding whether a directory holds work, so a file written
   * between the listing and the click keeps its worktree; one at a time means
   * the list empties row by row in front of the user rather than blinking from
   * eleven rows to two.
   */
  async function sweep() {
    if (sweeping) return;
    const targets = sweepable;
    if (targets.length === 0) return;
    const ok = await confirmDialog.ask({
      title: t("worktree.sweepTitle", { count: targets.length }),
      message:
        sweepableBytes > 0
          ? t("worktree.sweepMessage", { size: formatBytes(sweepableBytes) })
          : t("worktree.sweepMessageNoSize"),
      confirmLabel: t("worktree.sweepConfirm"),
      danger: true,
    });
    if (!ok) return;
    sweeping = true;
    let spareGone = false;
    let kept = 0;
    try {
      for (const w of targets) {
        busy[w.path] = true;
        try {
          await backendForPath(project.cwd).worktree.remove(repo, w.path, false);
          if (w.spare) spareGone = true;
          drop(w.path);
        } catch (err) {
          // The backend refused, which is the safety net working: something
          // landed in that directory since the list was read.
          kept++;
          logger.info("worktree", `kept ${w.path} during the sweep`, String(err));
        } finally {
          delete busy[w.path];
        }
      }
      if (spareGone) forgetWarmedWorktree(project);
      if (kept > 0) notifications.error(t("worktree.sweepKept", { count: kept }));
    } finally {
      sweeping = false;
      await load();
    }
  }
</script>

<!-- The project's own settings, which until now were a checkbox wedged into the
     worktree list's header: a control that decides what every future thread
     does, drawn as an afterthought beside a refresh button. -->
<DashboardCard title={t("project.repoSettings")}>
  {#snippet icon()}<SlidersHorizontal class="size-3.5" />{/snippet}

  {#if canToggle}
    <ToggleSetting
      label={t("worktree.autoLabel")}
      description={autoWorktrees ? t("worktree.autoOnHint") : t("worktree.autoOffHint")}
      enabled={autoWorktrees}
      onToggle={() => void toggleAuto()}
    />
  {:else}
    <p class="text-sm text-muted-foreground">{t("project.repoSettingsScratch")}</p>
  {/if}

  <!-- The number is the whole point of the button: "clean up worktrees" is a
       chore, "free 4.2 GB" is a reason. -->
  <button
    type="button"
    class="mt-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-2 text-sm text-foreground transition hover:bg-[var(--color-surface-3)] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[var(--color-surface-2)]"
    onclick={() => void sweep()}
    disabled={sweeping || sweepable.length === 0}
  >
    <Eraser class="size-3.5 {sweeping ? 'animate-pulse' : ''}" />
    {#if sweeping}
      {t("worktree.sweeping")}
    {:else if sweepable.length === 0}
      {t("worktree.sweepNothing")}
    {:else if sweepableBytes > 0}
      {t("worktree.sweepFree", { size: formatBytes(sweepableBytes) })}
    {:else}
      {t("worktree.sweepCount", { count: sweepable.length })}
    {/if}
  </button>
  {#if sweepable.length > 0 && !sweeping}
    <p class="mt-1 text-center text-xs text-muted-foreground/70">
      {t("worktree.sweepHint", { count: sweepable.length })}
    </p>
  {/if}

  <!-- Which agents can reach this project's MCP endpoint. A card of its own
       until now, full width, holding one line per agent — three columns of
       chrome around six words. It belongs here anyway: everything in this card
       is a thing this project does to every thread launched in it. -->
  <div class="mt-3 border-t border-border/60 pt-2.5">
    <p class="section-label mb-1">{t("project.agents")}</p>
    <AgentAccess {project} />
  </div>
</DashboardCard>

<DashboardCard
  title={t("worktree.title")}
  badge={entries.length || null}
  class="lg:col-span-2"
  flush
>
  {#snippet icon()}<FolderGit2 class="size-3.5" />{/snippet}
  {#snippet lead()}
    {#if dirtyCount > 0}
      <span class="text-xs text-[var(--color-warning)]">
        {t("worktree.dirtyCount", { count: dirtyCount })}
      </span>
    {/if}
  {/snippet}
  {#snippet actions()}
    <button
      type="button"
      class="rounded-sm p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
      onclick={load}
      disabled={loading}
      title={t("worktree.refresh")}
      aria-label={t("worktree.refresh")}
    >
      <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
    </button>
  {/snippet}

  <!-- Dimmed while the switch is off, list and all. The worktrees already on
       disk are still real and still removable — the setting only decides what
       the next thread does — so this reads as "not what happens here any more"
       rather than as a disabled control. -->
  <div class:opacity-50={canToggle && !autoWorktrees}>
    {#if failed}
      <!-- git's own words, kept: "not a repository" and "git: command not found"
           are different problems with different fixes, and one generic line made
           them look like the same one. -->
      <div class="px-3.5 pb-4 text-center" role="status">
        <p class="text-sm text-muted-foreground">{t("worktree.unreadable")}</p>
        <p class="mt-1 break-words font-mono text-xs leading-snug text-muted-foreground/70">
          {failed}
        </p>
      </div>
    {:else if entries.length === 0}
      <p class="px-3.5 pb-4 text-center text-sm text-muted-foreground">
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
      <ul class="max-h-64 divide-y divide-border overflow-y-auto">
        {#each entries as w (w.path)}
          {@const holder = holders.get(pathKey(w.path))}
          {@const size = sizes[w.path] ?? 0}
          <li
            class="flex items-start gap-2.5 px-3.5 py-2 transition-opacity"
            class:opacity-40={busy[w.path] === true}
            out:slide={{ duration: DUR.base, easing: easeOutQuint }}
          >
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
                {#if w.spare}
                  <span
                    class="shrink-0 rounded-full border border-border px-1.5 py-px text-[9.5px] uppercase tracking-wide text-muted-foreground"
                    title={t("worktree.spareHint")}
                  >
                    {t("worktree.spare")}
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
                {#if size > 0}
                  <span class="font-mono text-muted-foreground/70" in:fade={{ duration: DUR.fast }}>
                    {formatBytes(size)}
                  </span>
                {/if}
                {#if w.dirty}
                  <span class="text-[var(--color-warning)]">{t("worktree.dirty")}</span>
                {/if}
                {#if w.orphanCommits}
                  <span class="text-[var(--color-warning)]">{t("worktree.orphan")}</span>
                {/if}
                {#if w.prunable}
                  <span class="text-muted-foreground">{t("worktree.prunable")}</span>
                {/if}
                {#if !w.main && !holdsWork(w) && !w.prunable && !w.spare}
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
                class="shrink-0 rounded-sm p-1 text-muted-foreground transition hover:bg-accent hover:text-[var(--color-danger)] disabled:opacity-40"
                onclick={() => remove(w)}
                disabled={busy[w.path] === true || sweeping}
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
</DashboardCard>
