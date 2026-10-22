<script lang="ts">
  import { Plus, Search, Settings2, UserRoundPlus, Users, X } from '@lucide/svelte';
  import type { AgentsSnapshot, ThreadSummary } from '@boite/contracts';
  import { agentsFilter, chatKey, previewOf, waitingForUser, type AgentChat, type AgentEntryKind, type AgentFocus, type AgentsView } from '../../lib/agents.svelte';
  import { type MenuItem } from '../../lib/menu';
  import { fill, strings } from '../../lib/strings';
  import { workspace, type Machine } from '../../lib/workspace.svelte';
  import Menu from '../Menu.svelte';
  import RailFrame from '../RailFrame.svelte';
  import RailHead from '../RailHead.svelte';
  import MachineStatus from '../MachineStatus.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import AgentRow from './AgentRow.svelte';
  import { minuteClock } from '../../lib/clock.svelte';

  /**
   * The conversations with agents, listed the way a messenger lists its chats
   * in the thread list's own frame and head (`RailFrame`, `RailHead`): one
   * card of rows, each with its picture, its name, missed-message count and
   * the last thing said. An agent's current question marks its picture;
   * what it asks is in its conversation. Like the thread list, it holds every
   * connected machine's agents, newest first, each row with its machine's icon
   * once there are two; the foot's machine button narrows it to one.
   */
  type MachineChats = { machine: Machine; view: AgentsView; chats: AgentChat[]; live: Map<string, ThreadSummary> };
  let { view, lists, filter, active, onfocus, oncreate }: {
    /** The page's machine: the one a new agent and the engine settings belong to. */
    view: AgentsView;
    /** Each listed machine's conversations, the page's own first. */
    lists: MachineChats[];
    /** The machine the list is narrowed to, null for all. */
    filter: string | null;
    /** The row the open page belongs to, `kind:id`, on the page's machine. */
    active: string | null;
    onfocus: (focus: AgentFocus) => void;
    oncreate: (kind: AgentEntryKind) => void;
  } = $props();

  const labels = $derived(strings.agents);
  let query = $state('');
  let searching = $state(false);
  const now = $derived(minuteClock.now);

  const multi = $derived(workspace.machinesOr(view.store).length > 1);
  const needle = $derived(query.trim().toLowerCase());
  const rows = $derived(lists
    .flatMap(list => list.chats.filter(c => !needle || c.name.toLowerCase().includes(needle)).map(chat => ({ ...list, chat })))
    .sort((a, b) => b.chat.at - a.chat.at || a.chat.name.localeCompare(b.chat.name)));
  /** A search also reaches what the list leaves out: archived agents and missions. */
  const found = $derived(needle ? lists.flatMap(({ machine, view: owner }) => {
    const snapshot = owner.snapshot;
    if (!snapshot) return [];
    return [
      ...snapshot.profiles.filter(a => a.status === 'archived' && a.name.toLowerCase().includes(needle)).map(a => ({ machine, view: owner, kind: 'profile' as const, id: a.id, name: a.name, avatar: a.avatar, state: labels.archived })),
      ...snapshot.missions.filter(m => m.title.toLowerCase().includes(needle)).map(m => ({ machine, view: owner, kind: 'mission' as const, id: m.id, name: m.title, avatar: '', state: labels[m.status] }))
    ];
  }) : []);
  const createItems = $derived<MenuItem[]>([{ id: 'profile', label: labels.newTitle.profile, glyph: UserRoundPlus }, { id: 'group', label: labels.newTitle.group, glyph: Users }]);

  function memberList(snapshot: AgentsSnapshot | null, chat: AgentChat) {
    const profiles = snapshot?.profiles ?? [];
    return chat.members.flatMap(id => profiles.find(a => a.id === id) ?? []);
  }
  /** The last thing said, the way a messenger previews a chat; a new agent shows what it is for. */
  function detail(snapshot: AgentsSnapshot | null, chat: AgentChat): string {
    const name = (id: string | null) => snapshot?.profiles.find(a => a.id === id)?.name ?? '';
    const last = chat.last;
    if (last) {
      const text = last.thread ? fill(labels.threadEvent[last.thread.event], { name: name(last.senderId), title: last.thread.title }) : previewOf(last.text);
      const sender = last.senderId === null ? labels.user : chat.kind === 'profile' ? '' : name(last.senderId);
      return sender ? fill(labels.previewFrom, { name: sender, text }) : text;
    }
    if (chat.kind === 'profile') return snapshot?.profiles.find(a => a.id === chat.id)?.domain ?? '';
    return memberList(snapshot, chat).map(a => a.name).join(', ');
  }
  /** A row of the page's machine opens in place; another machine's opens the page there. */
  function openRow(machine: Machine, kind: AgentEntryKind, id: string) {
    // Read now: the page, and the row's values with it, is drawn again for the other machine.
    const target = machine.store;
    if (target === view.store) onfocus({ kind, id });
    else void workspace.select(target).then(() => target.showAgents(id, undefined, kind));
  }
  /** Narrowing to another machine moves the page there, so a new agent is created where the list shows. */
  function narrow(id: string | null) {
    agentsFilter.machine = id;
    const target = id ? workspace.machines.find(m => m.id === id) : undefined;
    if (target && target.store !== view.store) void workspace.select(target.store).then(() => target.store.showAgents());
  }
  let searchToggle = $state<HTMLButtonElement>();
  /** The field unmounts under the focus: it goes back to the button that opened it. */
  function closeSearch() { searching = false; query = ''; searchToggle?.focus(); }
