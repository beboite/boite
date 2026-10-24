<script lang="ts">
  import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ChevronRight, CornerDownLeft, Forward } from '@lucide/svelte';
  import { agentMailFor, discussionsOf, hierarchyOf, whereOf, type AgentMailGroup, type Discussion } from '../lib/agent-mail';
  import { agentDirectory } from '../lib/agent-directory.svelte';
  import { count } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import RemoteChip from './RemoteChip.svelte';

  /**
   * A burst of agent mail in the timeline: one row per conversation it went to
   * or came from, in the order they started, with what was last said. A row
   * says first which way the burst went: what this agent sent sits on its side,
   * what reached it on the right in the accent, as in the discussion itself. A
   * row opens that discussion in the panel, on the burst's first letter.
   */
  let { store, group }: { store: Store; group: AgentMailGroup } = $props();
  /** Past this many conversations, the rest is one line that opens the list. */
  const SHOWN = 4;
  let threadId = $derived(store.openThread?.id);
  let discussions = $derived(discussionsOf(group.entries, store, agentDirectory(store), threadId ? agentMailFor(store, threadId) : undefined)
    .sort((a, b) => a.entries[0]!.letter.createdAt - b.entries[0]!.letter.createdAt || a.key.localeCompare(b.key)));
  type Way = 'out' | 'in' | 'both';
  function wayOf(discussion: Discussion): Way {
    return discussion.received === 0 ? 'out' : discussion.sent === 0 ? 'in' : 'both';
  }
  function kicker(way: Way, discussion: Discussion): string {
    if (way === 'both') return strings.agentMessages.exchanged;
    const size = way === 'out' ? discussion.sent : discussion.received;
    const text = way === 'out' ? size === 1 ? strings.agentMessages.sentOne : strings.agentMessages.sentMany
      : size === 1 ? strings.agentMessages.receivedOne : strings.agentMessages.receivedMany;
    return fill(text, { count: count(size) });
  }
</script>

<div class="exchanges" data-testid="agent-message-group" data-group-id={group.id}>
  {#each discussions.slice(0, SHOWN) as discussion (discussion.key)}
    {@const tag = hierarchyOf(discussion)}
    {@const where = whereOf(discussion)}
    {@const last = discussion.last}
    {@const way = wayOf(discussion)}
    <button type="button" class="discussion {way}" class:resident={discussion.resident}
      data-testid="agent-discussion-row" data-peer={discussion.key} data-count={discussion.entries.length} data-way={way}
      title={strings.agentMessages.open}
      onclick={() => store.panel.openMessages(discussion.key, discussion.entries[0]!.letter.id)}>
      <AgentAvatar title={discussion.title} providerId={discussion.providerId} status={discussion.status} resident={discussion.resident} agent={discussion.agent} size={28} />
      <span class="body">
        <span class="kicker" data-testid="agent-discussion-way">
          {#if way === 'out'}<Forward size={13} strokeWidth={2} aria-hidden="true" />
          {:else if way === 'in'}<CornerDownLeft size={13} strokeWidth={2} aria-hidden="true" />
          {:else}<ArrowLeftRight size={13} strokeWidth={2} aria-hidden="true" />{/if}
          <span>{kicker(way, discussion)}</span>
        </span>
        <span class="top">
          <strong class="title" data-testid="agent-discussion-title">{discussion.title}</strong>
          {#if discussion.contact}<RemoteChip name={discussion.contact} human={discussion.entries.every(entry => entry.letter.origin === 'contact-human')} />{/if}
          {#if tag}<span class="tag" data-relation={tag}>{strings.agentMessages.relation[tag]}</span>{/if}
          {#if where}<span class="where">{where}</span>{/if}
        </span>
        <span class="preview" data-testid="agent-discussion-preview">
          {#if way === 'both' && last.direction === 'outgoing'}<ArrowUpRight size={12} strokeWidth={2} aria-label={strings.agentMessages.mine} />{/if}
          <span>{last.letter.text}</span>
        </span>
      </span>
      {#if way === 'both'}
        <span class="counts" title={fill(strings.agentMessages.sentReceived, { sent: count(discussion.sent), received: count(discussion.received) })}>
          <span class="count"><ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />{count(discussion.sent)}</span>
          <span class="count in"><ArrowDownLeft size={12} strokeWidth={2} aria-hidden="true" />{count(discussion.received)}</span>
        </span>
      {:else}<span></span>{/if}
      <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  {/each}
  {#if discussions.length > SHOWN}
    <button type="button" class="line" data-testid="agent-discussion-more" onclick={() => store.panel.openMessages()}>
      {fill(strings.agentMessages.more, { count: count(discussions.length - SHOWN) })}
    </button>
  {/if}
</div>

<style>
  .exchanges { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
  .discussion {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 10px;
    width: min(100%, 560px); height: auto; min-height: var(--control); padding: 8px 10px 8px 9px;
    border: 1px solid var(--color-border); border-radius: var(--radius-lg); border-bottom-left-radius: var(--radius-sm); background: var(--color-surface-2);
    color: var(--color-muted-foreground); box-shadow: var(--shadow-e1); text-align: left; font-size: var(--text-sm); white-space: normal;
    transition: background var(--dur-1) var(--ease-out-quint), border-color var(--dur-1) var(--ease-out-quint), transform var(--dur-1) var(--ease-out-quint);
  }
  .discussion:hover { background: var(--color-surface-3); border-color: var(--color-edge); color: var(--color-foreground); }
  .discussion:active { transform: scale(0.99); }
  /* What reached this agent: the user's side, in the accent, its corner toward the right. */
  .discussion.in { align-self: flex-end; border-color: color-mix(in oklch, var(--color-accent) 55%, transparent); border-bottom-left-radius: var(--radius-lg); border-bottom-right-radius: var(--radius-sm); background: var(--color-accent-soft); }
  .discussion.in:hover { background: color-mix(in oklch, var(--color-accent) 18%, var(--color-surface-2)); border-color: var(--color-accent); }
  .discussion.resident { border-left: 2px solid var(--color-resident); }
  .kicker { min-width: 0; display: flex; align-items: center; gap: 5px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 600; }
  .kicker :global(svg) { flex: none; }
  .kicker > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .in .kicker { color: var(--color-accent); }
  .body { min-width: 0; display: grid; gap: 2px; }
  /* The title keeps its line; the tag and the place wrap under it when the row is narrow. */
  .top { min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; }
  .title { flex: 0 1 auto; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); font-weight: 600; }
  .tag { flex: none; padding: 1px 6px; border-radius: var(--radius-full); background: var(--color-accent-soft); color: var(--color-accent); font-size: var(--text-xs); font-weight: 500; }
  .resident .tag { background: var(--color-resident-soft); color: var(--color-resident); }
  .where { flex: 1 1 0; min-width: 6ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); }
  .preview { min-width: 0; display: flex; align-items: center; gap: 4px; font-size: var(--text-xs); }
  .preview :global(svg) { flex: none; }
  .preview > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .counts { display: flex; gap: 6px; font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .count { display: inline-flex; align-items: center; gap: 2px; }
  .count.in { color: var(--color-accent); }
  .line { display: inline-flex; align-items: center; gap: 6px; height: auto; min-height: 0; padding: 4px 10px; border: 0; border-left: 2px solid var(--color-border); border-radius: var(--radius-sm); background: transparent; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .line:hover { color: var(--color-foreground); background: var(--color-hover); }
  @media (max-width: 720px) {
    .discussion { width: 100%; min-height: var(--touch-target); }
    .line { min-height: var(--touch-target); }
  }
</style>
