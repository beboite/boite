<script lang="ts">
  import { tick } from 'svelte';
  import { ArrowLeft, CheckCheck, CornerUpLeft, SquareArrowOutUpRight } from '@lucide/svelte';
  import { hierarchyOf, whereOf, type AgentMail, type Discussion } from '../lib/agent-mail';
  import { clockTime, count, exactTime } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import RemoteChip from './RemoteChip.svelte';

  /**
   * One discussion, back and forth, the way this thread's chat reads: its own
   * agent on the left, what reaches it on the right in the accent, like the
   * user's prompts. Consecutive letters of one side share their time stamp; a
   * long silence gets its own line.
   */
  let { store, discussion, letterId, onback }: {
    store: Store; discussion: Discussion; letterId?: string; onback: () => void;
  } = $props();

  /** A silence this long starts a new stretch with its own time. */
  const STRETCH_MS = 20 * 60_000;
  /** Letters of one side this close together read as one group. */
  const GROUP_MS = 5 * 60_000;
  const FAILED = ['uncertain', 'expired', 'rejected'];

  type Item =
    | { kind: 'time'; key: string; at: number }
    | { kind: 'message'; key: string; entry: AgentMail; right: boolean; first: boolean; last: boolean; stamp?: boolean; quote?: AgentMail; label?: string };

  /**
   * The user's side holds what reaches this agent and what the user typed; the
   * persistent agent that looks after the project never sits there.
   */
  function onRight(entry: AgentMail): boolean {
    return entry.letter.origin !== 'resident' && (entry.direction === 'incoming' || entry.letter.origin === 'user');
  }
  function labelOf(entry: AgentMail): string | undefined {
    if (entry.letter.origin === 'user') return strings.agentMessages.you;
    if (entry.letter.origin === 'result') return strings.agentMessages.result;
    if (entry.letter.origin === 'resident') return discussion.agent?.name ?? strings.agentMessages.relation.resident;
    if (entry.letter.contact) return `${entry.letter.origin === 'contact-human' ? strings.shared.human : strings.shared.agent} · ${entry.letter.contact.name}`;
    return undefined;
  }
  let items = $derived.by(() => {
    const out: Item[] = [];
    const byId = new Map(discussion.entries.map(entry => [entry.letter.id, entry]));
    let previous: AgentMail | undefined;
    let open: Extract<Item, { kind: 'message' }> | undefined;
    for (const entry of discussion.entries) {
      const at = entry.letter.createdAt;
      if (!previous || at - previous.letter.createdAt >= STRETCH_MS) { out.push({ kind: 'time', key: `time:${entry.letter.id}`, at }); open = undefined; }
      const right = onRight(entry);
      const label = labelOf(entry);
      const joins = open !== undefined && open.right === right && open.label === label && at - open.entry.letter.createdAt < GROUP_MS && !FAILED.includes(open.entry.letter.status);
      if (open && joins) open.last = false;
      const replied = entry.letter.replyTo ? byId.get(entry.letter.replyTo) : undefined;
      const item: Extract<Item, { kind: 'message' }> = { kind: 'message', key: entry.letter.id, entry, right, first: !joins, last: true,
        ...(replied && replied !== previous ? { quote: replied } : {}), ...(label ? { label } : {}) };
      out.push(item);
      open = item;
      previous = entry;
    }
    // A group's time shows once it says something new: the same minute as the line above it is noise.
    let minute = -1;
    for (const item of out) {
      if (item.kind === 'time') minute = Math.floor(item.at / 60_000);
      else if (item.kind === 'message' && item.last) {
        const at = Math.floor(item.entry.letter.createdAt / 60_000);
        item.stamp = at !== minute;
        minute = at;
      }
    }
    return out;
  });
  let tag = $derived(hierarchyOf(discussion));
  let where = $derived(whereOf(discussion));

  let list = $state<HTMLDivElement>();
  let flash = $state<string | null>(null);
  /** The discussion and letter the view last landed on, and how many letters it had then. */
  let landed: string | undefined;
  /** The discussion and letter the view opened on, even while that letter has not arrived. */
  let opened: string | undefined;
  let seen = 0;
  let atEnd = true;
  function show(id: string): void {
    const target = [...(list?.querySelectorAll<HTMLElement>('[data-letter-id]') ?? [])].find(node => node.dataset.letterId === id);
    if (!list || !target) return;
    list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top - 48;
    flash = id;
    setTimeout(() => { if (flash === id) flash = null; }, 1600);
  }
  $effect(() => {
    const target = `${discussion.key}:${letterId ?? ''}`;
    const size = discussion.entries.length;
    const found = letterId !== undefined && discussion.entries.some(entry => entry.letter.id === letterId);
    // Landed on it and still on it; a letter opened since (a pruned one at the end) makes it new again.
    if (!list || (opened === target && landed === target)) return;
    if (opened !== target) {
      opened = target;
      seen = size;
      // Another discussion starts at its end; where the reader was in the last one says nothing about it.
      atEnd = true;
      if (found || letterId === undefined) landed = target;
      void tick().then(() => {
        if (!list) return;
        if (found) show(letterId!);
        else list.scrollTop = list.scrollHeight;
        scrolled();
      });
      return;
    }
    // Opened on the end while its letter was on its way: land on it once it arrives. A pruned one never does.
    if (found) {
      landed = target;
      seen = size;
      void tick().then(() => { show(letterId!); scrolled(); });
    }
  });
  // New mail follows the end when the reader is there.
  $effect(() => {
    const size = discussion.entries.length;
    if (!list || seen === 0 || size <= seen) return;
    seen = size;
    if (atEnd) void tick().then(() => { if (list) list.scrollTop = list.scrollHeight; });
  });
  function scrolled(): void {
    if (list) atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  }
  function excerpt(text: string): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }
