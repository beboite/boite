<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { formatAgo, formatSpan } from "$lib/shared/utils/relative-time";
  import { threadActivitySince } from "$lib/features/thread/activity.svelte";
  import { home, openHomeThread, type InboxItem } from "./store.svelte";
  import DashboardCard from "$lib/features/project/DashboardCard.svelte";
  import InboxIcon from "@lucide/svelte/icons/inbox";

  const ACTIONS = {
    "thread.move": "approval.action.thread.move",
    "project.create": "approval.action.project.create",
    "thread.spawn": "approval.action.thread.spawn",
  } as const;

  function projectName(id: string) {
    return app.projectById(id)?.name ?? "";
  }

  function threadName(id: string) {
    const thread = app.threadById(id);
    return thread?.title || thread?.label || id.slice(0, 8);
  }

  function approvalLine(item: Extract<InboxItem, { kind: "approval" }>): {
    title: string;
    detail: string;
    threadId: string | null;
  } {
    if (item.approval.source === "agent") {
      const action = item.approval.row.action;
      const detail = item.approval.row.detail;
      const key = ACTIONS[action as keyof typeof ACTIONS];
      return {
        title: threadName(item.approval.row.threadId),
        detail: key ? t(key, { detail }) : t("approval.action.other", { action, detail }),
        threadId: item.approval.row.threadId,
      };
    }
    return {
      title: item.approval.ask.title,
      detail: item.approval.ask.message,
      threadId: null,
    };
  }

  function waitingLine(item: Extract<InboxItem, { kind: "waiting" }>) {
    const since = threadActivitySince(item.thread.id) ?? item.thread.createdAt;
    const span = Math.max(0, relativeClock.now - since);
    return t("project.threadWaiting", { span: formatSpan(span) });
  }

  function delegationLine(item: Extract<InboxItem, { kind: "delegation" }>) {
    const since = item.thread.settledAt ?? item.thread.createdAt;
    const span = Math.max(0, relativeClock.now - since);
    return t("project.threadFinished", { ago: formatAgo(span) });
  }

  function openItem(item: InboxItem) {
    if (item.kind === "delegation" || item.kind === "waiting") {
      openHomeThread(item.thread.id);
      return;
    }
    const line = approvalLine(item);
    if (line.threadId) openHomeThread(line.threadId);
  }
</script>

<DashboardCard title={t("home.inbox")} badge={home.inbox.length || null} flush>
  {#snippet icon()}<InboxIcon class="size-3.5" />{/snippet}
  {#if home.inbox.length === 0}
    <p class="px-3.5 pb-3 text-sm text-muted-foreground">{t("home.empty")}</p>
  {:else}
    <ul class="flex max-h-64 flex-col overflow-y-auto px-2 pb-2">
      {#each home.inbox as item (item.id)}
        <li>
          <button
            type="button"
            class="flex w-full flex-col items-start gap-0.5 rounded-sm px-1.5 py-1.5 text-left transition hover:bg-accent"
            onclick={() => openItem(item)}
          >
            {#if item.kind === "approval"}
              {@const line = approvalLine(item)}
              <span class="block w-full truncate text-base text-foreground/85">{line.title}</span>
              <span class="block w-full truncate text-xs text-muted-foreground/80">{line.detail}</span>
            {:else if item.kind === "waiting"}
              <span class="block w-full truncate text-base text-foreground/85">
                {item.thread.title ?? item.thread.label}
              </span>
              <span class="flex w-full items-center justify-between gap-2">
                <span class="truncate text-xs text-muted-foreground/80">{waitingLine(item)}</span>
                <span class="shrink-0 text-2xs text-muted-foreground/70">
                  {projectName(item.thread.projectId)}
                </span>
              </span>
            {:else}
              <span class="block w-full truncate text-base text-foreground/85">
                {item.thread.title ?? item.thread.label}
              </span>
              <span class="flex w-full items-center justify-between gap-2">
                <span class="truncate text-xs text-muted-foreground/80">{delegationLine(item)}</span>
                <span class="shrink-0 text-2xs text-muted-foreground/70">
                  {projectName(item.thread.projectId)}
                </span>
              </span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</DashboardCard>
