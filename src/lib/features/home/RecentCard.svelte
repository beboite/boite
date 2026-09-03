<!--
  The ten threads that moved last, across every project.

  Ordering is `threadRecency`: the status engine's stamp when this session has
  one, the settled stamp for a thread put away, the creation date otherwise. A
  click selects the thread, which is what `openHomeThread` already does for the
  live agents card above it.
-->
<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import { threadActivitySince } from "$lib/features/thread/activity.svelte";
  import { home, openHomeThread, threadRecency } from "./store.svelte";
  import DashboardCard from "$lib/features/project/DashboardCard.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { formatAgo } from "$lib/shared/utils/relative-time";
  import { t } from "$lib/i18n/index.svelte";
  import type { Thread } from "$lib/types";
  import History from "@lucide/svelte/icons/history";

  function ago(thread: Thread): string {
    const at = threadRecency(thread, threadActivitySince);
    return formatAgo(Math.max(0, relativeClock.now - at));
  }
</script>

<DashboardCard title={t("home.recent")} badge={home.recent.length || null} flush>
  {#snippet icon()}<History class="size-3.5" />{/snippet}
  {#if home.recent.length === 0}
    <p class="px-3.5 pb-3 text-sm text-muted-foreground">{t("home.recentEmpty")}</p>
  {:else}
    <ul class="flex flex-col px-2 pb-2">
      {#each home.recent as thread (thread.id)}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 text-left transition hover:bg-accent focus-visible:bg-accent focus-visible:focus-ring-inset"
            onclick={() => openHomeThread(thread.id)}
          >
            <ShortcutIcon
              iconKey={thread.iconKey}
              size={14}
              color={threadIconColor(thread)}
            />
            <span class="min-w-0 flex-1 truncate text-sm text-foreground">
              {thread.title ?? thread.label}
            </span>
            <span class="shrink-0 truncate text-2xs text-muted-2">
              {app.projectById(thread.projectId)?.name ?? ""}
            </span>
            <span class="w-12 shrink-0 text-right text-2xs tabular-nums text-muted-2">
              {ago(thread)}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</DashboardCard>
