<script lang="ts">
  import { BellRing, ChevronRight, CornerDownLeft, Forward, CircleAlert, UserCog } from '@lucide/svelte';
  import type { AgentMail, AgentMailGroup } from '../lib/agent-mail';
  import { mailNeedsAttention } from '../lib/agent-mail';
  import { count } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store, group }: { store: Store; group: AgentMailGroup } = $props();
  /** Letters from the steward and notices about watched threads get rows of their own, apart from agents' mail. */
  type Kind = 'outgoing' | 'incoming' | 'steward' | 'notice';
  const kinds: Kind[] = ['outgoing', 'steward', 'incoming', 'notice'];
  function kindOf(entry: AgentMail): Kind {
    if (entry.direction === 'outgoing') return 'outgoing';
    return entry.letter.origin === 'notice' ? 'notice' : entry.letter.origin === 'steward' ? 'steward' : 'incoming';
  }
  function label(kind: Kind, size: number): string {
    const one = size === 1;
    const text = kind === 'outgoing' ? one ? strings.agentMessages.forwardedOne : strings.agentMessages.forwardedMany
      : kind === 'steward' ? one ? strings.agentMessages.stewardOne : strings.agentMessages.stewardMany
      : kind === 'notice' ? one ? strings.agentMessages.noticeOne : strings.agentMessages.noticeMany
      : one ? strings.agentMessages.receivedOne : strings.agentMessages.receivedMany;
    return fill(text, { count: count(size) });
  }
</script>

<div class="exchanges" data-testid="agent-message-group" data-group-id={group.id}>
  {#each kinds as kind}
    {@const entries = group.entries.filter(entry => kindOf(entry) === kind)}
    {@const issues = entries.filter(mailNeedsAttention).length}
    {@const direction = kind === 'outgoing' ? 'outgoing' : 'incoming'}
    {#if entries.length}
      <button type="button" class="summary" class:received={kind === 'incoming'} class:steward={kind === 'steward'} class:notice={kind === 'notice'}
        data-testid="agent-message-summary" data-direction={direction} data-kind={kind} data-count={entries.length}
        title={strings.agentMessages.open}
        onclick={() => store.panel.openMessages(entries[0]!.letter.id, direction)}>
        <span class="arrow" aria-hidden="true">
          {#if kind === 'outgoing'}<Forward size={16} strokeWidth={1.75} />
          {:else if kind === 'steward'}<UserCog size={16} strokeWidth={1.75} />
          {:else if kind === 'notice'}<BellRing size={14} strokeWidth={1.75} />
          {:else}<CornerDownLeft size={16} strokeWidth={1.75} />{/if}
        </span>
        <span class="content">
          <span>{label(kind, entries.length)}</span>
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
  .steward { border-color: color-mix(in oklch, var(--color-steward) 45%, transparent); border-left: 2px solid var(--color-steward); background: var(--color-steward-soft); }
  .steward .arrow { color: var(--color-steward); }
  .notice { min-height: 0; padding: 4px 10px; border-color: transparent; border-left: 2px solid var(--color-border); border-radius: var(--radius-sm); background: transparent; box-shadow: none; font-size: var(--text-xs); }
  .notice .content { color: var(--color-muted-foreground); }
  .arrow { display: flex; flex: none; }
  .content { display: flex; flex-direction: column; gap: 4px; color: var(--color-foreground); overflow-wrap: anywhere; }
  .issues { display: flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--color-danger); }
  @media (max-width: 720px) { .summary { min-height: var(--touch-target); } }
</style>
