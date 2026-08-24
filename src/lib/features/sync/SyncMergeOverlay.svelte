<script lang="ts">
  /**
   * The files two machines disagree about, and the way through them.
   *
   * A full-screen modal rather than a settings page or a pane. It opens at
   * launch, before anybody has been to the settings; a pane belongs to a thread
   * in a project and this belongs to neither, and every pane group is mounted at
   * once behind `visibility: hidden`, so a merge tool drawn as one could be
   * switched away from and lost.
   *
   * A list with a status each, not a queue. Six files with no way back is worse
   * than the disagreement. Applying is per file and durable at once, which is
   * what makes walking away safe: at every instant a file has either been
   * written with exactly what was on screen, or not touched at all.
   */
  import { tick } from "svelte";
  import { fade, scale } from "svelte/transition";
  import Check from "@lucide/svelte/icons/check";
  import Minus from "@lucide/svelte/icons/minus";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import X from "@lucide/svelte/icons/x";

  import { t } from "$lib/i18n/index.svelte";
  import { syncStore } from "./store.svelte";
  import SyncMergeFile from "./SyncMergeFile.svelte";
  import type { Choice } from "./hunks";

  let dialogEl: HTMLDivElement | null = $state(null);
  let confirmingClose = $state(false);
  /** Per file, so navigating away and coming back loses nothing. */
  let drafts = $state<Record<string, Choice[]>>({});

  const conflicts = $derived(syncStore.conflicts);
  const active = $derived(
    conflicts.find((item) => item.path === syncStore.activePath) ?? conflicts[0] ?? null,
  );
  const decided = $derived(conflicts.filter((item) => syncStore.verdicts[item.path]).length);

  $effect(() => {
    const previous = document.activeElement as HTMLElement | null;
    void tick().then(() => dialogEl?.focus());
    return () => previous?.focus?.();
  });

  function shortPath(path: string): string {
    const cut = path.indexOf("/");
    return cut === -1 ? path : path.slice(cut + 1);
  }

  function close() {
    if (syncStore.pending > 0 && !confirmingClose) {
      confirmingClose = true;
      return;
    }
    confirmingClose = false;
    syncStore.closeMerge();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--color-scrim)] p-4 backdrop-blur-sm"
  role="dialog"
  aria-modal="true"
  aria-labelledby="sync-merge-title"
  tabindex="-1"
  bind:this={dialogEl}
  transition:fade={{ duration: 120 }}
