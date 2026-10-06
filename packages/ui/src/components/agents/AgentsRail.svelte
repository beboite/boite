<script lang="ts">
  import { Bell, Bot, CalendarClock, Ellipsis, MessageSquare, Plus, Search, Settings, Settings2, UserRoundPlus, Users, X } from '@lucide/svelte';
  import type { AgentRoutine, ThreadSummary } from '@boite/contracts';
  import { chatKey, previewOf, type AgentChat, type AgentEntryKind, type AgentFocus, type AgentsView, type RailMode } from '../../lib/agents.svelte';
  import { formatLocale } from '../../lib/i18n.svelte';
  import { dayOffset, describeSchedule, routineState } from '../../lib/schedule';
  import { separator, type MenuItem } from '../../lib/menu';
  import { fill, strings } from '../../lib/strings';
  import { workspace } from '../../lib/workspace.svelte';
  import Menu from '../Menu.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import AgentRow from './AgentRow.svelte';

  /**
   * The list beside an agent's page, built like the thread list beside a
   * thread: two views at the top (the agents, and what they have planned),
   * the same rows in the same cards, the same launchers at the foot.
   */
  let { view, chats, active, attention, live, mode, onmode, onfocus, oncreate }: {
    view: AgentsView;
    chats: AgentChat[];
    /** The row the open page belongs to, `kind:id`. */
    active: string | null;
    attention: number;
    /** The thread each row's agents work in now, by row key. */
    live: Map<string, ThreadSummary>;
    mode: RailMode;
    onmode: (mode: RailMode) => void;
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
  const agents = $derived(shown.filter(c => c.kind === 'profile'));
  const groups = $derived(shown.filter(c => c.kind !== 'profile'));
  /** A search also reaches what the list leaves out: archived agents and missions. */
  const found = $derived(needle && snapshot ? [
    ...snapshot.profiles.filter(a => a.status === 'archived' && a.name.toLowerCase().includes(needle)).map(a => ({ kind: 'profile' as const, id: a.id, name: a.name, avatar: a.avatar, state: labels.archived })),
    ...snapshot.missions.filter(m => m.title.toLowerCase().includes(needle)).map(m => ({ kind: 'mission' as const, id: m.id, name: m.title, avatar: '', state: labels[m.status] }))
  ] : []);
  const working = $derived(snapshot?.work.filter(w => w.status === 'running').length ?? 0);
  const queued = $derived(snapshot?.work.filter(w => w.status === 'pending').length ?? 0);
  const paused = $derived(snapshot?.limits.paused ?? false);

  /** Routines by when they run next: today, tomorrow, this week, later, then paused and done. */
  const buckets = $derived.by(() => {
    const all = [...(snapshot?.routines ?? [])].filter(r => profiles.get(r.agentId)?.status !== 'archived');
    const by: Record<'today' | 'tomorrow' | 'week' | 'later' | 'paused' | 'done', AgentRoutine[]> = { today: [], tomorrow: [], week: [], later: [], paused: [], done: [] };
    for (const routine of all) {
      const state = routineState(routine).kind;
      if (state !== 'next') { by[state].push(routine); continue; }
      const day = dayOffset(routine.nextAt!, now);
      by[day <= 0 ? 'today' : day === 1 ? 'tomorrow' : day < 7 ? 'week' : 'later'].push(routine);
    }
    for (const list of Object.values(by)) list.sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || b.updatedAt - a.updatedAt);
    return (Object.keys(by) as (keyof typeof by)[]).filter(key => by[key].length).map(key => ({ key, routines: by[key] }));
  });

  const machine = $derived(workspace.machines.find(m => m.store === view.store));
  const multi = $derived(workspace.machines.length > 1);
  const machines = $derived<MenuItem[]>(workspace.machines.map(m => ({ id: m.id, label: m.label, active: m.store === view.store })));
  const createItems = $derived<MenuItem[]>([{ id: 'profile', label: labels.newTitle.profile, glyph: UserRoundPlus }, { id: 'group', label: labels.newTitle.group, glyph: Users }, separator(), { id: 'routine', label: labels.when.newRoutine, glyph: CalendarClock }]);

  function memberList(chat: AgentChat) {
    return chat.members.flatMap(id => profiles.get(id) ?? []);
  }
  /** What the row's agent does now, else the last word said, else what comes next, else its role. */
  function detail(chat: AgentChat): string {
    const thread = live.get(chatKey(chat.kind, chat.id));
    if (thread) {
      const work = snapshot?.work.find(w => w.runId && snapshot.runs.some(r => r.id === w.runId && r.threadId === thread.id) && !['done', 'cancelled'].includes(w.status));
      const routine = work ? snapshot?.routines.find(r => r.lastWorkId === work.id) : undefined;
      if (routine) return routine.name;
      if (work) return previewOf(work.prompt);
    }
    const last = chat.last;
    if (last) {
      const text = previewOf(last.text);
      const sender = last.senderId === null ? labels.user : chat.kind === 'profile' ? '' : profiles.get(last.senderId)?.name ?? '';
      return sender ? fill(labels.previewFrom, { name: sender, text }) : text;
    }
    if (chat.kind === 'profile') {
      const next = snapshot?.routines.filter(r => r.agentId === chat.id && r.enabled && r.nextAt !== null).sort((a, b) => a.nextAt! - b.nextAt!)[0];
      if (next) return `${routineState(next).text} · ${next.name}`;
      return profiles.get(chat.id)?.domain ?? '';
    }
    return memberList(chat).map(a => a.name).join(', ');
  }
  function pickMachine(id: string) {
    const target = workspace.machines.find(m => m.id === id);
    if (target) void workspace.select(target.store).then(() => target.store.showAgents());
  }
  function create(id: string) {
    if (id === 'routine') { onmode('planning'); onfocus({ kind: 'planning' }); return; }
    oncreate(id as AgentEntryKind);
  }
  function closeSearch() { searching = false; query = ''; }
