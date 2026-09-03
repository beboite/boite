<!--
  The workspace page, in two states.

  Something running: the conversation is the page, holding the left column at
  full height, with what is only ever read stacked beside it.

  Nothing running and the orchestrator silent for an hour (`isQuiet`): the page
  is a launcher instead. The audit measured nine tenths of the screen empty
  here, a page-sized chat log for zero messages and two cards both saying
  "Rien n'attend."; the main column becomes Start, Recent and the composer as
  one card among them, and the two empty cards merge into one.

  Under `lg` both states become one scroll, which is also the phone's layout.
-->
<script lang="ts">
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { app } from "$lib/app/store.svelte";
  import { goToHomeProject, home, isQuiet } from "./store.svelte";
  import { orchestratorActions } from "./actions.svelte";
  import Button from "$lib/shared/components/Button.svelte";
  import AgentsLive from "./AgentsLive.svelte";
  import AccountsCard from "./AccountsCard.svelte";
  import Inbox from "./Inbox.svelte";
  import NothingWaiting from "./NothingWaiting.svelte";
  import OrchestratorChat from "./OrchestratorChat.svelte";
  import RecentCard from "./RecentCard.svelte";
  import StartCard from "./StartCard.svelte";
  import { orchestrator } from "$lib/features/orchestrator/store.svelte";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { takeEverythingBack } from "$lib/app/dispatches";

  $effect(() => relativeClock.subscribe());

  // The undo offers are read here rather than inside the inbox: the merge rule
  // below has to know whether that card has anything before deciding to draw it.
  $effect(() => {
    void orchestratorActions.load();
  });

  const lastOrchestratorAt = $derived(
    orchestrator.conversation.messages[orchestrator.conversation.messages.length - 1]
      ?.at ?? null,
  );

  const quiet = $derived(
    isQuiet({ threads: app.threads, lastOrchestratorAt, now: relativeClock.now }),
  );

  // One card instead of two while neither has a row. Either side filling up
  // gives both their own header back, so nothing is ever hidden by the merge.
  const merged = $derived(
    home.liveThreads.length === 0 &&
      home.inbox.length === 0 &&
      orchestratorActions.undoable.length === 0,
  );

  // With no chat there is no left column to sit beside, so the same cards
  // spread rather than queue in a 22rem gutter with the rest of the page empty.
  const aside = $derived(
    orchestrator.enabled
      ? "lg:w-[22rem] lg:min-h-0 lg:overflow-y-auto"
      : "lg:grid lg:w-full lg:grid-cols-3 lg:content-start lg:min-h-0 lg:overflow-y-auto",
  );

  // The kill switch the plan promises: every worker muted, every queued line
  // dropped on the boite. It asks first now — it is one click from a page whose
  // other buttons only navigate, and nothing it does undoes itself.
  async function takeBack() {
    const ok = await confirmDialog.ask({
      title: t("home.takeBackAllConfirm"),
      message: t("home.takeBackAllConfirmDetail"),
      confirmLabel: t("home.takeBackAll"),
      danger: true,
    });
    if (!ok) return;
    await takeEverythingBack();
    notifications.success(t("home.takeBackAllDone"));
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
    <span class="truncate text-xs font-medium text-foreground">{t("home.title")}</span>
    <!-- Navigation on the left, the destructive button alone on the right: the
         two used to sit side by side in the same style, one folder away from
         muting the workspace. -->
    <Button variant="ghost" onclick={goToHomeProject} tip={t("home.goToProjectTip")}>
      {t("home.goToProject")}
    </Button>
    <span class="flex-1"></span>
    {#if orchestrator.enabled}
      <Button
        variant="danger"
        class="border-transparent bg-danger text-white hover:bg-danger/90 hover:text-white"
        onclick={() => void takeBack()}
        tip={t("home.takeBackAllTip")}
      >
        {t("home.takeBackAll")}
      </Button>
    {/if}
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
    <div
      class="mx-auto flex h-auto w-full max-w-[100rem] flex-col gap-3 p-4 lg:h-full lg:min-h-0 lg:flex-row"
    >
      {#if quiet}
        <div class="flex min-w-0 flex-1 flex-col gap-3 lg:min-h-0 lg:overflow-y-auto">
          <StartCard />
          <RecentCard />
          {#if orchestrator.enabled}
            <OrchestratorChat hint />
          {/if}
        </div>
        <!-- Always the narrow gutter here: the main column has Start and
             Recent in it, so there is nothing for these to spread into. -->
        <div class="flex shrink-0 flex-col gap-3 lg:w-[22rem] lg:min-h-0 lg:overflow-y-auto">
          <AccountsCard />
          {#if merged}
            <NothingWaiting />
          {:else}
            <AgentsLive />
            <Inbox />
          {/if}
        </div>
      {:else}
        {#if orchestrator.enabled}
          <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            <OrchestratorChat fill />
          </div>
        {/if}
        <div class="flex shrink-0 flex-col gap-3 {aside}">
          {#if merged}
            <NothingWaiting />
          {:else}
            <AgentsLive />
            <Inbox />
          {/if}
          <AccountsCard />
        </div>
      {/if}
    </div>
  </div>
</div>
