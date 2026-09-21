<script lang="ts">
  import { FolderPlus } from '@lucide/svelte';
  import { strings } from '../lib/i18n.svelte';
</script>

<div class="drop" data-testid="drop-overlay">
  <div class="target">
    <FolderPlus size={28} strokeWidth={1.5} />
    <h2>{strings.drop.title}</h2>
    <p class="muted">{strings.drop.body}</p>
  </div>
</div>

<style>
  .drop {
    position: absolute;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--color-scrim);
    backdrop-filter: blur(4px);
    pointer-events: none;
    animation: fade var(--dur-2) var(--ease-out-quint);
  }

  .target {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: min(420px, 100%);
    padding: 36px 24px;
    border: 1.5px dashed var(--color-edge);
    border-radius: var(--radius-xl);
    background: var(--color-surface);
    text-align: center;
    color: var(--color-foreground);
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  h2 {
    font-size: var(--text-md);
    margin-top: 6px;
  }
</style>
