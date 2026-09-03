<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { phaseOf, phraseKeys } from "$lib/domain/awareness";
  import { visibleStatus } from "$lib/domain/thread-status";
  import { approvals } from "$lib/features/approvals/store.svelte";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import { home, openHomeThread } from "./store.svelte";
  import DashboardCard from "$lib/features/project/DashboardCard.svelte";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import type { Thread } from "$lib/types";
  import Bot from "@lucide/svelte/icons/bot";

  function phaseWord(thread: Thread) {
    const hasApproval = approvals.pending.some((row) => row.threadId === thread.id);
    const phase = phaseOf(thread.status, !!thread.ptyId, hasApproval);
    return t(phraseKeys(phase).detail);
  }
</script>

<DashboardCard title={t("home.agentsLive")} badge={home.liveThreads.length || null} flush>
  {#snippet icon()}<Bot class="size-3.5" />{/snippet}
  {#if home.liveThreads.length === 0}
    <p class="px-3.5 pb-3 text-sm text-muted-foreground">{t("home.empty")}</p>
  {:else}
    <ul class="flex max-h-64 flex-col overflow-y-auto px-2 pb-2">
      {#each home.liveThreads as thread (thread.id)}
        {@const status = visibleStatus(thread.status, !!thread.ptyId)}
        <li>
          <button
            type="button"
            class="flex w-full items-start gap-2 rounded-sm px-1.5 py-1.5 text-left transition hover:bg-accent"
            onclick={() => openHomeThread(thread.id)}
          >
            <span class="mt-0.5 flex shrink-0 items-center gap-1.5">
              <StatusDot
                {status}
                asleep={thread.autoSlept ?? false}
                keepAwake={(thread.keepAwake ?? false) && !!thread.ptyId}
              />
              <ShortcutIcon iconKey={thread.iconKey} size={13} color={threadIconColor(thread)} />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-base text-foreground">
                {thread.title ?? thread.label}
              </span>
              <span class="block truncate text-xs text-muted-2">
                {phaseWord(thread)}
              </span>
            </span>
            <span class="mt-0.5 flex shrink-0 items-center gap-1.5">
              {#if thread.acceptDispatch === false}
                <!-- The dispatch mute, visible from the dashboard: this row no
                     longer takes the orchestrator's lines. -->
                <span
                  class="rounded-sm border border-border px-1 text-xs text-muted-2"
                >
                  {t("home.dispatchMuted")}
                </span>
              {/if}
              <span class="truncate text-xs text-muted-2">
                {app.projectById(thread.projectId)?.name ?? ""}
              </span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</DashboardCard>
