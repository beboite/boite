<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { cliDetection } from "$lib/features/settings/cliDetection.svelte";
  import { isScratch, projectDisplayName } from "$lib/features/project/scratch";
  import ProjectOverview from "./ProjectOverview.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import { t } from "$lib/i18n/index.svelte";

  /**
   * What a project looks like when you click it.
   *
   * It used to look like nothing: selecting a project changed which threads the
   * sidebar expanded and left the main area on a list of keyboard shortcuts.
   * This is the page that answers "what is going on here, and what do I want to
   * do about it".
   *
   * The shortcut bar is the page's own rather than the terminal view's. This
   * page covers the whole main area, so for as long as it was on screen the bar
   * was behind it — a project page with no way to start anything in the project
   * it was describing. Worktrees used to be a second tab up here and are a card
   * on the overview now: two tabs were two clicks to see one screen's worth of
   * information, and the room the chat pane once needed is free.
   */
  type Props = { onOpenThread: (threadId: string) => void };
  let { onOpenThread }: Props = $props();

  const project = $derived(
    app.projects.find((p) => p.id === app.selectedProjectId) ?? null,
  );

  onMount(() => {
    void cliDetection.ensure();
  });
</script>

{#if !project}
  <div class="flex h-full items-center justify-center">
    <div class="flex flex-col items-center gap-3 text-center">
      <span class="text-muted-foreground/40"><BoiteLogo size={48} /></span>
      <p class="text-sm text-muted-foreground">{t("project.pickOne")}</p>
    </div>
  </div>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex h-8 shrink-0 items-center gap-2 border-b border-border px-4">
      {#if project.icon}
        <img src={project.icon} alt="" class="size-4 shrink-0 rounded-sm object-cover" />
      {/if}
      <span class="truncate text-xs font-medium text-foreground/90">
        {projectDisplayName(project)}
      </span>
      {#if isScratch(project)}
        <span class="truncate text-xs text-muted-foreground/70">
          {t("project.scratchNotice")}
        </span>
      {/if}
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto" class:scratch-page={isScratch(project)}>
      <div
        class="mx-auto w-full max-w-6xl px-4 py-4"
        class:scratch-cards={isScratch(project)}
      >
        <ProjectOverview {project} {onOpenThread} />
      </div>
    </div>
  </div>
{/if}

<style>
  /* Scratch is a starting point, not a project, and the page says so the same
     way its sidebar card does: faded, and hatched so it reads as scaffolding
     even at a glance. The stripes are on the scroller rather than on each card
     so they run continuously behind all of them. */
  .scratch-page {
    background-image: repeating-linear-gradient(
      135deg,
      transparent 0 7px,
      color-mix(in srgb, var(--color-foreground) 3%, transparent) 7px 8px
    );
  }
  /* On the wrapper that holds the cards, so the hatch behind them keeps its own
     opacity. This used to be a global selector on the `section` tag, which faded
     anything that happened to be a section anywhere below, from outside the
     component that owns it: the usage figures were dimmed by a rule about
     scratch cards. */
  .scratch-cards {
    opacity: 0.72;
  }
</style>
