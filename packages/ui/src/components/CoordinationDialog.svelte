<script lang="ts">
  import { onMount } from 'svelte';
  import { X } from '@lucide/svelte';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import { mobileOverlay } from '../lib/mobile-history';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import CoordinationPanel from './CoordinationPanel.svelte';

  let { store, threadId, onclose }: { store: Store; threadId: string; onclose: () => void } = $props();
  let dialog: HTMLDialogElement;

  onMount(() => {
    const focused = focusedElement();
    const previous = focused?.closest('[role="menu"]')
      ? document.querySelector<HTMLElement>('[data-testid="thread-menu-trigger"]')
      : focused;
    dialog.showModal();
    const releaseHistory = mobileOverlay(onclose);
    return () => {
      releaseHistory();
      dialog.close();
      restoreFocus(previous);
    };
  });

  function keydown(event: KeyboardEvent) {
    // App shortcuts must not change the conversation behind the modal.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }

  function backdrop(event: MouseEvent) {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onclose();
  }
</script>

<!-- The native modal owns focus containment and makes the conversation inert. -->
<dialog bind:this={dialog} aria-labelledby="coordination-title" data-testid="coordination-dialog" onkeydown={keydown} onclick={backdrop} oncancel={(event) => { event.preventDefault(); onclose(); }}>
  <header>
    <h2 id="coordination-title">{strings.coordination.heading}</h2>
    <button type="button" class="ghost icon" aria-label={strings.imports.close} data-testid="coordination-close" onclick={onclose}><X size={16} /></button>
  </header>
  <div class="settings"><CoordinationPanel {store} {threadId} expanded /></div>
</dialog>

<style>
  dialog { width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); margin: auto; padding: 0; color: var(--color-foreground); background: var(--color-surface); border: 1px solid var(--color-edge); border-radius: var(--radius-xl); box-shadow: var(--shadow-e3); overflow: hidden; }
  dialog[open] { display: flex; flex-direction: column; }
  dialog::backdrop { background: var(--color-scrim); backdrop-filter: blur(4px); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--color-border); }
  h2 { font-size: var(--text-md); font-weight: 600; }
  header button { flex: none; }
  .settings { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  @media (max-width: 720px) {
    dialog { width: calc(100vw - 20px); max-height: calc(100dvh - 20px); }
    header { padding: 8px 10px; }
  }
</style>
