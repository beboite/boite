<script lang="ts">
  import { Plus, Search, Settings2, UserRoundPlus, Users, X } from '@lucide/svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import { chatKey, previewOf, type AgentChat, type AgentEntryKind, type AgentFocus, type AgentsView } from '../../lib/agents.svelte';
  import { type MenuItem } from '../../lib/menu';
  import { fill, strings } from '../../lib/strings';
  import { workspace } from '../../lib/workspace.svelte';
  import Menu from '../Menu.svelte';
  import RailFrame from '../RailFrame.svelte';
  import RailHead from '../RailHead.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import AgentRow from './AgentRow.svelte';

  /**
   * The conversations with agents, listed the way a messenger lists its chats
   * in the thread list's own frame and head (`RailFrame`, `RailHead`): one
   * card of rows, each with its picture, its name, where it stands and the
   * last thing said. An agent that waits on the user says so on its row; what
   * it asks is in its conversation.
   */
  let { view, chats, active, live, onfocus, oncreate }: {
    view: AgentsView;
    chats: AgentChat[];
    /** The row the open page belongs to, `kind:id`. */
    active: string | null;
    /** The thread each row's agents work in now, by row key. */
    live: Map<string, ThreadSummary>;
    onfocus: (focus: AgentFocus) => void;
    oncreate: (kind: AgentEntryKind) => void;
  } = $props();

  const labels = $derived(strings.agents);
  let query = $state('');
  let searching = $state(false);
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const snapshot = $derived(view.snapshot);
  const profiles = $derived(new Map(snapshot?.profiles.map(a => [a.id, a]) ?? []));
  const needle = $derived(query.trim().toLowerCase());
  const shown = $derived(needle ? chats.filter(c => c.name.toLowerCase().includes(needle)) : chats);
  /** A search also reaches what the list leaves out: archived agents and missions. */
  const found = $derived(needle && snapshot ? [
    ...snapshot.profiles.filter(a => a.status === 'archived' && a.name.toLowerCase().includes(needle)).map(a => ({ kind: 'profile' as const, id: a.id, name: a.name, avatar: a.avatar, state: labels.archived })),
    ...snapshot.missions.filter(m => m.title.toLowerCase().includes(needle)).map(m => ({ kind: 'mission' as const, id: m.id, name: m.title, avatar: '', state: labels[m.status] }))
  ] : []);
  const multi = $derived(workspace.machines.length > 1);
  const machines = $derived<MenuItem[]>(workspace.machines.map(m => ({ id: m.id, label: m.label, active: m.store === view.store })));
  const machine = $derived(workspace.machines.find(m => m.store === view.store));
  const createItems = $derived<MenuItem[]>([{ id: 'profile', label: labels.newTitle.profile, glyph: UserRoundPlus }, { id: 'group', label: labels.newTitle.group, glyph: Users }]);

  function memberList(chat: AgentChat) {
    return chat.members.flatMap(id => profiles.get(id) ?? []);
  }
  /** The last thing said, the way a messenger previews a chat; a new agent shows what it is for. */
  function detail(chat: AgentChat): string {
    const last = chat.last;
    if (last) {
      const text = last.thread ? fill(labels.threadEvent[last.thread.event], { name: profiles.get(last.senderId ?? '')?.name ?? '', title: last.thread.title }) : previewOf(last.text);
      const sender = last.senderId === null ? labels.user : chat.kind === 'profile' ? '' : profiles.get(last.senderId)?.name ?? '';
      return sender ? fill(labels.previewFrom, { name: sender, text }) : text;
    }
    if (chat.kind === 'profile') return profiles.get(chat.id)?.domain ?? '';
    return memberList(chat).map(a => a.name).join(', ');
  }
  function pickMachine(id: string) {
    const target = workspace.machines.find(m => m.id === id);
    if (target) void workspace.select(target.store).then(() => target.store.showAgents());
  }
  let searchToggle = $state<HTMLButtonElement>();
  /** The field unmounts under the focus: it goes back to the button that opened it. */
  function closeSearch() { searching = false; query = ''; searchToggle?.focus(); }
</script>

<RailFrame store={view.store} kind="agents-rail" label={labels.heading}>
  {#snippet head()}
    <RailHead store={view.store} current="agents">
      {#snippet lead()}
        {#if multi}
          <Menu items={machines} onpick={pickMachine} label={strings.machines.heading} placement="bottom" variant="text" testid="agents-machine"><span class="ui-label">{machine?.label ?? strings.machines.local}</span></Menu>
        {/if}
      {/snippet}
      {#snippet actions()}
        <button type="button" class="ghost icon small" bind:this={searchToggle} class:active={searching} aria-pressed={searching} title={labels.search} aria-label={labels.search} onclick={() => (searching ? closeSearch() : (searching = true))} data-testid="agents-search-toggle"><Search size={15} /></button>
        {#if view.store.owner}
          <Menu placement="bottom" align="end" variant="ghost" label={labels.create} testid="agents-create" items={createItems} onpick={id => oncreate(id as AgentEntryKind)}><Plus size={16} /></Menu>
        {/if}
      {/snippet}
    </RailHead>
  {/snippet}

  {#snippet subhead()}
    {#if searching}
      <label class="agents-search"><Search size={14} strokeWidth={1.75} />
        <!-- svelte-ignore a11y_autofocus -->
        <input type="search" bind:value={query} aria-label={labels.search} placeholder={labels.search} autofocus onkeydown={e => { if (e.key === 'Escape') closeSearch(); }} />
        <button type="button" class="ghost icon small" aria-label={labels.close} onclick={closeSearch}><X size={13} /></button>
      </label>
    {/if}
  {/snippet}

  {#if shown.length}
    <section class="agents-card" aria-label={labels.heading}>
      {#each shown as chat (chatKey(chat.kind, chat.id))}
        {@const key = chatKey(chat.kind, chat.id)}
        {@const thread = live.get(key) ?? null}
        {@const waiting = chat.attention > 0 || chat.status === 'waiting'}
        <AgentRow title={chat.name} open={active === key} unread={chat.unread} live={thread} {waiting} at={chat.at} {now} detail={detail(chat)} testid="agent-entry-{chat.id}" onclick={() => onfocus({ kind: chat.kind, id: chat.id })}>
          {#snippet picture()}<AgentAvatar kind={chat.kind} id={chat.id} name={chat.name} avatar={chat.avatar} members={memberList(chat)} status={waiting ? 'waiting' : thread ? 'running' : 'idle'} size={22} />{/snippet}
        </AgentRow>
      {/each}
    </section>
  {/if}
  {#if found.length}
    <section class="agents-card">
      {#each found as entry (`${entry.kind}:${entry.id}`)}
        <AgentRow title={entry.name} at={0} {now} detail={entry.state} testid="agent-entry-{entry.id}" onclick={() => onfocus({ kind: entry.kind, id: entry.id })}>
          {#snippet picture()}<AgentAvatar kind={entry.kind} id={entry.id} name={entry.name} avatar={entry.avatar} size={22} />{/snippet}
          {#snippet aside()}{/snippet}
        </AgentRow>
      {/each}
    </section>
  {/if}
  {#if needle && !shown.length && !found.length}<p class="agent-empty">{labels.noMatch}</p>{/if}

  {#snippet foot()}
    {#if view.store.owner}<button type="button" class="ghost icon" class:active={active === 'engine'} title={labels.engineSettings} aria-label={labels.engineSettings} onclick={() => onfocus({ kind: 'engine' })} data-testid="agents-engine"><Settings2 size={16} /></button>{/if}
  {/snippet}
</RailFrame>
