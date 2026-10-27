<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { X } from '@lucide/svelte';
  import { focusedElement, restoreFocus } from '../../lib/focus';
  import { mobileOverlay } from '../../lib/mobile-history';
  import { strings } from '../../lib/strings';
  let { title, onclose, children, testid, compact = false }: { title: string; onclose: () => void; children: Snippet; testid: string; compact?: boolean } = $props();
  const uid = $props.id();
  let dialog: HTMLDialogElement;
  onMount(() => {
    const previous = focusedElement();
    dialog.showModal();
    const release = mobileOverlay(onclose);
    return () => { release(); dialog.close(); restoreFocus(previous); };
  });
</script>

<dialog bind:this={dialog} class:compact aria-labelledby={uid} data-testid={testid}
  onkeydown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); onclose(); } }}
  oncancel={event => { event.preventDefault(); onclose(); }}
  onclick={event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onclose(); } }}>
  <header><h2 id={uid}>{title}</h2><button type="button" class="ghost icon" aria-label={strings.common.close} data-testid="shared-dialog-close" onclick={onclose}><X size={16} /></button></header>
  <div class="body">{@render children()}</div>
</dialog>

<style>
  dialog { width: min(680px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); margin: auto; padding: 0; color: var(--color-foreground); background: var(--color-surface); border: 1px solid var(--color-edge); border-radius: var(--radius-xl); box-shadow: var(--shadow-e3); overflow: hidden; }
  dialog[open] { display: flex; flex-direction: column; }
  dialog.compact { width: min(560px, calc(100vw - 32px)); }
  dialog::backdrop { background: var(--color-scrim); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--color-border); }
  h2 { flex: 1; min-width: 0; margin: 0; font-size: var(--text-md); font-weight: 600; }
  header button { flex: none; }
  .body { padding: 14px; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  @media (max-width: 720px) { dialog { width: calc(100vw - 20px); max-height: calc(100dvh - 20px); } header { padding: 8px 10px; } header button { min-height: var(--touch-target); min-width: var(--touch-target); } .body { padding: 12px; } }
</style>
