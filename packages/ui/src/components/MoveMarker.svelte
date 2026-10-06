<script lang="ts">
  import { ChevronRight, FolderInput } from '@lucide/svelte';
  import type { MoveNotice } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';

  /**
   * A thread's move in its timeline. A move the user made rides on the next
   * prompt, whose note told the agent; the marker opens on that note. Until
   * that prompt goes, `pending` draws it at the foot of the thread, saying the
   * agent will hear of it. A move the agent made itself is one line: it knew
   * already, nothing was said to it.
   */
  let { notice, pending = false }: { notice: MoveNotice; pending?: boolean } = $props();
  let open = $state(false);
  let byAgent = $derived(notice.by === 'agent');
  let label = $derived(pending ? fill(strings.chat.movePending, { project: notice.to.name }) : strings.chat.moveExplained);
  let show = $derived(pending ? strings.chat.movePendingShow : strings.chat.moveShow);
  let hide = $derived(pending ? strings.chat.movePendingHide : strings.chat.moveHide);
</script>

<div class="move" class:pending data-testid={pending ? 'move-pending' : 'move-marker'} data-by={notice.by ?? 'user'} title={`${notice.from.cwd} > ${notice.to.cwd}`}>
  <span class="rule"></span>
  {#if byAgent}
    <span class="label"><FolderInput size={13} /><span class="ui-label">{fill(strings.chat.movedByAgent, { project: notice.to.name })}</span></span>
  {:else}
    <button
      type="button"
      class="ghost small label"
      data-testid={pending ? 'move-pending-toggle' : 'move-marker-toggle'}
      aria-expanded={open}
      title={open ? hide : show}
      onclick={() => (open = !open)}
    ><FolderInput size={13} /><span class="ui-label">{label}</span><span class="fold-caret" class:open aria-hidden="true"><ChevronRight size={12} /></span></button>
  {/if}
  <span class="rule"></span>
</div>
{#if open && !byAgent}
  <p class="note" data-testid={pending ? 'move-pending-note' : 'move-note'}>{notice.note.trim()}</p>
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
  /* Not said yet: the rule is drawn, not ruled. */
  .pending .rule {
    height: 0;
    background: none;
    border-top: 1px dashed color-mix(in oklch, var(--color-accent) 45%, transparent);
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
  .pending .label {
    flex: 0 1 auto;
    min-width: 0;
    white-space: normal;
    text-align: center;
  }
  .note {
    align-self: stretch;
    white-space: pre-line;
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
