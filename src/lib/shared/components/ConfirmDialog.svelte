<script lang="ts">
  import { fade, scale } from "svelte/transition";

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
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  let dialogEl: HTMLDivElement | null = $state(null);
  let confirmBtn: HTMLButtonElement | null = $state(null);

  $effect(() => {
    if (!open || !confirmBtn) return;
    // Captured before we steal focus and restored on close: otherwise
    // confirming leaves the keyboard on a removed button, which lands on
    // <body>, and the terminal you were typing in silently stops receiving
    // keys until you click it again.
    const previous = document.activeElement as HTMLElement | null;
    confirmBtn.focus();
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
    if (e.key === "Enter") {
      // Only when focus is inside the dialog: a held Enter in the terminal
      // at open time must not instantly confirm a destructive action.
      if (!dialogEl?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      onConfirm();
      return;
    }
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
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
    tabindex="-1"
    onclick={backdropClick}
    transition:fade={{ duration: 120 }}
  >
    <div
      bind:this={dialogEl}
      class="w-[360px] overflow-hidden rounded-xl border border-border bg-[var(--color-surface)] shadow-2xl"
      transition:scale={{ duration: 140, start: 0.97 }}
    >
      <div class="px-5 py-4">
        <h2 id="confirm-title" class="text-sm font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {#if message}
          <p class="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
            {message}
          </p>
        {/if}
      </div>
      <footer class="flex justify-end gap-2 border-t border-border bg-[var(--color-titlebar)] px-5 py-3">
        <button
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
