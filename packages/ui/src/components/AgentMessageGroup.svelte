<script lang="ts">
  import { ArrowDownLeft, ArrowUpRight, ChevronRight } from '@lucide/svelte';
  import { discussionsOf, hierarchyOf, whereOf, type AgentMailGroup } from '../lib/agent-mail';
  import { agentDirectory } from '../lib/agent-directory.svelte';
  import { count } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import AgentAvatar from './AgentAvatar.svelte';

  /**
   * A burst of agent mail in the timeline: one row per conversation it went to
   * or came from, in the order they started, with what was last said. A row
   * opens that discussion in the panel, on the burst's first letter.
   */
  let { store, group }: { store: Store; group: AgentMailGroup } = $props();
  /** Past this many conversations, the rest is one line that opens the list. */
  const SHOWN = 4;
  let discussions = $derived(discussionsOf(group.entries, store, agentDirectory(store))
    .sort((a, b) => a.entries[0]!.letter.createdAt - b.entries[0]!.letter.createdAt || a.key.localeCompare(b.key)));
</script>

<div class="exchanges" data-testid="agent-message-group" data-group-id={group.id}>
  {#each discussions.slice(0, SHOWN) as discussion (discussion.key)}
    {@const tag = hierarchyOf(discussion)}
    {@const where = whereOf(discussion)}
    {@const last = discussion.last}
    <button type="button" class="discussion" class:resident={discussion.resident}
      data-testid="agent-discussion-row" data-peer={discussion.key} data-count={discussion.entries.length}
      title={strings.agentMessages.open}
      onclick={() => store.panel.openMessages(discussion.key, discussion.entries[0]!.letter.id)}>
      <AgentAvatar title={discussion.title} providerId={discussion.providerId} status={discussion.status} resident={discussion.resident} agent={discussion.agent} size={28} />
      <span class="body">
        <span class="top">
          <strong class="title" data-testid="agent-discussion-title">{discussion.title}</strong>
          {#if tag}<span class="tag" data-relation={tag}>{strings.agentMessages.relation[tag]}</span>{/if}
          {#if where}<span class="where">{where}</span>{/if}
        </span>
        <span class="preview" data-testid="agent-discussion-preview">
          {#if last.direction === 'outgoing'}<ArrowUpRight size={12} strokeWidth={2} aria-label={strings.agentMessages.mine} />{/if}
          <span>{last.letter.text}</span>
        </span>
      </span>
      <span class="counts" title={fill(strings.agentMessages.sentReceived, { sent: count(discussion.sent), received: count(discussion.received) })}>
        {#if discussion.sent}<span class="count"><ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />{count(discussion.sent)}</span>{/if}
        {#if discussion.received}<span class="count in"><ArrowDownLeft size={12} strokeWidth={2} aria-hidden="true" />{count(discussion.received)}</span>{/if}
      </span>
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
    border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2);
    color: var(--color-muted-foreground); box-shadow: var(--shadow-e1); text-align: left; font-size: var(--text-sm); white-space: normal;
    transition: background var(--dur-1) var(--ease-out-quint), border-color var(--dur-1) var(--ease-out-quint), transform var(--dur-1) var(--ease-out-quint);
  }
  .discussion:hover { background: var(--color-surface-3); border-color: var(--color-edge); color: var(--color-foreground); }
  .discussion:active { transform: scale(0.99); }
  .discussion.resident { border-left: 2px solid var(--color-resident); }
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
