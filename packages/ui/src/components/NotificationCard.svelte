<script lang="ts">
  import { X } from '@lucide/svelte';
  import { strings } from '../lib/i18n.svelte';

  let { title, message, dismiss }: { title: string; message: string; dismiss: () => void } = $props();
</script>

<div class="notification-card">
  <span class="dot" aria-hidden="true"></span>
  <div class="lines">
    <span class="heading">{title}</span>
    <p>{message}</p>
  </div>
  <button type="button" class="ghost icon dismiss" onclick={dismiss} aria-label={strings.common.dismiss} title={strings.common.dismiss}>
    <X size={16} />
  </button>
</div>

<style>
  .notification-card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 12px;
    padding: 14px;
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--color-surface-2) 96%, transparent);
    background-image: linear-gradient(110deg, color-mix(in srgb, var(--color-danger) 10%, transparent), transparent 55%);
    backdrop-filter: blur(10px);
    box-shadow: var(--shadow-e3);
  }
  .dot {
    width: 6px;
    height: 6px;
    margin-top: 7px;
    border-radius: var(--radius-sm);
    background: var(--color-danger);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-danger) 12%, transparent);
  }
  .lines { min-width: 0; }
  .heading { font-size: var(--text-sm); font-weight: 600; }
  p {
    margin: 4px 0 0;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    line-height: 1.5;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    max-height: min(40vh, 320px);
    overflow-y: auto;
    user-select: text;
  }
  .dismiss { margin: -6px -6px 0 0; color: var(--color-muted-foreground); }
  .dismiss:hover { color: var(--color-foreground); }
</style>