</script>

{#snippet chatRow(chat: AgentChat)}
  {@const key = chatKey(chat.kind, chat.id)}
  {@const thread = live.get(key) ?? null}
  <AgentRow title={chat.name} open={active === key} unread={chat.unread} live={thread} waiting={chat.attention > 0 || chat.status === 'waiting'} at={chat.at} {now} detail={detail(chat)} testid="agent-entry-{chat.id}" onclick={() => onfocus({ kind: chat.kind, id: chat.id })}>
    {#snippet picture()}<AgentAvatar kind={chat.kind} id={chat.id} name={chat.name} avatar={chat.avatar} members={memberList(chat)} status={thread?.status === 'waiting' || chat.attention ? 'waiting' : thread ? 'running' : 'idle'} size={22} />{/snippet}
  </AgentRow>
{/snippet}

<aside class="agents-rail" aria-label={labels.heading}>
  <div class="agents-views">
    <div class="toolbar" role="tablist" aria-label={labels.heading}>
      <button type="button" class="ghost small view" class:chosen={mode === 'agents'} role="tab" aria-selected={mode === 'agents'} onclick={() => onmode('agents')} data-testid="agents-view-agents"><Bot size={14} />{labels.profiles}</button>
      <button type="button" class="ghost small view" class:chosen={mode === 'planning'} role="tab" aria-selected={mode === 'planning'} onclick={() => onmode('planning')} data-testid="agents-view-planning"><CalendarClock size={14} />{labels.planning}</button>
    </div>
    <div class="tools">
      {#if attention}
        <button type="button" class="ghost small needs" class:active={active === 'attention'} aria-current={active === 'attention' ? 'page' : undefined} onclick={() => onfocus({ kind: 'attention' })} data-testid="agents-attention">
          <Bell size={13} />{labels.attention}<span class="count">{attention}</span>
        </button>
      {:else if multi}
        <Menu items={machines} onpick={pickMachine} label={strings.machines.heading} placement="bottom" variant="text" testid="agents-machine">{machine?.label ?? view.store.core?.hostname ?? strings.machines.local}</Menu>
      {/if}
      <div class="actions">
        {#if mode === 'agents'}
          <button type="button" class="ghost icon small" class:active={searching} aria-pressed={searching} title={labels.search} aria-label={labels.search} onclick={() => (searching ? closeSearch() : (searching = true))} data-testid="agents-search-toggle"><Search size={15} /></button>
        {/if}
        {#if view.store.owner}
          {#if mode === 'agents'}
            <Menu placement="bottom" align="end" variant="ghost" label={labels.create} testid="agents-create" items={createItems} onpick={create}><Plus size={16} /></Menu>
          {:else}
            <button type="button" class="ghost icon small" class:active={active === 'planning'} title={labels.when.newRoutine} aria-label={labels.when.newRoutine} onclick={() => onfocus({ kind: 'planning' })} data-testid="agents-plan"><Plus size={16} /></button>
          {/if}
        {/if}
      </div>
    </div>
  </div>

  {#if searching && mode === 'agents'}
    <label class="agents-search"><Search size={14} strokeWidth={1.75} />
      <!-- svelte-ignore a11y_autofocus -->
      <input type="search" bind:value={query} aria-label={labels.search} placeholder={labels.search} autofocus onkeydown={e => { if (e.key === 'Escape') closeSearch(); }} />
      <button type="button" class="ghost icon small" aria-label={labels.close} onclick={closeSearch}><X size={13} /></button>
    </label>
  {/if}

  <div class="agents-scroll">
    {#if mode === 'agents'}
      {#if agents.length}
        <section class="agents-card" aria-label={labels.profiles}>
          {#each agents as chat (chatKey(chat.kind, chat.id))}{@render chatRow(chat)}{/each}
        </section>
      {/if}
      {#if groups.length}
        <section class="agents-card" aria-label={labels.groups}>
          <h2 class="agents-card-head"><Users size={13} />{labels.groups}</h2>
          {#each groups as chat (chatKey(chat.kind, chat.id))}{@render chatRow(chat)}{/each}
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
    {:else}
      {#each buckets as bucket (bucket.key)}
        <section class="agents-card" aria-label={labels.when.buckets[bucket.key]}>
          <h2 class="agents-card-head">{labels.when.buckets[bucket.key]}</h2>
          {#each bucket.routines as routine (routine.id)}
            {@const agent = profiles.get(routine.agentId)}
            {@const standing = routineState(routine)}
            <AgentRow title={routine.name} open={active === `routine:${routine.id}`} at={routine.updatedAt} {now} detail={`${agent?.name ?? ''} · ${describeSchedule(routine.schedule)}`} testid="routine-entry-{routine.id}" onclick={() => onfocus({ kind: 'routine', id: routine.id })}>
              {#snippet picture()}<AgentAvatar kind="profile" id={routine.agentId} name={agent?.name ?? ''} avatar={agent?.avatar} size={22} />{/snippet}
              {#snippet aside()}<span class="next-time" data-state={standing.kind}>{standing.kind === 'next' && routine.nextAt ? new Date(routine.nextAt).toLocaleTimeString(formatLocale(), { hour: 'numeric', minute: '2-digit' }) : standing.text}</span>{/snippet}
            </AgentRow>
          {/each}
        </section>
      {:else}
        <div class="agents-rail-empty">
          <CalendarClock size={22} strokeWidth={1.5} />
          <p>{labels.when.nothingPlanned}</p>
          {#if view.store.owner && snapshot?.profiles.length}<button type="button" class="small" onclick={() => onfocus({ kind: 'planning' })}>{labels.when.newRoutine}</button>{/if}
        </div>
      {/each}
    {/if}
  </div>

  <div class="agents-foot">
    <span class="agents-summary" title={paused ? labels.paused : fill(labels.summary, { running: String(working), pending: String(queued) })}>
      {#if paused}<i data-status="paused"></i>{labels.paused}
      {:else if working || queued}<i data-status="running"></i>{fill(labels.summary, { running: String(working), pending: String(queued) })}{/if}
    </span>
    {#if view.store.owner}<button type="button" class="ghost icon" class:active={active === 'engine'} title={labels.engineSettings} aria-label={labels.engineSettings} onclick={() => onfocus({ kind: 'engine' })} data-testid="agents-engine"><Settings2 size={16} /></button>{/if}
    {#if multi && attention}
      <Menu items={machines} onpick={pickMachine} label={strings.machines.heading} placement="top" align="end" variant="ghost" testid="agents-more"><Ellipsis size={16} /></Menu>
    {/if}
    <button type="button" class="ghost icon" title={labels.back} aria-label={labels.back} onclick={() => view.store.showChat()} data-testid="agents-leave"><MessageSquare size={16} /></button>
    <button type="button" class="ghost icon" title={strings.sidebar.settings} aria-label={strings.sidebar.settings} onclick={() => view.store.showSettings()}><Settings size={16} /></button>
  </div>
</aside>
