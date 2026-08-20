<script lang="ts">
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { goToHomeProject } from "./store.svelte";
  import AgentsLive from "./AgentsLive.svelte";
  import AccountsCard from "./AccountsCard.svelte";
  import WorkspaceTokens from "./WorkspaceTokens.svelte";
  import Inbox from "./Inbox.svelte";
  import OrchestratorChat from "./OrchestratorChat.svelte";
  import { orchestrator } from "$lib/features/orchestrator/store.svelte";
  import { takeEverythingBack } from "$lib/app/dispatches";

  $effect(() => relativeClock.subscribe());
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-8 shrink-0 items-center gap-2 border-b border-border px-4">
    <span class="truncate text-xs font-medium text-foreground/90">{t("home.title")}</span>
    <span class="flex-1"></span>
    {#if orchestrator.enabled}
      <!-- The kill switch the plan promises: every worker muted, every queued
           line dropped on the boite. The user owns the workspace again. -->
      <button
        type="button"
        class="rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={() => void takeEverythingBack()}
      >
        {t("home.takeBackAll")}
      </button>
    {/if}
    <button
      type="button"
      class="rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
      onclick={goToHomeProject}
    >
      {t("home.goToProject")}
    </button>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto w-full max-w-[110rem] px-5 py-5">
      <div class="grid gap-3 lg:grid-cols-3">
        <AgentsLive />
        <WorkspaceTokens />
        <Inbox />
        <AccountsCard />
        {#if orchestrator.enabled}
          <div class="lg:col-span-3">
            <OrchestratorChat />
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
