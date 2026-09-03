<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { visibleStatus } from "$lib/domain/thread-status";
  import { isSettled } from "$lib/domain/thread-settle";
  import { isDelegated } from "$lib/domain/delegation";
  import { closeThreadWithConfirm } from "$lib/features/thread/api";
  import { t } from "$lib/i18n/index.svelte";
  import type { Thread, ThreadStatus } from "$lib/types";
  import StatusDot from "$lib/shared/components/StatusDot.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import MobileSheet from "./MobileSheet.svelte";
  import X from "@lucide/svelte/icons/x";
  import Unlink2 from "@lucide/svelte/icons/unlink-2";

  type Props = { open: boolean; onClose: () => void };
  let { open, onClose }: Props = $props();

  const projectId = $derived(app.currentProjectId);
  // Minus what the project put away: this is the switcher, and a thread that
  // was put away is not one to switch to.
  const threads = $derived(
    projectId
      ? app.threadsByProjectSorted(projectId).filter((x) => !isSettled(x))
      : [],
  );

  // Same surfacing rule as the sidebar: a live PTY that reads idle/stopped is
  // really ready, and dedup-orphaned threads flag an error.
  function displayStatus(thread: Thread): ThreadStatus {
    if (app.unboundByDedup.includes(thread.id)) return "error";
    return visibleStatus(thread.status, !!thread.ptyId);
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

<MobileSheet {open} {onClose} title={t("mobile.terminals")}>
  {#if threads.length === 0}
    <div class="px-2 py-6 text-center text-sm text-muted-foreground">
      {t("mobile.noTerminals")}
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
            class="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
            onclick={() => open_(thread.id)}
          >
            <StatusDot
              status={displayStatus(thread)}
              asleep={thread.autoSlept ?? false}
              keepAwake={(thread.keepAwake ?? false) && !!thread.ptyId}
            />
            <ShortcutIcon iconKey={thread.iconKey} size={16} color={threadIconColor(thread)} />
            <span class="min-w-0 flex-1 truncate text-sm text-foreground">
              {thread.title ?? thread.label}
            </span>
          </button>
          <!-- 44px, and held clear of the full-width open target it used to sit
               flush against: this button kills a running process, so a mistap
               on the row must not reach it. -->
          {#if isDelegated(thread)}
            <button
              type="button"
              class="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-2 transition hover:bg-accent hover:text-foreground active:bg-accent/70"
              onclick={() => app.detachDelegation(thread.id)}
              aria-label={t("sidebar.detachDelegation")}
            >
              <Unlink2 class="size-4" />
            </button>
          {/if}
          <button
            type="button"
            class="ml-2 flex size-11 shrink-0 items-center justify-center rounded-lg border-l border-border/60 text-muted-2 transition hover:bg-danger/20 hover:text-danger active:bg-danger/30"
            onclick={() => close_(thread.id)}
            aria-label={t("mobile.closeTerminal", { name: thread.label })}
          >
            <X class="size-4" />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</MobileSheet>