</script>

<article class="discussion-view" data-testid="agent-discussion-view" data-peer={discussion.key}>
  <header>
    <button type="button" class="ghost small icon back" data-testid="agent-discussion-back" aria-label={strings.agentMessages.back} title={strings.agentMessages.back} onclick={onback}>
      <ArrowLeft size={15} />
    </button>
    <AgentAvatar title={discussion.title} providerId={discussion.providerId} status={discussion.status} resident={discussion.resident} agent={discussion.agent} size={32} />
    <div class="who">
      <strong data-testid="agent-discussion-heading" tabindex="-1">{discussion.title}</strong>
      <span class="facts">
        {#if discussion.contact}<RemoteChip name={discussion.contact} human={discussion.entries.every(entry => entry.letter.origin === 'contact-human')} />{/if}
        {#if tag}<span class="tag" class:resident={discussion.resident} data-relation={tag}>{strings.agentMessages.relation[tag]}</span>{/if}
        {#if where}<span class="where" data-testid="agent-discussion-where">{where}</span>{/if}
        {#if discussion.model}<span class="model">{discussion.model}</span>{/if}
      </span>
    </div>
    <button type="button" class="ghost small icon" data-testid="agent-letter-open" aria-label={strings.agentMessages.openThread} title={strings.agentMessages.openThread}
      onclick={() => void workspace.openAgentThread(store, discussion.self, discussion.address)}>
      <SquareArrowOutUpRight size={15} />
    </button>
  </header>
  {#if discussion.about}
    <p class="about"><span>{strings.agentMessages.about}</span> {discussion.about}</p>
  {/if}
  <div class="letters" bind:this={list} onscroll={scrolled} data-testid="agent-discussion-letters">
    {#if discussion.contact}<p class="about" data-testid="shared-external-origin">{strings.shared.external}</p>{/if}
    {#each items as item (item.key)}
      {#if item.kind === 'time'}
        <time class="stretch" datetime={new Date(item.at).toISOString()} title={exactTime(item.at)}>{clockTime(item.at)}</time>
      {:else}
        {@const letter = item.entry.letter}
        {@const failed = FAILED.includes(letter.status)}
        <div class="msg" class:right={item.right} class:first={item.first} class:last={item.last} class:resident={letter.origin === 'resident'}
          class:flash={flash === letter.id} class:failed
          data-testid="agent-discussion-message" data-letter-id={letter.id} data-direction={item.entry.direction}>
          {#if item.first && item.label}<span class="label">{item.label}</span>{/if}
          <div class="bubble">
            {#if item.quote}
              <button type="button" class="quote" data-testid="agent-discussion-quote" title={strings.agentMessages.replyTo} onclick={() => show(item.quote!.letter.id)}>
                <CornerUpLeft size={12} strokeWidth={2} aria-hidden="true" /><span>{excerpt(item.quote.letter.text)}</span>
              </button>
            {/if}
            <p class="text">{letter.text}</p>
          </div>
          {#if (item.last && (item.stamp || item.entry.direction === 'outgoing')) || failed}
            <span class="meta">
              {#if item.stamp || failed}<time datetime={new Date(letter.createdAt).toISOString()} title={exactTime(letter.createdAt)} data-testid="agent-letter-age">{clockTime(letter.createdAt)}</time>{/if}
              {#if failed}
                <!-- The reason opens on a tap: a phone has no hover title. -->
                <details class="state bad">
                  <summary data-testid="agent-letter-status" data-status={letter.status}>{strings.coordination.bubbleStatus[letter.status]}</summary>
                  <p>{letter.error ? `${strings.coordination.status[letter.status]}. ${letter.error}` : strings.coordination.status[letter.status]}</p>
                </details>
              {:else if item.entry.direction === 'outgoing'}
                <span class="state" data-testid="agent-letter-status" data-status={letter.status} title={strings.coordination.status[letter.status]}
                  aria-label={strings.coordination.status[letter.status]}>
                  {#if letter.status === 'received' || letter.status === 'delivered'}<CheckCheck size={14} strokeWidth={1.75} aria-hidden="true" />{:else}{strings.coordination.bubbleStatus[letter.status]}{/if}
                </span>
              {/if}
            </span>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
  <footer class="tally">{fill(strings.agentMessages.sentReceived, { sent: count(discussion.sent), received: count(discussion.received) })}</footer>
</article>

<style>
  .discussion-view { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
  .back { display: none; }
  @container messages (max-width: 640px) { .back { display: inline-flex; } }
  header { flex: none; min-height: 52px; padding: 8px 8px 8px 10px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--color-border); }
  .who { flex: 1; min-width: 0; display: grid; gap: 3px; }
  .who strong:focus { outline: none; }
  .who strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
  .facts { min-width: 0; display: flex; align-items: center; gap: 6px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .facts > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .facts .tag { flex: none; padding: 1px 6px; border-radius: var(--radius-full); background: var(--color-accent-soft); color: var(--color-accent); font-weight: 500; }
  .facts .tag.resident { background: var(--color-resident-soft); color: var(--color-resident); }
  .facts .model { font-family: var(--font-mono); }
  .about { flex: none; margin: 0; padding: 8px 14px; border-bottom: 1px solid var(--color-border); color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.45; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
  .about > span { color: var(--color-foreground); font-weight: 600; }
  .letters { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px 12px 16px; overflow-y: auto; overscroll-behavior: contain; }
  .stretch { align-self: center; margin: 12px 0 8px; padding: 2px 8px; border-radius: var(--radius-full); background: var(--color-surface-2); color: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .stretch:first-child { margin-top: 0; }
  .msg { display: flex; flex-direction: column; align-items: flex-start; max-width: 86%; margin-top: 2px; }
  .msg.first { margin-top: 10px; }
  .msg.right { align-self: flex-end; align-items: flex-end; }
  .label { margin: 0 6px 3px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 600; }
  .bubble { max-width: 100%; padding: 7px 11px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2); color: var(--color-foreground); transition: box-shadow var(--dur-3) var(--ease-out-quint); }
  .msg .bubble { border-bottom-left-radius: var(--radius-sm); }
  .msg:not(.first) .bubble { border-top-left-radius: var(--radius-sm); }
  .msg.right .bubble { border-color: color-mix(in oklch, var(--color-accent) 55%, transparent); border-bottom-left-radius: var(--radius-lg); border-bottom-right-radius: var(--radius-sm); background: var(--color-accent-soft); }
  .msg.right:not(.first) .bubble { border-top-left-radius: var(--radius-lg); border-top-right-radius: var(--radius-sm); }
  .msg.resident .bubble { border-color: color-mix(in oklch, var(--color-resident) 45%, transparent); border-left: 2px solid var(--color-resident); background: var(--color-resident-soft); }
  .msg.resident .label { color: var(--color-resident); }
  .msg.failed .bubble { border-style: dashed; }
  .msg.flash .bubble { box-shadow: 0 0 0 2px var(--color-accent); }
  .text { margin: 0; font-size: var(--text-sm); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .quote { display: flex; align-items: center; gap: 5px; width: 100%; height: auto; min-height: 0; margin: 0 0 5px; padding: 3px 7px; border: 0; border-left: 2px solid var(--color-edge); border-radius: var(--radius-sm); background: var(--color-hover); color: var(--color-muted-foreground); font-size: var(--text-xs); text-align: left; }
  .quote:hover { color: var(--color-foreground); }
  .quote :global(svg) { flex: none; }
  .quote > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: flex; align-items: center; gap: 6px; margin: 3px 6px 0; color: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .state { display: inline-flex; align-items: center; }
  .state.bad { color: var(--color-danger); }
  .state.bad summary { cursor: pointer; }
  .state.bad p { margin: 4px 0 0; max-width: 40ch; color: var(--color-muted-foreground); line-height: 1.45; overflow-wrap: anywhere; }
  .meta:has(details[open]) { align-items: flex-start; }
  .tally { flex: none; padding: 6px 14px; border-top: 1px solid var(--color-border); color: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  @media (max-width: 720px) { .letters { padding-inline: 14px; } .msg { max-width: 90%; } .quote { min-height: var(--touch-target); } }
</style>
