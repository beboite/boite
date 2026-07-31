<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { t } from "$lib/i18n/index.svelte";

  type Props = {
    open: boolean;
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  };
  let {
    open,
    title,
    message = "",
    confirmLabel = t("common.confirm"),
    cancelLabel = t("common.cancel"),
    danger = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  let dialogEl: HTMLDivElement | null = $state(null);
  let confirmBtn: HTMLButtonElement | null = $state(null);
  let cancelBtn: HTMLButtonElement | null = $state(null);

  $effect(() => {
    if (!open) return;
    // A destructive dialog opens with the keyboard on Cancel. It used to open on
    // Confirm, which put "kill every running agent and discard every unsaved
    // buffer" one stray Enter away, and the guard meant to prevent that could
    // not work: it only fired when focus was outside the dialog, and focus had
    // just been moved inside it.
    const target = danger ? cancelBtn : confirmBtn;
    if (!target) return;
    // Captured before we steal focus and restored on close: otherwise
    // confirming leaves the keyboard on a removed button, which lands on
    // <body>, and the terminal you were typing in silently stops receiving
    // keys until you click it again.
    const previous = document.activeElement as HTMLElement | null;
    target.focus();
    return () => previous?.focus?.();
  });

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onCancel();
  }

  function handleWindowKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    // No window-level Enter handler. The dialog opens with one of its two
    // buttons focused and a focused button already activates on Enter, so the
    // handler that used to live here added nothing except a way for a keypress
    // aimed somewhere else to confirm.
    if (e.key === "Tab") {
      // Minimal focus trap: keep Tab cycling inside the dialog.
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
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--color-scrim)] backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
    tabindex="-1"
    onclick={backdropClick}
    transition:fade={{ duration: 120 }}
  >
    <div
      bind:this={dialogEl}
      class="surface-dialog w-[360px] overflow-hidden"
      transition:scale={{ duration: 140, start: 0.97 }}
    >
      <div class="px-5 py-4">
        <h2 id="confirm-title" class="text-sm font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {#if message}
          <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {message}
          </p>
        {/if}
      </div>
      <footer class="flex justify-end gap-2 border-t border-border bg-[var(--color-titlebar)] px-5 py-3">
        <button
          bind:this={cancelBtn}
          type="button"
          class="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
          onclick={onCancel}
        >
          {cancelLabel}
        </button>
        <button
          bind:this={confirmBtn}
          type="button"
          class="rounded-md px-3 py-1.5 text-xs font-medium transition {danger
            ? 'bg-danger text-white hover:bg-danger/90'
            : 'bg-foreground text-background hover:bg-foreground/90'}"
          onclick={onConfirm}
        >
          {confirmLabel}
        </button>
      </footer>
    </div>
  </div>
{/if}
