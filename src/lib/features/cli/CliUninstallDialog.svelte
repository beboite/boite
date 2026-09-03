<!--
  The question a removal has to ask: the binary goes either way, and what the CLI
  wrote is the part that cannot be brought back.

  Its own dialog rather than `confirmDialog.ask`, which takes a title, a message
  and two labels and nothing else. This one has to draw a switch and a list of
  paths with their sizes, because "delete ~/.claude" and "delete ~/.claude, 1.4
  GB across 320 conversations" are different questions to answer, and only the
  second one is the true one.
-->
<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { t } from "$lib/i18n/index.svelte";
  import type { CliDataPath, CliRow } from "$lib/backend";
  import { cliManager } from "./store.svelte";

  let {
    row,
    label,
    onClose,
    onConfirm,
  }: {
    row: CliRow;
    /** The CLI's own name, from the preset the row is drawn with. */
    label: string;
    onClose: () => void;
    /**
     * What removing actually means, which the row decides: an agent on a package
     * manager needs that manager run in a terminal, and only the data half is
     * Rust's. Nothing is removed before this is called.
     */
    onConfirm: (purgeData: boolean) => void;
  } = $props();

  // Kept on by default. The reverse would be a dialog where the fast answer is
  // the irreversible one.
  let keepData = $state(true);
  let paths = $state<CliDataPath[] | null>(null);
  let dialogEl: HTMLDivElement | null = $state(null);
  let cancelBtn: HTMLButtonElement | null = $state(null);

  $effect(() => {
    let alive = true;
    void cliManager
      .dataPaths(row.id)
      .then((answer) => {
        if (alive) paths = answer;
      })
      .catch(() => {
        if (alive) paths = [];
      });
    return () => {
      alive = false;
    };
  });

  $effect(() => {
    // Opens on Cancel: this dialog's confirm button can delete a year of
    // conversations, and a stray Enter is not consent.
    const previous = document.activeElement as HTMLElement | null;
    cancelBtn?.focus();
    return () => previous?.focus?.();
  });

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  function confirm(): void {
    onConfirm(!keepData);
    onClose();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = dialogEl?.querySelectorAll<HTMLElement>("button");
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (!dialogEl?.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--color-scrim)] backdrop-blur-sm"
  role="dialog"
  aria-modal="true"
  aria-labelledby="cli-uninstall-title"
  tabindex="-1"
  onclick={(e) => e.target === e.currentTarget && onClose()}
  transition:fade={{ duration: 120 }}
>
  <div
    bind:this={dialogEl}
    class="surface-dialog w-[420px] overflow-hidden"
    transition:scale={{ duration: 140, start: 0.97 }}
  >
    <div class="px-5 py-4">
      <h2 id="cli-uninstall-title" class="text-sm font-semibold tracking-tight text-foreground">
        {t("cli.uninstallTitle", { label })}
      </h2>
      <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {t("cli.uninstallQuestion")}
      </p>
      {#if !row.managed}
        <p class="mt-2 text-sm text-[var(--color-warning)]">{t("cli.notManaged")}</p>
      {/if}

      <button
        type="button"
        role="switch"
        aria-checked={keepData}
        class="mt-3 flex w-full items-start gap-3 rounded-md border border-edge bg-[var(--color-surface-2)] px-3 py-2 text-left transition hover:border-foreground/30"
        onclick={() => (keepData = !keepData)}
      >
        <span
          class="mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full transition"
          style:background-color={keepData ? "var(--color-success)" : "var(--color-border)"}
        >
          <span
            class="size-3 rounded-full bg-white transition-transform"
            style:transform={keepData ? "translateX(14px)" : "translateX(2px)"}
          ></span>
        </span>
        <span class="min-w-0">
          <span class="block text-sm font-medium text-foreground">{t("cli.keepData")}</span>
          <span class="mt-0.5 block text-sm text-muted-foreground">
            {keepData ? t("cli.keepDataDesc") : t("cli.wipeDesc")}
          </span>
        </span>
      </button>

      <div class="mt-3">
        {#if paths === null}
          <p class="text-sm text-muted-foreground">{t("cli.dataLoading")}</p>
        {:else if paths.length === 0}
          <p class="text-sm text-muted-foreground">{t("cli.dataNone")}</p>
        {:else}
          <ul class="max-h-32 overflow-y-auto rounded-md border border-border bg-[var(--color-titlebar)] p-2">
            {#each paths as entry (entry.path)}
              <li class="flex items-baseline justify-between gap-3 py-0.5 text-sm">
                <span
                  class="min-w-0 truncate font-mono {keepData
                    ? 'text-muted-foreground'
                    : 'text-[var(--color-danger)]'}"
                  title={entry.path}
                >
                  {entry.path}
                </span>
                <span class="shrink-0 tabular-nums text-xs text-muted-2">
                  {size(entry.bytes)}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>

    <footer
      class="flex justify-end gap-2 border-t border-border bg-[var(--color-titlebar)] px-5 py-3"
    >
      <button
        bind:this={cancelBtn}
        type="button"
        class="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={onClose}
      >
        {t("common.cancel")}
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition {keepData
          ? 'bg-foreground text-background hover:bg-foreground/90'
          : 'bg-danger text-white hover:bg-danger/90'}"
        onclick={confirm}
      >
        <Trash2 class="size-3" />
        {keepData ? t("cli.confirmKeep") : t("cli.confirmWipe")}
      </button>
    </footer>
  </div>
</div>
