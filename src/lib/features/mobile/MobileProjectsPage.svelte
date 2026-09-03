<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { visibleStatus } from "$lib/domain/thread-status";
  import { isScratch } from "$lib/domain/project";
  import { isSettled } from "$lib/domain/thread-settle";
  import { isDelegated } from "$lib/domain/delegation";
  import { projectDisplayName } from "$lib/shared/project-label";
  import { pickAndAddProject } from "$lib/features/project/api";
  import { openProjectDashboard } from "$lib/features/project/dashboard";
  import { closeThreadWithConfirm } from "$lib/features/thread/api";
  import { t } from "$lib/i18n/index.svelte";
  import type { Thread, ThreadStatus } from "$lib/types";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import { launchSheet } from "./MobileLaunchSheet.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
  import X from "@lucide/svelte/icons/x";
  import Unlink2 from "@lucide/svelte/icons/unlink-2";
  import { rowFlip } from "$lib/shared/actions/rowFlip.svelte";

  const projects = $derived(app.sortedProjects);

  /**
   * The same list the sidebar draws, in the same order, minus what was put
   * away.
   *
   * There is no way to put one away from here yet, but a phone that still
   * showed what a laptop put away would make the gesture look like it did not
   * take.
   */
  function liveThreads(projectId: string): Thread[] {
    return app.threadsByProjectSorted(projectId).filter((x) => !isSettled(x));
  }

  function displayStatus(thread: Thread): ThreadStatus {
    if (app.unboundByDedup.includes(thread.id)) return "error";
    return visibleStatus(thread.status, !!thread.ptyId);
  }

  function openThread(thread: Thread) {
    app.selectedProjectId = thread.projectId;
    app.activeThreadId = thread.id;
    app.mobileTab = "terminal";
  }

  // The sheet itself is mounted by the top bar, which is always on screen; this
  // page only points it at a project and asks it to open.
  function launchInto(id: string) {
    app.selectedProjectId = id;
    launchSheet.open = true;
  }

  // The overview the PC gets by clicking a project row. It has no row here —
  // tapping a card opens a terminal, which is what a phone is usually for — so
  // the page it used to have no way to reach gets a button of its own.
  function showDashboard(id: string) {
    openProjectDashboard(id);
  }

  // Tapping a project should land on a live terminal: open its most recent
  // thread, or the launch picker when it has none (selecting alone left the
  // user on an empty terminal page).
  function selectProject(id: string) {
    app.selectedProjectId = id;
    const threads = liveThreads(id);
    if (threads.length > 0) {
      app.activeThreadId = threads[threads.length - 1].id;
      app.mobileTab = "terminal";
    } else {
      launchInto(id);
    }
  }
</script>

<!-- The left/right insets matter here in landscape on a notched phone: the page
     fills the window, so without them the header title and the cards run under
     the cutout. -->
<div
  class="flex h-full min-h-0 flex-col bg-background"
  style="padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px);"
