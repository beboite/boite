<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { closeThreadWithConfirm } from "$lib/features/thread/api";
  import type { Thread, ThreadStatus } from "$lib/types";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import MobileSheet from "./MobileSheet.svelte";
  import X from "@lucide/svelte/icons/x";

  type Props = { open: boolean; onClose: () => void };
  let { open, onClose }: Props = $props();

  const projectId = $derived(app.currentProjectId);
  const threads = $derived(
    projectId ? app.threadsByProjectSorted(projectId) : [],
  );

  // Same surfacing rule as the sidebar: a live PTY that reads idle/stopped is
  // really ready, and dedup-orphaned threads flag an error.
  function displayStatus(thread: Thread): ThreadStatus {
    if (app.unboundByDedup.includes(thread.id)) return "error";
    if (thread.ptyId && (thread.status === "idle" || thread.status === "stopped")) {
      return "ready";
    }
    return thread.status;
  }

  function open_(id: string) {
    onClose();
    app.activeThreadId = id;
    app.mobileTab = "terminal";
  }

  async function close_(id: string) {
    await closeThreadWithConfirm(id);
  }
</script>

<MobileSheet {open} {onClose} title="Terminals">
  {#if threads.length === 0}
    <div class="px-2 py-6 text-center text-sm text-muted-foreground">
      No terminals in this project yet.
    </div>
  {:else}
    <div class="flex flex-col gap-1">
      {#each threads as thread (thread.id)}
        {@const isActive = app.activeThreadId === thread.id}
        <div
          class="flex items-center gap-3 rounded-xl border px-3 py-3 transition {isActive
            ? 'border-border bg-[var(--color-surface-2)]'
            : 'border-transparent'}"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-3 text-left"
            onclick={() => open_(thread.id)}
          >
            <StatusDot
              status={displayStatus(thread)}
              asleep={thread.autoSlept ?? false}
              keepAwake={(thread.keepAwake ?? false) && !!thread.ptyId}
            />
            <ShortcutIcon iconKey={thread.iconKey} size={16} color={threadIconColor(thread)} />
            <span class="min-w-0 flex-1 truncate text-sm text-foreground/90">
              {thread.title ?? thread.label}
            </span>
          </button>
          <button
            type="button"
            class="shrink-0 rounded-lg p-2 text-muted-foreground/70 transition hover:bg-danger/20 hover:text-danger active:bg-danger/30"
            onclick={() => close_(thread.id)}
            aria-label="Close {thread.label}"
          >
            <X class="size-4" />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</MobileSheet>
