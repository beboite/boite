<!--
  The workspace page.

  It used to be four cards in a three-column grid with the chat bolted under
  them, so the one thing on this page a user types into opened below the fold
  and the three read-only cards took the eye first. The conversation is the page
  now: it holds the left column at full height, and what is only ever read
  stacks in a narrow column beside it. Under `lg` the two become one scroll, the
  chat still first.
-->
<script lang="ts">
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { goToHomeProject } from "./store.svelte";
  import Button from "$lib/shared/components/Button.svelte";
  import AgentsLive from "./AgentsLive.svelte";
  import AccountsCard from "./AccountsCard.svelte";
  import WorkspaceTokens from "./WorkspaceTokens.svelte";
  import Inbox from "./Inbox.svelte";
  import OrchestratorChat from "./OrchestratorChat.svelte";
  import { orchestrator } from "$lib/features/orchestrator/store.svelte";
  import { takeEverythingBack } from "$lib/app/dispatches";

  $effect(() => relativeClock.subscribe());

  // With no chat there is no left column to sit beside, so the same four cards
  // spread rather than queue in a 22rem gutter with the rest of the page empty.
  const aside = $derived(
    orchestrator.enabled
      ? "lg:w-[22rem] lg:min-h-0 lg:overflow-y-auto"
      : "lg:grid lg:w-full lg:grid-cols-3 lg:content-start lg:min-h-0 lg:overflow-y-auto",
  );
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
    <span class="truncate text-xs font-medium text-foreground/90">{t("home.title")}</span>
    <span class="flex-1"></span>
    {#if orchestrator.enabled}
      <!-- The kill switch the plan promises: every worker muted, every queued
           line dropped on the boite. The user owns the workspace again. -->
      <Button variant="danger" onclick={() => void takeEverythingBack()}>
        {t("home.takeBackAll")}
      </Button>
    {/if}
    <Button variant="ghost" onclick={goToHomeProject}>{t("home.goToProject")}</Button>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
    <div
      class="mx-auto flex h-auto w-full max-w-[100rem] flex-col gap-3 p-4 lg:h-full lg:min-h-0 lg:flex-row"
    >
      {#if orchestrator.enabled}
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <OrchestratorChat fill />
        </div>
      {/if}
      <div class="flex shrink-0 flex-col gap-3 {aside}">
        <AgentsLive />
        <Inbox />
        <WorkspaceTokens />
        <AccountsCard />
      </div>
    </div>
  </div>
</div>
