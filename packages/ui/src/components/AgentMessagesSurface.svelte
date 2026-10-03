<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { MessageSquare } from '@lucide/svelte';
  import { agentMailFor, type MailDirection } from '../lib/agent-mail';
  import type { BoundPanel, Surface } from '../lib/right-panel.svelte';
  import type { Store } from '../lib/store.svelte';
  import { count } from '../lib/format';
  import { strings } from '../lib/strings';
  import { workspace } from '../lib/workspace.svelte';
  import ForwardedAgentMessage from './ForwardedAgentMessage.svelte';

  let { store, surface, panel }: { store: Store; surface: Surface; panel: BoundPanel } = $props();
  const filters: (MailDirection | 'all')[] = ['all', 'outgoing', 'incoming'];
  let threadId = $derived(store.openThread?.id);
  let mail = $derived(threadId ? agentMailFor(store, threadId) : []);
  let direction = $derived(surface.mailDirection ?? 'all');
  let visible = $derived(mail.filter(entry => direction === 'all' || entry.direction === direction));
  let list = $state<HTMLDivElement>();
  let focused: Surface | undefined;
  $effect(() => {
    const id = threadId;
    if (id && !store.openThread?.agentSessionId) untrack(() => void store.loadCoordination(id, false));
  });
  $effect(() => {
    const request = surface;
    const id = request.letterId;
    if (!list || !id || focused === request || !visible.some(entry => entry.letter.id === id)) return;
    focused = request;
    void tick().then(() => {
      if (surface !== request || !list) return;
      const target = [...list.querySelectorAll<HTMLElement>('[data-letter-id]')].find(node => node.dataset.letterId === id);
      if (target) list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top - 12;
    });
  });
</script>

<section class="mail" data-testid="agent-messages-surface">
  <div class="filters" role="group" aria-label={strings.agentMessages.filter}>
    {#each filters as filter}
      <button type="button" class="ghost small" class:active={direction === filter} aria-pressed={direction === filter}
        data-testid="agent-messages-filter" data-direction={filter}
        onclick={() => panel.update(surface.id, { mailDirection: filter === 'all' ? undefined : filter, letterId: undefined })}>
        {filter === 'all' ? strings.agentMessages.all : filter === 'outgoing' ? strings.agentMessages.sent : strings.agentMessages.received}
        <span class="count">{count(mail.filter(entry => filter === 'all' || entry.direction === filter).length)}</span>
      </button>
    {/each}
  </div>
  <div class="letters" bind:this={list} data-testid="agent-messages-list">
    {#if visible.length === 0}
      <div class="no-mail"><MessageSquare size={24} strokeWidth={1.5} aria-hidden="true" /><p>{strings.agentMessages.empty}</p></div>
    {:else}
      {#each visible as entry (entry.letter.id)}
        <ForwardedAgentMessage letter={entry.letter} self={entry.self} projectName={entry.projectName} compact
          onopen={address => void workspace.openAgentThread(store, entry.self, address)} />
      {/each}
    {/if}
  </div>
</section>

<style>
  .mail { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .filters { display: flex; gap: 4px; padding: 10px 12px; border-bottom: 1px solid var(--color-border); flex: none; }
  .filters button { flex: 1; min-width: 0; gap: 6px; padding-inline: 8px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .filters button.active { background: var(--color-active); color: var(--color-foreground); }
  .count { font-variant-numeric: tabular-nums; color: var(--color-muted-foreground); }
  .letters { display: flex; flex-direction: column; gap: 16px; flex: 1; min-height: 0; padding: 16px 12px; overflow-y: auto; overscroll-behavior: contain; }
  .no-mail { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--color-muted-foreground); text-align: center; font-size: var(--text-sm); }
  @media (max-width: 720px) { .filters button { min-height: var(--touch-target); } .letters { padding: 16px; } }
</style>
