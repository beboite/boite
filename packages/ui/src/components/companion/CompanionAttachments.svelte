<!--
  The files dropped on the companion for its next request, as chips under the
  ask bar, each with a way to take it back; while files are dragged over, a
  row says where to let go; a cap a file would pass is said by name.
-->
<script lang="ts">
  import { FileText, Paperclip, X } from '@lucide/svelte';
  import type { Dropped } from '../../lib/companion/drop.svelte';
  import { fill, strings } from '../../lib/strings';

  interface Props {
    dropped: Dropped;
  }

  let { dropped }: Props = $props();

  const copy = strings.companion.drop;
</script>

{#if dropped.over}
  <p class="hint" data-testid="companion-drop-hint"><Paperclip size={13} aria-hidden="true" />{copy.hint}</p>
{/if}

{#if dropped.held.length > 0 || dropped.reading || dropped.problem}
  <div class="files" data-testid="companion-attachments">
    {#if dropped.held.length > 0}
      <ul aria-label={copy.label}>
        {#each dropped.held as file, index (index)}
          {@const name = file.name ?? strings.composer.attachUnnamed}
          <li class="chip">
            {#if file.kind === 'image'}
              <img src={`data:${file.mimeType};base64,${file.data}`} alt="" />
            {:else}
              <span class="glyph" aria-hidden="true"><FileText size={12} /></span>
            {/if}
            <span class="name" title={name}>{name}</span>
            <button type="button" class="ghost remove" aria-label={fill(copy.remove, { name })} title={fill(copy.remove, { name })} onclick={() => dropped.remove(index)}><X size={11} /></button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if dropped.reading}<p class="note" role="status">{copy.reading}</p>{/if}
    {#if dropped.problem}<p class="note problem" role="alert">{dropped.problem}</p>{/if}
  </div>
{/if}

<style>
  .hint {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 8px;
    padding: 10px;
    border: 1px dashed var(--color-accent);
    border-radius: var(--radius-md);
    background: var(--color-accent-soft);
    color: var(--color-accent);
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .files {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-bottom: 1px solid var(--color-border);
  }
  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 76px;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 180px;
    padding-inline: 6px 2px;
  }
  img {
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: var(--radius-sm);
    object-fit: cover;
  }
  .glyph {
    flex: none;
    display: grid;
    color: var(--color-muted-foreground);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remove {
    flex: none;
    width: 18px;
    height: 18px;
    padding: 0;
    border-radius: var(--radius-sm);
  }
  .note {
    margin: 0;
    font-size: var(--text-xs);
    line-height: 1.4;
    color: var(--color-muted-foreground);
  }
  .problem {
    color: var(--color-danger);
  }
</style>
