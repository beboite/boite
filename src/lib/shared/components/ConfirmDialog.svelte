<script lang="ts">
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
    open = $bindable(),
    title,
    message = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onCancel();
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === "Escape") onCancel();
    else if (e.key === "Enter") onConfirm();
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
    tabindex="-1"
    onclick={backdropClick}
    onkeydown={keydown}
  >
    <div
      class="w-[360px] overflow-hidden rounded-xl border border-border bg-[var(--color-surface)] shadow-2xl"
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
