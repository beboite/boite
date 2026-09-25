<script lang="ts">
  import { tick } from 'svelte';
  import { Closing } from '../lib/closing.svelte';
  import { mobileOverlay } from '../lib/mobile-history';
  import { confirm, type ConfirmRequest } from '../lib/confirm.svelte';

  const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

  const overlay = new Closing();
  /** The request is nulled the moment it is answered, so the exit plays on a copy. */
  let held = $state<ConfirmRequest | null>(null);
  let card = $state<HTMLDivElement | undefined>(undefined);

  /** A dangerous action opens with the keyboard on Cancel, a plain one on Confirm. */
  $effect(() => {
    const current = confirm.current;
    if (!current) {
      overlay.hide();
      return;
    }
    held = current;
    overlay.show();
    void tick().then(() => {
      const target = card?.querySelector<HTMLButtonElement>(current.danger ? '[data-cancel]' : '[data-confirm]');
      target?.focus({ preventScroll: true });
    });
  });

  $effect(() => { if (overlay.open) return mobileOverlay(() => confirm.answer(false)); });

  function onkeydown(event: KeyboardEvent) {
    if (!confirm.current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      confirm.answer(false);
      return;
    }
    if (event.key === 'Tab') trap(event);
  }

  /** While the dialog is up the keyboard cannot leave it. */
  function trap(event: KeyboardEvent) {
    const el = card;
    if (!el) return;
    const stops = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const inside = active instanceof Node && el.contains(active);
    if (event.shiftKey ? inside && active !== first : inside && active !== last) return;
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

{#if overlay.shown && held}
  {@const request = held}
  <div
    class="scrim"
    class:closing={overlay.closing}
    role="presentation"
    use:overlay.attach
    onanimationend={overlay.end}
    onclick={(event) => {
      if (event.target === event.currentTarget) confirm.answer(false);
    }}
  >
    <div
      class="dialog"
      class:closing={overlay.closing}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      tabindex="-1"
      bind:this={card}
      data-testid="confirm-dialog"
    >
      <h2 id="confirm-title">{request.title}</h2>
      {#if request.body}
        <p class="muted">{request.body}</p>
      {/if}
      <div class="actions">
        <button type="button" class="ghost" data-cancel data-testid="confirm-cancel" onclick={() => confirm.answer(false)}>
          {request.cancelLabel}
        </button>
        <button
          type="button"
          class:primary={!request.danger}
          class:destructive={request.danger}
          data-confirm
          data-testid="confirm-ok"
          onclick={() => confirm.answer(true)}
        >
          {request.confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-scrim);
    backdrop-filter: blur(4px);
    animation: fade var(--dur-2) var(--ease-out-quint);
  }

  .scrim.closing {
    animation-name: fade-out;
    pointer-events: none;
  }

  .dialog {
    width: min(380px, calc(100vw - 32px));
    padding: 18px 18px 14px;
    background: var(--color-surface);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-e3);
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  .dialog.closing {
    animation-name: pop-out;
  }

  h2 {
    font-size: var(--text-md);
    margin-bottom: 6px;
  }

  p {
    margin-bottom: 4px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 14px;
  }

  .destructive {
    background: var(--color-danger);
    border-color: var(--color-danger);
    color: var(--color-on-danger);
  }

  .destructive:hover:not(:disabled) {
    background: var(--color-danger-hover);
  }
</style>
