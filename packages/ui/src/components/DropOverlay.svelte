<script lang="ts">
  import { FolderPlus, Paperclip } from '@lucide/svelte';
  import type { DropKind } from '../lib/native-drop';
  import { strings } from '../lib/strings';

  let { kind }: { kind: DropKind } = $props();
</script>

<div class="drop" data-testid="drop-overlay" data-kind={kind}>
  <div class="target">
    {#if kind === 'attach'}
      <Paperclip size={28} strokeWidth={1.5} />
      <h2>{strings.drop.attachTitle}</h2>
      <p class="muted">{strings.drop.attachBody}</p>
    {:else}
      <FolderPlus size={28} strokeWidth={1.5} />
      <h2>{strings.drop.title}</h2>
      <p class="muted">{strings.drop.body}</p>
    {/if}
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
