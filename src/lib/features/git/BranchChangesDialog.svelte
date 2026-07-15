<script lang="ts">
  import { tick } from "svelte";
  import { fade, scale } from "svelte/transition";
  import Archive from "@lucide/svelte/icons/archive";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import { i18n } from "$lib/i18n/index.svelte";

  type Props = {
    branch: string;
    creating: boolean;
    busy: boolean;
    onCarry: () => void;
    onStash: () => void;
    onCancel: () => void;
  };

  let {
    branch,
    creating,
    busy,
    onCarry,
    onStash,
    onCancel,
  }: Props = $props();

  let dialogEl: HTMLDivElement | null = $state(null);
  let carryButton: HTMLButtonElement | null = $state(null);

  $effect(() => {
    void tick().then(() => carryButton?.focus());
  });

  function backdropClick(event: MouseEvent) {
    if (!busy && event.target === event.currentTarget) onCancel();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = dialogEl?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    if (!buttons?.length) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (!dialogEl?.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4 backdrop-blur-sm"
  role="dialog"
  aria-modal="true"
  aria-labelledby="branch-changes-title"
  tabindex="-1"
  onclick={backdropClick}
  transition:fade={{ duration: 120 }}
>
  <div
    bind:this={dialogEl}
    class="w-full max-w-[420px] overflow-hidden rounded-lg border border-border bg-[var(--color-surface)] shadow-2xl"
    transition:scale={{ duration: 140, start: 0.97 }}
  >
    <div class="px-5 py-4">
      <h2 id="branch-changes-title" class="text-sm font-semibold text-foreground">
        {i18n.t("branch_dialog.uncommitted_changes")}
      </h2>
      <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {creating ? i18n.t("branch_dialog.description_part1_creating") : i18n.t("branch_dialog.description_part1_switching")}
        <span class="font-mono text-foreground/90">{branch}</span>
        {i18n.t("branch_dialog.description_part2")}
      </p>

      <div class="mt-4 grid gap-2">
        <button
          bind:this={carryButton}
          type="button"
          class="flex min-h-14 items-center gap-3 rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-2 text-left transition hover:bg-[var(--color-surface-3)] disabled:opacity-50"
          onclick={onCarry}
          disabled={busy}
        >
          <ArrowRight class="size-4 shrink-0 text-foreground/80" />
          <span class="min-w-0">
            <span class="block text-xs font-medium text-foreground">{i18n.t("branch_dialog.bring_changes")}</span>
            <span class="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
              {i18n.t("branch_dialog.bring_changes_desc", { branch })}
            </span>
          </span>
        </button>
        <button
          type="button"
          class="flex min-h-14 items-center gap-3 rounded-md border border-border px-3 py-2 text-left transition hover:bg-[var(--color-surface-2)] disabled:opacity-50"
          onclick={onStash}
          disabled={busy}
        >
          <Archive class="size-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0">
            <span class="block text-xs font-medium text-foreground">{i18n.t("branch_dialog.leave_changes")}</span>
            <span class="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
              {@html i18n.t("branch_dialog.leave_changes_desc", { command: '<span class="font-mono">git stash pop</span>' })}
            </span>
          </span>
        </button>
      </div>
    </div>
    <footer class="flex justify-end border-t border-border bg-[var(--color-titlebar)] px-5 py-3">
      <button
        type="button"
        class="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
        onclick={onCancel}
        disabled={busy}
      >
        {i18n.t("branch_dialog.cancel")}
      </button>
    </footer>
  </div>
</div>
