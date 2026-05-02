<script lang="ts">
  import { onMount } from "svelte";
  import type { ToastKind, ToastAction } from "./store.svelte";

  type Props = {
    message: string;
    durationMs?: number | null;
    kind?: ToastKind;
    action?: ToastAction;
    onDone: () => void;
  };
  let {
    message,
    durationMs = 3000,
    kind = "info",
    action,
    onDone,
  }: Props = $props();

  onMount(() => {
    if (durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }
    const timer = setTimeout(() => onDone(), durationMs);
    return () => clearTimeout(timer);
  });

  function runAction() {
    action?.run();
    onDone();
  }
</script>

<div class="toast" class:success={kind === "success"} class:error={kind === "error"}>
  <div class="accent"></div>
  <div class="body">
    <svg
      class="icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {#if kind === "success"}
        <path d="M20 6L9 17l-5-5" />
      {:else if kind === "error"}
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      {:else}
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      {/if}
    </svg>
    <span class="text">{message}</span>
    {#if action}
      <button type="button" class="action" onclick={runAction}>{action.label}</button>
    {/if}
  </div>
</div>

<style>
  .toast {
    pointer-events: auto;
    display: flex;
    overflow: hidden;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
    --toast-accent: var(--color-muted-foreground);
  }
  .toast.success {
    --toast-accent: #22c55e;
  }
  .toast.error {
    --toast-accent: #ef4444;
  }
  .accent {
    width: 3px;
    flex-shrink: 0;
    background: var(--toast-accent);
  }
  .body {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    min-width: 0;
  }
  .icon {
    flex-shrink: 0;
    color: var(--toast-accent);
  }
  .text {
    font-size: 12px;
    color: var(--color-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .action {
    flex-shrink: 0;
    margin-left: 4px;
    padding: 2px 8px;
    border: none;
    border-radius: 3px;
    background: color-mix(in srgb, var(--toast-accent) 20%, transparent);
    color: var(--toast-accent);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: background 100ms;
  }
  .action:hover {
    background: color-mix(in srgb, var(--toast-accent) 32%, transparent);
  }
</style>
