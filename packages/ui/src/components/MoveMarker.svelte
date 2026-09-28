<script lang="ts">
  import { ChevronRight, FolderInput } from '@lucide/svelte';
  import type { MoveNotice } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';

  /**
   * A thread's move in its timeline. A move the user made rides on the next
   * prompt, whose note told the agent; the marker opens on that note. A move
   * the agent made itself is one line: it knew already, nothing was said to it.
   */
  let { notice }: { notice: MoveNotice } = $props();
  let open = $state(false);
  let byAgent = $derived(notice.by === 'agent');
</script>

<div class="move" data-testid="move-marker" data-by={notice.by ?? 'user'} title={`${notice.from.cwd} > ${notice.to.cwd}`}>
  <span class="rule"></span>
  {#if byAgent}
    <span class="label"><FolderInput size={13} />{fill(strings.chat.movedByAgent, { project: notice.to.name })}</span>
  {:else}
    <button
      type="button"
      class="ghost small label"
      data-testid="move-marker-toggle"
      aria-expanded={open}
      title={open ? strings.chat.moveHide : strings.chat.moveShow}
      onclick={() => (open = !open)}
    ><FolderInput size={13} />{strings.chat.moveExplained}<span class="caret" class:open><ChevronRight size={12} /></span></button>
  {/if}
  <span class="rule"></span>
</div>
{#if open && !byAgent}
  <p class="note" data-testid="move-note">{notice.note.trim()}</p>
{/if}

<style>
  .move {
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 6px 0;
    font-size: var(--text-xs);
    color: var(--color-accent);
  }
  .rule {
    flex: 1;
    height: 1px;
    background: color-mix(in oklch, var(--color-accent) 45%, transparent);
  }
  .label {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-accent);
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .caret {
    display: inline-flex;
    transition: transform var(--dur-2) var(--ease-out-quint);
  }
  .caret.open {
    transform: rotate(90deg);
  }
  .note {
    align-self: stretch;
    margin: 0 0 8px;
    padding: 8px 12px;
    border-left: 2px solid var(--color-accent);
    border-radius: var(--radius-sm);
    background: var(--color-accent-soft);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
