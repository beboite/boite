<script lang="ts">
  import { gitStore, gitScope } from "$lib/features/git/store.svelte";
  import { isScratch } from "$lib/domain/project";
  import { tip } from "$lib/shared/actions/tooltip";
  import { relocateProject, removeProjectWithConfirm } from "./api";
  import { t } from "$lib/i18n/index.svelte";
  import FolderX from "@lucide/svelte/icons/folder-x";
  import GitBranchPlus from "@lucide/svelte/icons/git-branch-plus";
  import type { ProjectHealth } from "./health";
  import type { Project } from "$lib/types";

  /**
   * The one sentence a broken project gets, and the one action that fixes it.
   *
   * It replaces five cards each saying a version of "nothing here": a missing
   * folder used to print the same OS error in Git, Tours and Worktrees, one of
   * them in monospace, and offer nothing. Two states, never both, and each
   * carries the whole answer — what is wrong, which path it is about, and what
   * to press.
   *
   * Scratch is a folder that will never be a repository, so it is told apart
   * from a project that could be one: the sentence says what it is and there is
   * nothing to press. Running `git init` in someone's home directory because a
   * dashboard offered a button is not a thing this app does.
   */
  type Props = { project: Project; health: ProjectHealth };
  let { project, health }: Props = $props();

  const scratch = $derived(isScratch(project));
  const scope = $derived(gitScope(project.id, project.gitRoot ?? project.cwd));
  let initializing = $state(false);

  async function createRepo() {
    if (initializing) return;
    initializing = true;
    try {
      await gitStore.init(scope);
    } finally {
      initializing = false;
    }
  }
</script>

{#if health === "missing" || health === "notRepo"}
  <section
    class="flex min-w-0 flex-col gap-2 rounded-lg border px-3.5 py-3"
    style:border-color={health === "missing"
      ? "var(--color-danger)"
      : "var(--color-border)"}
    style:background-color="var(--color-surface)"
    role="status"
  >
    <div class="flex min-w-0 items-start gap-2.5">
      <span
        class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm bg-[var(--color-surface-2)] text-muted-foreground"
        aria-hidden="true"
      >
        {#if health === "missing"}
          <FolderX class="size-3.5" />
        {:else}
          <GitBranchPlus class="size-3.5" />
        {/if}
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-base text-foreground">
          {#if health === "missing"}
            {t("project.folderGone")}
          {:else if scratch}
            {t("project.scratchNotARepo")}
          {:else}
            {t("project.notARepoHere")}
          {/if}
        </p>
        <p class="mt-0.5 truncate text-sm text-muted-foreground" use:tip={project.cwd}>
          {project.cwd}
        </p>
      </div>
    </div>

    {#if health === "missing"}
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded-md border border-edge bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-foreground transition hover:bg-[var(--color-surface-3)]"
          onclick={() => void relocateProject(project)}
        >
          {t("project.relocate")}
        </button>
        <button
          type="button"
          class="rounded-md border border-edge px-3 py-1.5 text-sm text-[var(--color-danger)] transition hover:bg-[var(--color-surface-2)]"
          onclick={() => void removeProjectWithConfirm(project)}
        >
          {t("sidebar.removeProject")}
        </button>
      </div>
    {:else if !scratch}
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded-md border border-edge bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-foreground transition hover:bg-[var(--color-surface-3)] disabled:opacity-45"
          onclick={() => void createRepo()}
          disabled={initializing}
        >
          {t("git.initRepo")}
        </button>
      </div>
    {/if}
  </section>
{/if}