>
  <header class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
    <h2 class="text-sm font-semibold text-foreground">{t("sidebar.projects")}</h2>
    <button
      type="button"
      class="flex min-h-11 items-center gap-1.5 rounded-lg border border-edge bg-[var(--color-surface-2)] px-3 py-2 text-base font-medium text-foreground transition active:bg-[var(--color-surface-3)]"
      onclick={() => void pickAndAddProject()}
    >
      <FolderPlus class="size-4" />
      {t("shortcuts.add")}
    </button>
  </header>

  <div class="min-h-0 flex-1 scroll-pane overflow-y-auto p-2.5">
    {#if projects.length === 0}
      <div class="flex flex-col items-center gap-3 px-4 py-12 text-center text-sm text-muted-foreground">
        {t("mobile.noProjects")}
      </div>
    {:else}
      <div
        class="flex flex-col gap-2.5"
        use:rowFlip={{ key: () => projects.map((p) => p.id).join(",") }}
      >
        {#each projects as project (project.id)}
          {@const threads = liveThreads(project.id)}
          {@const isCurrent = app.currentProjectId === project.id}
          <!-- Scratch reads as temporary here the same way it does in the
               sidebar: the whole card faded and hatched, threads included. It
               is a starting point, not one of the things being worked on. -->
          <section
            class="overflow-hidden rounded-xl border bg-[var(--color-surface)] {isCurrent
              ? 'border-foreground/25'
              : 'border-border'}"
            class:scratch-card={isScratch(project)}
          >
            <div class="flex items-center gap-3 px-3 py-3">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-3 text-left"
                onclick={() => selectProject(project.id)}
              >
                <span
                  class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md"
                  style:background={project.icon ? "transparent" : "var(--color-surface-3)"}
                >
                  {#if project.icon}
                    <img src={project.icon} alt="" class="size-full object-contain" decoding="async" draggable="false" />
                  {:else}
                    <span class="text-sm font-semibold text-muted-foreground">
                      {projectDisplayName(project).charAt(0).toUpperCase()}
                    </span>
                  {/if}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-md font-medium text-foreground">{projectDisplayName(project)}</span>
                  <span class="block truncate text-xs text-muted-foreground">
                    {threads.length === 1
                      ? t("mobile.terminalCountOne", { count: threads.length })
                      : t("mobile.terminalCount", { count: threads.length })}
                  </span>
                </span>
              </button>
              <button
                type="button"
                class="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent active:bg-accent/70"
                onclick={() => showDashboard(project.id)}
                aria-label={t("mobile.openDashboard", {
                  project: projectDisplayName(project),
                })}
              >
                <LayoutDashboard class="size-5" />
              </button>
              <button
                type="button"
                class="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground transition hover:bg-accent active:bg-accent/70"
                onclick={() => launchInto(project.id)}
                aria-label={t("mobile.newTerminalIn", { project: projectDisplayName(project) })}
              >
                <Plus class="size-5" />
              </button>
            </div>

            {#if threads.length > 0}
              <ul
                class="border-t border-border"
                use:rowFlip={{ key: () => threads.map((x) => x.id).join(",") }}
              >
                {#each threads as thread (thread.id)}
                  {@const isActive = app.activeThreadId === thread.id}
                  <li class="flex min-h-11 items-center gap-3 px-3 py-2.5 {isActive ? 'bg-[var(--color-surface-2)]' : ''}">
                    <button
                      type="button"
                      class="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
                      onclick={() => openThread(thread)}
                    >
                      <StatusDot
                        status={displayStatus(thread)}
                        asleep={thread.autoSlept ?? false}
                        keepAwake={(thread.keepAwake ?? false) && !!thread.ptyId}
                      />
                      <ShortcutIcon iconKey={thread.iconKey} size={15} color={threadIconColor(thread)} />
                      <span class="min-w-0 flex-1 truncate text-base text-foreground">
                        {thread.title ?? thread.label}
                      </span>
                    </button>
                    <!-- Kept a thumb's width clear of the open-thread target next
                         to it, and given the same 44px as everything else here:
                         a mistap on this one kills a running process. -->
                    {#if isDelegated(thread)}
                      <button
                        type="button"
                        class="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-2 transition hover:bg-accent hover:text-foreground active:bg-accent/70"
                        onclick={() => app.detachDelegation(thread.id)}
                        aria-label={t("sidebar.detachDelegation")}
                      >
                        <Unlink2 class="size-4" />
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="ml-2 flex size-11 shrink-0 items-center justify-center rounded-lg border-l border-border/60 text-muted-2 transition hover:bg-danger/20 hover:text-danger active:bg-danger/30"
                      onclick={() => void closeThreadWithConfirm(thread.id)}
                      aria-label={t("mobile.closeTerminal", { name: thread.label })}
                    >
                      <X class="size-4" />
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  /* Same reading as the sidebar's scratch card, at touch size: hatched so it
     stays legible as temporary without a badge taking up a line. The fade is
     on the rows, not the section, for the same compositor reason the sidebar
     card stopped putting opacity on the whole block. */
  .scratch-card {
    background-image: repeating-linear-gradient(
      135deg,
      transparent 0 6px,
      color-mix(in srgb, var(--color-foreground) 7%, transparent) 6px 7px
    );
  }
  .scratch-card > :not(ul),
  .scratch-card li {
    opacity: 0.62;
  }
</style>
