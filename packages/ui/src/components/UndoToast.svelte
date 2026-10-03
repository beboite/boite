<script lang="ts">
  import { X } from '@lucide/svelte';
  import { Closing } from '../lib/closing.svelte';
  import { strings } from '../lib/strings';
  import { typing, undo } from '../lib/undo.svelte';

  /** The toast that carries the last archive's way back, top centre. `onerror` hears a restore that failed. */
  let { onerror }: { onerror: (error: unknown) => void } = $props();

  const toast = new Closing();
  let text = $state('');

  $effect(() => {
    const offer = undo.current;
    if (!offer) {
      toast.hide();
      return;
    }
    text = offer.message;
    toast.show();
  });

  function onkeydown(event: KeyboardEvent): void {
    if (!undo.current || event.defaultPrevented) return;
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return;
    if (typing(event.target)) return;
    event.preventDefault();
    void undo.take(onerror);
  }
</script>

<svelte:window {onkeydown} />

{#if toast.shown}
  <div class="undo-toast" class:closing={toast.closing} role="status" use:toast.attach onanimationend={toast.end} data-testid="undo-toast">
    <span class="text ui-label">{text}</span>
    <button type="button" class="small undo" data-testid="undo-action" title={strings.sidebar.undoHint} onclick={() => void undo.take(onerror)}><span class="ui-label">{strings.sidebar.undo}</span></button>
    <button type="button" class="ghost small icon" aria-label={strings.common.dismiss} title={strings.common.dismiss} onclick={() => undo.dismiss()}><X size={14} /></button>
  </div>
{/if}

<style>
  /* Top centre, clear of the composer's controls and of the error toast on the right. */
  .undo-toast {
    position: absolute;
    left: 50%;
    top: calc(16px + env(safe-area-inset-top, 0px));
    z-index: 80;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: calc(100vw - 32px);
    padding: 6px 6px 6px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--color-surface-2) 96%, transparent);
    backdrop-filter: blur(10px);
    box-shadow: var(--shadow-e3);
    font-size: var(--text-sm);
    /* `translate`, not `transform`: the rise animates the transform. */
    translate: -50% 0;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  :global(.shell) .undo-toast { top: calc(var(--titlebar) + 16px); }

  .undo-toast.closing {
    animation: fade-out var(--dur-2) var(--ease-out-quint);
    pointer-events: none;
  }

  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .undo {
    flex: none;
    color: var(--color-accent);
    font-weight: 600;
  }
</style>
