<script lang="ts">
  import { tick } from 'svelte';
  import { confirm } from '../lib/confirm.svelte';

  let card = $state<HTMLDivElement | undefined>(undefined);

  /** A dangerous action opens with the keyboard on Cancel, a plain one on Confirm. */
  $effect(() => {
    const current = confirm.current;
    if (!current) return;
    void tick().then(() => {
      const target = card?.querySelector<HTMLButtonElement>(current.danger ? '[data-cancel]' : '[data-confirm]');
      target?.focus({ preventScroll: true });
    });
  });

  function onkeydown(event: KeyboardEvent) {
    if (!confirm.current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      confirm.answer(false);
    }
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

{#if confirm.current}
  {@const request = confirm.current}
  <div
    class="scrim"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) confirm.answer(false);
    }}
  >
    <div
      class="dialog"
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

  .dialog {
    width: min(380px, calc(100vw - 32px));
    padding: 18px 18px 14px;
    background: var(--color-surface);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-e3);
    animation: pop var(--dur-2) var(--ease-out-quint);
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

  @keyframes fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
