<script lang="ts">
  import { FolderInput, MoveRight } from '@lucide/svelte';
  import { threadDrag } from '../lib/thread-move.svelte';
  import { strings } from '../lib/strings';
  import ProviderLogo from './ProviderLogo.svelte';
  /*
   * The card a dragged thread row becomes: it follows the mouse from where the
   * row was taken, lifts a little, and says under it which project the drop
   * goes to, or that it needs one. It takes no pointer, so the section under
   * the mouse is still the one found.
   */
  let ghost = $derived(threadDrag.current ? threadDrag.ghost : null);
  let target = $derived(threadDrag.target);
</script>

{#if ghost}
  <div
    class="drag-ghost"
    data-testid="thread-drag-ghost"
    aria-hidden="true"
    style:width="{Math.min(ghost.width, 360)}px"
    style:transform="translate3d({threadDrag.x - Math.min(ghost.dx, 340)}px, {threadDrag.y - ghost.dy}px, 0)"
  >
    <div class="card" class:armed={target !== null}>
      <span class="logo"><ProviderLogo providerId={ghost.providerId} size={12} /></span>
      <span class="title ui-label">{ghost.title}</span>
    </div>
    <div class="hint" class:armed={target !== null} data-testid="thread-drag-hint">
      {#if target !== null}
        <MoveRight size={12} /><FolderInput size={12} /><span class="ui-label">{target}</span>
      {:else}
        <span class="ui-label">{strings.threadMove.dragHint}</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .drag-ghost {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 10001;
    pointer-events: none;
    will-change: transform;
  }
  .card {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--row);
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e3);
    transform: rotate(-1.5deg) scale(1.03);
    transform-origin: 20% 50%;
    animation: lift var(--dur-2) var(--ease-out-quint);
    transition:
      border-color var(--dur-2) var(--ease-out-quint),
      box-shadow var(--dur-2) var(--ease-out-quint),
      transform var(--dur-2) var(--ease-out-quint);
  }
  /* Over a project that takes it, the card straightens and wears the accent, ready to land. */
  .card.armed {
    border-color: var(--color-accent);
    box-shadow: var(--shadow-e3), 0 0 0 3px color-mix(in srgb, var(--color-accent) 22%, transparent);
    transform: rotate(0deg) scale(1.01);
  }
  .logo {
    display: inline-flex;
    flex: none;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-foreground);
  }
  .hint {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    margin: 8px 0 0 10px;
    padding: 3px 9px;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
    background: var(--color-surface-3);
    box-shadow: var(--shadow-e1);
    animation: lift var(--dur-3) var(--ease-out-quint);
    transition: background var(--dur-2) var(--ease-out-quint), color var(--dur-2) var(--ease-out-quint);
  }
  .hint.armed {
    color: var(--color-accent-ink);
    background: var(--color-accent);
  }
  .hint :global(svg) {
    flex: none;
  }
  .hint span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @keyframes lift {
    from {
      opacity: 0;
      transform: none;
    }
  }
</style>
