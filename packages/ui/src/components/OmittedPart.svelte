<script lang="ts">
  import { ImageIcon } from '@lucide/svelte';
  import { fill, strings } from '../lib/strings';
  import { transferBytes } from '../lib/format';
  import { onView } from '../lib/on-view';

  /**
   * The place of a picture a light page left on the core. It asks for the
   * picture once it nears the viewport, so the text of the thread paints first
   * and a long history downloads only what the reader scrolls past.
   */
  let { bytes, load }: { bytes: number; load: () => void } = $props();
</script>

<div class="omitted" data-testid="omitted-image" use:onView={load}>
  <ImageIcon size={18} strokeWidth={1.5} />
  <span>{fill(strings.chat.partLoading, { size: transferBytes(bytes) })}</span>
</div>

<style>
  /* Roughly a thumbnail, so the picture landing moves little under the reader. */
  .omitted {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 180px;
    height: 120px;
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
  }
</style>
