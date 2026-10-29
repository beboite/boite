<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { ArrowUpRight, MessagesSquare } from '@lucide/svelte';
  import { agentMailFor, discussionsOf, hierarchyOf, whereOf } from '../lib/agent-mail';
  import { agentDirectory } from '../lib/agent-directory.svelte';
  import type { BoundPanel, Surface } from '../lib/right-panel.svelte';
  import type { Store } from '../lib/store.svelte';
  import { count, relativeTime } from '../lib/format';
  import { page } from '../lib/page-hidden.svelte';
  import { fill, strings } from '../lib/strings';
  import AgentAvatar from './AgentAvatar.svelte';
  import RemoteChip from './RemoteChip.svelte';
  import AgentDiscussion from './AgentDiscussion.svelte';

  /**
   * The conversations this thread's agent talked with, one row each, the most
   * recent first. A row opens the back and forth; a wide panel keeps the list
   * beside it, a narrow one swaps them.
   */
  let { store, surface, panel }: { store: Store; surface: Surface; panel: BoundPanel } = $props();
  let threadId = $derived(store.openThread?.id);
  let mail = $derived(threadId ? agentMailFor(store, threadId) : []);
  let discussions = $derived(discussionsOf(mail, store, agentDirectory(store)));
  let current = $derived(surface.peer ? discussions.find(discussion => discussion.key === surface.peer) : undefined);
  $effect(() => {
    const id = threadId;
    if (id && !store.openThread?.agentSessionId) untrack(() => void store.loadCoordination(id, false));
  });
  let now = $state(Date.now());
  $effect(() => {
    if (page.hidden) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 60_000);
    return () => clearInterval(timer);
  });
  const open = (peer?: string) => panel.update(surface.id, { peer, letterId: undefined });
  let rows = $state<HTMLDivElement>();
  /**
   * A narrow panel swaps the list and the discussion: focus follows into the
   * discussion's heading, and back onto the row it came from. A second click on
   * the open row closes it, the way back from a wide panel.
   */
  function choose(peer: string): void {
    // A stored peer that names no discussion is not open: its row opens it on the first click.
    const closing = peer === current?.key;
    open(closing ? undefined : peer);
    if (!closing) void tick().then(() => rows?.parentElement?.querySelector<HTMLElement>('[data-testid=agent-discussion-heading]')?.focus());
  }
  function back(): void {
    const from = surface.peer;
    open(undefined);
    void tick().then(() => [...(rows?.querySelectorAll<HTMLElement>('[data-testid=agent-discussion]') ?? [])].find(row => row.dataset.peer === from)?.focus());
  }
</script>

<section class="mail" data-testid="agent-messages-surface">
<div class="split" class:detail={current !== undefined}>
  <div class="discussions" data-testid="agent-discussions" bind:this={rows}>
    {#if discussions.length === 0}
      <div class="no-mail"><MessagesSquare size={24} strokeWidth={1.5} aria-hidden="true" /><p>{strings.agentMessages.empty}</p></div>
    {:else}
      {#each discussions as discussion (discussion.key)}
        {@const tag = hierarchyOf(discussion)}
        {@const where = whereOf(discussion)}
        {@const last = discussion.last.letter}
        <button type="button" class="row" class:selected={discussion === current} class:resident={discussion.resident}
          data-testid="agent-discussion" data-peer={discussion.key} aria-current={discussion === current ? 'true' : undefined}
          onclick={() => choose(discussion.key)}>
          <AgentAvatar title={discussion.title} providerId={discussion.providerId} status={discussion.status} resident={discussion.resident} agent={discussion.agent} size={34} />
          <span class="main">
            <span class="line">
              <strong>{discussion.title}</strong>
              <time datetime={new Date(last.createdAt).toISOString()}>{relativeTime(last.createdAt, now)}</time>
            </span>
            {#if tag || where || discussion.contact}
              <span class="line facts">
                {#if discussion.contact}<RemoteChip name={discussion.contact} human={discussion.entries.every(entry => entry.letter.origin === 'contact-human')} />{/if}
                {#if tag}<span class="tag" data-relation={tag}>{strings.agentMessages.relation[tag]}</span>{/if}
                {#if where}<span class="where">{where}</span>{/if}
              </span>
            {/if}
            <span class="line preview">
              <span class="text">
                {#if discussion.last.direction === 'outgoing'}<ArrowUpRight size={12} strokeWidth={2} aria-label={strings.agentMessages.mine} />{/if}
                <span>{last.text}</span>
              </span>
              <span class="count" title={fill(strings.agentMessages.sentReceived, { sent: count(discussion.sent), received: count(discussion.received) })}>{count(discussion.entries.length)}</span>
            </span>
          </span>
        </button>
      {/each}
    {/if}
  </div>
  {#if current}
    <AgentDiscussion {store} discussion={current} letterId={surface.letterId} onback={back} />
  {/if}
</div>
</section>

<style>
  .mail { container: messages / inline-size; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .split { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  .split.detail { grid-template-columns: minmax(220px, 0.42fr) minmax(0, 1fr); }
  .split.detail .discussions { border-right: 1px solid var(--color-border); }
  .discussions { min-height: 0; padding: 6px; overflow-y: auto; overscroll-behavior: contain; }
  .row { width: 100%; height: auto; padding: 9px 8px; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 10px; border: 1px solid transparent; border-radius: var(--radius-md); background: transparent; color: var(--color-muted-foreground); text-align: left; font-size: var(--text-xs); }
  .row + .row { margin-top: 2px; }
  .row:hover { background: var(--color-hover); }
  .row.selected { background: var(--color-active); border-color: var(--color-border); }
  .main { min-width: 0; display: grid; gap: 3px; }
  .line { min-width: 0; display: flex; align-items: center; gap: 6px; }
  .line strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); font-size: var(--text-sm); font-weight: 600; }
  time { flex: none; font-variant-numeric: tabular-nums; }
  .tag { flex: none; padding: 1px 6px; border-radius: var(--radius-full); background: var(--color-accent-soft); color: var(--color-accent); font-weight: 500; }
  .resident .tag { background: var(--color-resident-soft); color: var(--color-resident); }
  .where { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview .text { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; }
  .preview .text :global(svg) { flex: none; }
  .preview .text > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: color-mix(in srgb, var(--color-foreground) 78%, transparent); }
  .count { flex: none; min-width: 20px; padding: 1px 6px; border-radius: var(--radius-full); background: var(--color-surface-3); text-align: center; font-variant-numeric: tabular-nums; }
  .no-mail { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; color: var(--color-muted-foreground); text-align: center; font-size: var(--text-sm); }
  @container messages (max-width: 640px) {
    .split.detail { grid-template-columns: minmax(0, 1fr); }
    .split.detail .discussions { display: none; }
  }
  @media (max-width: 720px) { .row { min-height: var(--touch-target); } }
</style>
