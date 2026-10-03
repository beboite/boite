<script lang="ts">
  import { ChevronRight, CornerDownLeft, Forward, CircleAlert } from '@lucide/svelte';
  import type { AgentMailGroup, MailDirection } from '../lib/agent-mail';
  import { mailNeedsAttention } from '../lib/agent-mail';
  import { count } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store, group }: { store: Store; group: AgentMailGroup } = $props();
  const directions: MailDirection[] = ['outgoing', 'incoming'];
</script>

<div class="exchanges" data-testid="agent-message-group" data-group-id={group.id}>
  {#each directions as direction}
    {@const entries = group.entries.filter(entry => entry.direction === direction)}
    {@const issues = entries.filter(mailNeedsAttention).length}
    {#if entries.length}
      <button type="button" class="summary" class:received={direction === 'incoming'}
        data-testid="agent-message-summary" data-direction={direction} data-count={entries.length}
        title={strings.agentMessages.open}
        onclick={() => store.panel.openMessages(entries[0]!.letter.id, direction)}>
        <span class="arrow" aria-hidden="true">
          {#if direction === 'outgoing'}<Forward size={16} strokeWidth={1.75} />
          {:else}<CornerDownLeft size={16} strokeWidth={1.75} />{/if}
        </span>
        <span class="content">
          <span>{fill(direction === 'outgoing'
            ? entries.length === 1 ? strings.agentMessages.forwardedOne : strings.agentMessages.forwardedMany
            : entries.length === 1 ? strings.agentMessages.receivedOne : strings.agentMessages.receivedMany,
            { count: count(entries.length) })}</span>
          {#if issues}<span class="issues" data-testid="agent-message-issues"><CircleAlert size={12} /><span class="ui-label">{fill(issues === 1 ? strings.agentMessages.issueOne : strings.agentMessages.issueMany, { count: count(issues) })}</span></span>{/if}
        </span>
        <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    {/if}
  {/each}
</div>

<style>
  .exchanges { display: flex; flex-direction: column; gap: 8px; }
  .summary { display: flex; align-items: center; justify-content: flex-start; gap: 9px; width: fit-content; max-width: 92%; height: auto; min-height: var(--control); padding: 9px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); border-bottom-left-radius: var(--radius-sm); background: var(--color-surface-2); color: var(--color-muted-foreground); box-shadow: var(--shadow-e1); text-align: left; font-size: var(--text-sm); white-space: normal; }
  .summary:hover { background: var(--color-hover); color: var(--color-foreground); }
  .received { margin-left: auto; border-color: var(--color-accent); border-bottom-left-radius: var(--radius-lg); border-bottom-right-radius: var(--radius-sm); background: var(--color-accent-soft); }
  .received .arrow { color: var(--color-accent); }
  .arrow { display: flex; flex: none; }
  .content { display: flex; flex-direction: column; gap: 4px; color: var(--color-foreground); overflow-wrap: anywhere; }
  .issues { display: flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--color-danger); }
  @media (max-width: 720px) { .summary { min-height: var(--touch-target); } }
</style>