</script>

<RailFrame store={view.store} kind="agents-rail" label={labels.heading}>
  {#snippet head()}
    <RailHead store={view.store} current="agents">
      {#snippet actions()}
        <button type="button" class="ghost icon small" bind:this={searchToggle} class:active={searching} aria-pressed={searching} title={labels.search} aria-label={labels.search} onclick={() => (searching ? closeSearch() : (searching = true))} data-testid="agents-search-toggle"><Search size={16} /></button>
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
        <button type="button" class="ghost icon small" aria-label={strings.common.close} onclick={closeSearch}><X size={13} /></button>
      </label>
    {/if}
  {/snippet}

  {#if rows.length}
    <section class="agents-card" aria-label={labels.heading}>
      {#each rows as { machine, view: owner, chat, live } (JSON.stringify([machine.id, chat.kind, chat.id]))}
        {@const key = chatKey(chat.kind, chat.id)}
        {@const thread = live.get(key) ?? null}
        {@const waiting = waitingForUser(owner.snapshot, chat.scope, thread)}
        <AgentRow title={chat.name} open={owner === view && active === key} unread={chat.unread} away={machine.store.connection !== 'ready'} at={chat.at} {now} detail={detail(owner.snapshot, chat)} machine={multi ? machine : undefined} testid="agent-entry-{chat.id}" onclick={() => openRow(machine, chat.kind, chat.id)}>
          {#snippet picture()}<AgentAvatar kind={chat.kind} id={chat.id} name={chat.name} avatar={chat.avatar} members={memberList(owner.snapshot, chat)} status={waiting ? 'waiting' : thread ? 'running' : 'idle'} size={22} />{/snippet}
        </AgentRow>
      {/each}
    </section>
  {/if}
  {#if found.length}
    <section class="agents-card">
      {#each found as entry (JSON.stringify([entry.machine.id, entry.kind, entry.id]))}
        <AgentRow title={entry.name} at={0} {now} detail={entry.state} machine={multi ? entry.machine : undefined} testid="agent-entry-{entry.id}" onclick={() => openRow(entry.machine, entry.kind, entry.id)}>
          {#snippet picture()}<AgentAvatar kind={entry.kind} id={entry.id} name={entry.name} avatar={entry.avatar} size={22} />{/snippet}
          {#snippet aside()}{/snippet}
        </AgentRow>
      {/each}
    </section>
  {/if}
  {#if needle && !rows.length && !found.length}<p class="agent-empty">{labels.noMatch}</p>{/if}

  {#snippet lead()}
    <!-- The thread list's machine button: every machine, or one. -->
    <MachineStatus store={view.store} {filter} onfilter={narrow} testid="agents-machine" />
  {/snippet}

  {#snippet foot()}
    {#if view.store.owner}<button type="button" class="ghost icon" class:active={active === 'engine'} title={labels.engineSettings} aria-label={labels.engineSettings} onclick={() => onfocus({ kind: 'engine' })} data-testid="agents-engine"><Settings2 size={16} /></button>{/if}
  {/snippet}
</RailFrame>