>
  <div
    class="surface-dialog flex h-full max-h-[92vh] w-full max-w-[1100px] flex-col overflow-hidden"
    transition:scale={{ duration: 140, start: 0.97 }}
  >
    <header class="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
      <div class="min-w-0">
        <h2 id="sync-merge-title" class="text-sm font-medium text-foreground">
          {t("syncMerge.title")}
        </h2>
        <p class="text-xs text-muted-foreground">
          {t("syncMerge.progress", { done: decided, total: conflicts.length })}
        </p>
      </div>
      <button
        type="button"
        class="rounded-md p-1.5 text-muted-foreground transition hover:bg-[var(--color-surface-3)] hover:text-foreground"
        aria-label={t("common.close")}
        onclick={close}
      >
        <X size={16} />
      </button>
    </header>

    {#if confirmingClose}
      <div class="shrink-0 border-b border-border bg-[var(--color-surface-2)] px-3 py-2">
        <p class="text-xs text-foreground">
          {t("syncMerge.abandonAsk", { count: syncStore.pending })}
        </p>
        <div class="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            class="rounded-md bg-foreground px-2 py-0.5 text-xs text-[var(--color-surface)]"
            onclick={() => {
              confirmingClose = false;
              syncStore.closeMerge();
            }}
          >
            {t("syncMerge.abandonConfirm")}
          </button>
          <button
            type="button"
            class="rounded-md border border-border px-2 py-0.5 text-xs text-foreground"
            onclick={() => (confirmingClose = false)}
          >
            {t("syncMerge.abandonCancel")}
          </button>
        </div>
      </div>
    {/if}

    <div class="flex min-h-0 flex-1">
      <nav
        class="w-56 shrink-0 overflow-y-auto border-r border-border"
        aria-label={t("syncMerge.files")}
      >
        {#each conflicts as item (item.path)}
          {@const verdict = syncStore.verdicts[item.path]}
          <button
            type="button"
            aria-current={active?.path === item.path}
            class="flex w-full items-start gap-2 border-b border-border/60 px-2.5 py-2 text-left transition hover:bg-[var(--color-surface-3)]"
            class:bg-[var(--color-surface-2)]={active?.path === item.path}
            onclick={() => syncStore.openMerge(item.path)}
          >
            <span class="mt-0.5 shrink-0">
              {#if verdict === "resolved"}
                <Check size={12} />
              {:else if verdict === "skipped"}
                <Minus size={12} />
              {:else if verdict === "failed"}
                <TriangleAlert size={12} />
              {:else}
                <span class="block size-1.5 rounded-full bg-foreground/50"></span>
              {/if}
            </span>
            <span class="min-w-0">
              <span class="block truncate font-mono text-xs text-foreground">
                {shortPath(item.path)}
              </span>
              <span class="block text-xs text-muted-foreground">
                {verdict === "resolved"
                  ? t("syncMerge.statusResolved")
                  : verdict === "skipped"
                    ? t("syncMerge.statusSkipped")
                    : verdict === "failed"
                      ? t("syncMerge.statusFailed")
                      : t("syncMerge.statusWaiting")}
              </span>
            </span>
          </button>
        {/each}
      </nav>

      <div class="min-w-0 flex-1 overflow-hidden p-3">
        {#if !active}
          <p class="text-xs text-muted-foreground">{t("syncMerge.nothingWaiting")}</p>
        {:else if active.binary}
          <!-- Stacking bytes means nothing, so a side is offered instead of a
               merge, rather than showing mojibake and pretending. -->
          <div class="rounded-lg border border-border p-3">
            <p class="text-xs text-foreground">{t("syncMerge.binary")}</p>
            <div class="mt-2 flex items-center gap-2">
              <button
                type="button"
                class="rounded-md border border-border px-2 py-0.5 text-xs text-foreground"
                onclick={() => void syncStore.resolve(active.path, active.local ?? "")}
              >
                {t("syncMerge.keepMine")}
              </button>
              <button
                type="button"
                class="rounded-md border border-border px-2 py-0.5 text-xs text-foreground"
                onclick={() => void syncStore.resolve(active.path, active.remote ?? "")}
              >
                {t("syncMerge.takeTheirs")}
              </button>
              <button
                type="button"
                class="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
                onclick={() => void syncStore.skip(active.path)}
              >
                {t("syncMerge.skip")}
              </button>
            </div>
          </div>
        {:else}
          {#key active.path}
            <SyncMergeFile
              conflict={active}
              choices={drafts[active.path] ?? null}
              onChoices={(next) => (drafts = { ...drafts, [active.path]: next })}
              onApply={(content) => void syncStore.resolve(active.path, content)}
              onSkip={() => void syncStore.skip(active.path)}
            />
          {/key}
        {/if}
      </div>
    </div>

    <footer class="shrink-0 border-t border-border px-3 py-2">
      {#if syncStore.error}
        <p class="mb-1.5 text-xs text-[var(--color-danger)]">{syncStore.error}</p>
      {/if}
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs text-muted-foreground">{t("syncMerge.sendNote")}</p>
        <button
          type="button"
          class="rounded-md bg-foreground px-2.5 py-1 text-xs text-[var(--color-surface)] transition disabled:opacity-50"
          disabled={syncStore.pending > 0 || decided === 0}
          onclick={() => {
            void syncStore.push();
            syncStore.closeMerge();
          }}
        >
          {t("syncMerge.send")}
        </button>
      </div>
    </footer>
  </div>
</div>
