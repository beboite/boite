<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { isScratch } from "$lib/domain/project";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import AgentAccess from "$lib/features/todo/AgentAccess.svelte";
  import DashboardCard from "./DashboardCard.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import type { Project } from "$lib/types";

  /**
   * What this project does to every thread launched in it.
   *
   * It used to be the top half of `ProjectWorktrees`, which meant the sweep
   * button was here too and the dashboard could not put the todo card between
   * the two. Nothing was shared but the sweep, and the sweep belongs with the
   * list it empties, so the split cost no state: this card reads the project
   * row and the settings store, and nothing else.
   */
  type Props = { project: Project; class?: string };
  let { project, class: klass = "" }: Props = $props();

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
  // The switch writes to the database. Left free, a second click during that
  // write raced the first and the row could settle on the value nobody picked.
  let togglingAuto = $state(false);

  async function toggleAuto() {
    if (togglingAuto || !canToggle) return;
    togglingAuto = true;
    try {
      await app.setProjectWorktrees(project.id, !autoWorktrees);
    } finally {
      togglingAuto = false;
    }
  }
</script>

<DashboardCard title={t("project.repoSettings")} class={klass}>
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

  <!-- Which agents can reach this project's MCP endpoint. A card of its own
       until now, full width, holding one line per agent — three columns of
       chrome around six words. It belongs here anyway: everything in this card
       is a thing this project does to every thread launched in it. -->
  <div class="mt-3 border-t border-border/60 pt-2.5">
    <p class="section-label mb-1">{t("project.agents")}</p>
    <AgentAccess {project} />
  </div>
</DashboardCard>
