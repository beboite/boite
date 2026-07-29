<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { cliDetection } from "$lib/features/settings/cliDetection.svelte";
  import ProjectOverview from "./ProjectOverview.svelte";
  import ProjectWorktrees from "./ProjectWorktrees.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import { t } from "$lib/i18n/index.svelte";

  /**
   * What a project looks like when you click it.
   *
   * It used to look like nothing: selecting a project changed which threads the
   * sidebar expanded and left the main area on a list of keyboard shortcuts.
   * This is the page that answers "what is going on here, and what do I want to
   * do about it".
   */
  type Props = { onOpenThread: (threadId: string) => void };
  let { onOpenThread }: Props = $props();

  const project = $derived(
    app.projects.find((p) => p.id === app.selectedProjectId) ?? null,
  );

  /**
   * Which half of the page is showing.
   *
   * Local rather than on `app`: it is where you were looking, not what the
   * workspace is, and coming back to a project a week later on its overview is
   * the right answer every time.
   */
  type Tab = "overview" | "worktrees";
  let tab = $state<Tab>("overview");

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
    <header class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4">
      {#if project.icon}
        <img src={project.icon} alt="" class="size-4 shrink-0 rounded-sm object-cover" />
      {/if}
      <span class="truncate text-xs font-medium text-foreground/90">{project.name}</span>
      <nav class="ml-2 flex items-center gap-0.5">
        {#each [["overview", t("project.tabOverview")], ["worktrees", t("project.tabWorktrees")]] as const as [id, label] (id)}
          <button
            type="button"
            class="rounded px-2 py-0.5 text-[11.5px] transition"
            class:bg-accent={tab === id}
            class:text-foreground={tab === id}
            class:text-muted-foreground={tab !== id}
            onclick={() => (tab = id)}
          >
            {label}
          </button>
        {/each}
      </nav>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-3xl px-4 py-4">
        {#if tab === "worktrees"}
          <ProjectWorktrees {project} />
        {:else}
          <ProjectOverview {project} {onOpenThread} />
        {/if}
      </div>
    </div>
  </div>
{/if}
