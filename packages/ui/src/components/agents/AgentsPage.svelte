<script lang="ts">
  import { onMount, untrack, type Component } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { ArrowLeft, Bot, Brain, CalendarClock, Ellipsis, History, Settings2, Target, Users } from '@lucide/svelte';
  import type { AgentScope } from '@boite/contracts';
  import { AgentsView, agentChats, attentionOf, chatKey, missionHome, missionPreset, missionsOf, type AgentChat, type AgentEntryKind, type AgentFocus, type AgentSelection } from '../../lib/agents.svelte';
  import { mobileOverlay } from '../../lib/mobile-history';
  import type { Store } from '../../lib/store.svelte';
  import { fill, strings } from '../../lib/strings';
  import Menu from '../Menu.svelte';
  import InfoTip from '../InfoTip.svelte';
  import AgentsRail from './AgentsRail.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import AgentEditor from './AgentEditor.svelte';
  import AgentConversation from './AgentConversation.svelte';
  import AgentMembers from './AgentMembers.svelte';
  import AgentMissions from './AgentMissions.svelte';
  import AgentMissionView from './AgentMissionView.svelte';
  import AgentWorkCard from './AgentWorkCard.svelte';
  import AgentKnowledge from './AgentKnowledge.svelte';
  import AgentRuntimeSettings from './AgentRuntimeSettings.svelte';
  import AgentBrainEditor from './AgentBrainEditor.svelte';
  import AgentRoutines from './AgentRoutines.svelte';
  import AgentEngineSettings from './AgentEngineSettings.svelte';
  import './agents.css';

  type Pane = 'conversation' | 'members' | 'missions' | 'activity' | 'memory' | 'routines' | 'settings' | 'tasks';
  type Creating = { kind: AgentEntryKind; preset?: { memberIds: string[]; teamId: string | null }; from?: AgentSelection | null };

  let { store }: { store: Store } = $props();
  const view = new AgentsView(untrack(() => store));
  const narrow = new MediaQuery('(max-width: 720px)');
  let chosen = $state<AgentFocus | null>(null);
  let creating = $state<Creating | null>(null);
  /** The pane beside the conversation the header opened; null is the record's first pane. */
  let pane = $state<Pane | null>(null);
  /** The conversation a mission was opened from: its back arrow returns there. */
  let origin = $state<AgentSelection | null>(null);

  const labels = $derived(strings.agents);
  const icons: Record<Pane, Component<{ size?: number; strokeWidth?: number }>> = { conversation: Users, members: Users, missions: Target, activity: History, memory: Brain, routines: CalendarClock, settings: Settings2, tasks: Target };
  const snapshot = $derived(view.snapshot);
  const attention = $derived(snapshot ? attentionOf(snapshot, store.threads) : { work: [], review: [] });
  const chats = $derived(snapshot ? agentChats(snapshot, view.seen.messages, view.readAt, attention) : []);
  /**
   * A team folded into its group opens as that group, and a record that is gone
   * lets go. A desktop opens on the newest conversation, a phone on the list.
   */
  const focus = $derived.by<AgentFocus | null>(() => {
    const next = chosen;
    if (next?.kind === 'team') {
      const host = chats.find(c => c.kind === 'group' && c.teamId === next.id);
      if (host) return { kind: 'group', id: host.id };
    }
    if (next && (!('id' in next) || exists(next))) return next;
    return !narrow.current && chats[0] ? { kind: chats[0].kind, id: chats[0].id } : null;
  });
  function exists(next: AgentSelection): boolean {
    const list: { id: string }[] = !snapshot ? [] : next.kind === 'profile' ? snapshot.profiles : next.kind === 'group' ? snapshot.groups : next.kind === 'team' ? snapshot.teams : snapshot.missions;
    return !snapshot || list.some(r => r.id === next.id);
  }
  const selected = $derived(focus && 'id' in focus ? focus : null);
  const chat = $derived(selected && selected.kind !== 'mission' ? chats.find(c => c.kind === selected.kind && c.id === selected.id) ?? null : null);
  const profile = $derived(selected?.kind === 'profile' ? snapshot?.profiles.find(a => a.id === selected.id) ?? null : null);
  const group = $derived(selected?.kind === 'group' ? snapshot?.groups.find(g => g.id === selected.id) ?? null : null);
  const team = $derived(selected?.kind === 'team' ? snapshot?.teams.find(t => t.id === selected.id) ?? null : group && chat?.teamId ? snapshot?.teams.find(t => t.id === chat.teamId) ?? null : null);
  const mission = $derived(selected?.kind === 'mission' ? snapshot?.missions.find(m => m.id === selected.id) ?? null : null);
  const record = $derived(profile ?? group ?? team ?? mission);
  const title = $derived(profile?.name ?? group?.name ?? team?.name ?? mission?.title ?? '');
  /** An archived agent, opened from a search, has no row: it reads as one of its own. */
  const partner = $derived<Pick<AgentChat, 'kind' | 'id' | 'teamId' | 'members'> | null>(chat ?? (profile ? { kind: 'profile', id: profile.id, teamId: null, members: [profile.id] } : null));
  const members = $derived((partner?.members ?? mission?.agentIds ?? []).flatMap(id => snapshot?.profiles.find(a => a.id === id) ?? []));
  const parent = $derived.by<AgentSelection | null>(() => {
    if (!mission || !snapshot) return null;
    if (origin) return origin;
    const key = missionHome(snapshot, mission);
    const home = chats.find(c => chatKey(c.kind, c.id) === key);
    return home ? { kind: home.kind, id: home.id } : null;
  });
  const parentName = $derived(parent ? chats.find(c => c.kind === parent.kind && c.id === parent.id)?.name ?? snapshot?.profiles.find(a => a.id === parent.id)?.name ?? '' : '');
  const active = $derived(creating ? (creating.from ? `${creating.from.kind}:${creating.from.id}` : null) : focus?.kind === 'attention' ? 'attention' : selected?.kind === 'mission' ? (parent ? `${parent.kind}:${parent.id}` : null) : selected ? `${selected.kind}:${selected.id}` : null);

  const panes = $derived.by<Pane[]>(() => {
    const all: Pane[] = selected?.kind === 'profile' ? ['conversation', 'missions', 'activity', 'memory', 'routines', 'settings']
      : selected?.kind === 'group' ? ['conversation', 'members', 'missions', 'activity', 'memory', 'settings']
      : selected?.kind === 'team' ? ['members', 'missions', 'activity', 'memory', 'settings']
      : ['tasks', 'activity', 'memory', 'settings'];
    return all.filter(p => p !== 'settings' || store.owner);
  });
  const current = $derived(pane && panes.includes(pane) ? pane : panes[0]!);
  const status = $derived.by<{ text: string; tone?: 'running' | 'waiting' }>(() => {
    if (mission) return { text: labels[mission.status], tone: mission.status === 'active' ? 'running' : mission.status === 'review' || mission.status === 'waiting' ? 'waiting' : undefined };
    const now = chat?.status ?? (profile?.status === 'paused' ? 'paused' : 'idle');
    if (now === 'running' || now === 'waiting') return { text: labels[now], tone: now };
    if (profile?.status === 'archived') return { text: labels.archived };
    if (now === 'paused') return { text: labels.paused };
    return { text: profile ? labels.idle : members.map(a => a.name).join(', ') };
  });

  const missions = $derived(snapshot && partner ? missionsOf(snapshot, partner) : []);
  const teamMissions = $derived(team && snapshot ? snapshot.missions.filter(m => m.teamId === team.id) : []);
  const scopes = $derived<AgentScope[]>([
    ...(group ? [{ kind: 'group' as const, id: group.id }] : []),
    ...(mission ? [{ kind: 'mission' as const, id: mission.id }] : teamMissions.map(m => ({ kind: 'mission' as const, id: m.id })))
  ]);
  const work = $derived(view.seen.work.filter(w => profile ? w.agentId === profile.id : scopes.some(s => s.kind === w.scope.kind && s.id === w.scope.id)).reverse());
  /** The history page the activity pane asks for: the same filter as `work`. */
  const workHistory = $derived<{ kind: 'work'; agentId?: string; scopes?: AgentScope[] } | null>(profile ? { kind: 'work', agentId: profile.id } : scopes.length ? { kind: 'work', scopes } : null);
  const workKey = $derived(selected ? `work:${selected.kind}:${selected.id}` : '');
  const conversation = $derived<AgentScope | null>(chat?.scope ?? (profile ? { kind: 'agent', id: profile.id } : null));
  const memoryScope = $derived<AgentScope | null>(profile ? { kind: 'agent', id: profile.id } : group ? { kind: 'group', id: group.id } : team ? { kind: 'team', id: team.id } : mission ? { kind: 'mission', id: mission.id } : null);
  const backLabel = $derived(narrow.current && current !== panes[0] ? labels.backToChat : parent ? fill(labels.backTo, { name: parentName }) : labels.list);

  /**
   * On a phone every level past the list holds one history entry: the
   * conversation, a pane, a mission, a form. Back steps out one level, and the
   * next level pushes its own entry.
   */
  const level = $derived(narrow.current && (chosen || creating) ? `${creating ? 'new' : ''}|${focus?.kind}:${selected?.id ?? ''}|${current}` : '');
  $effect(() => { if (level) return mobileOverlay(back); });

  onMount(() => { view.start(); return () => view.close(); });
  // On a phone an open conversation hides the tab bar. The root carries it as a
  // class: `.app:has(.agents-page.detail-open)` made the whole app a `:has()`
  // subject, rechecked on every node mounted anywhere.
  $effect(() => {
    const root = document.documentElement;
    root.classList.toggle('agents-detail-open', !!chosen || !!creating);
    return () => root.classList.remove('agents-detail-open');
  });
  $effect(() => { if (store.connection === 'ready') void view.refresh(); });
  $effect(() => { if (current === 'activity' && workHistory) view.fill(workKey, workHistory, work); });

  function open(next: AgentFocus, from: AgentSelection | null = null) {
    chosen = next;
    creating = null;
    pane = null;
    origin = from;
  }
  /** One step out: a form, a pane, a mission (back to the missions it was opened from), then the list. */
  function back() {
    if (creating) creating = null;
    else if (current !== panes[0]) pane = null;
    else if (parent) { const from = origin; open(parent); if (from) pane = 'missions'; }
    else { chosen = null; origin = null; }
  }
  function toggle(next: Pane) { pane = current === next ? null : next; }
  function startMission() {
    if (!snapshot || !partner || !selected) return;
    creating = { kind: 'mission', preset: missionPreset(snapshot, partner), from: selected };
  }
</script>

{#snippet backButton(label: string)}
  <button type="button" class="ghost icon agent-mobile-back" aria-label={label} title={label} onclick={back}><ArrowLeft size={18} strokeWidth={1.75} /></button>
{/snippet}

{#snippet simpleHead(heading: string, tip?: string)}
  <header class="agents-detail-head">
    {#if narrow.current}{@render backButton(labels.list)}{/if}
    <h2 class="agents-detail-heading">{heading}{#if tip}<InfoTip topic={heading} text={tip} />{/if}</h2>
  </header>
{/snippet}

<section class="agents-page" class:detail-open={!!chosen || !!creating} class:empty={!!snapshot && !chats.length} data-testid="agents-page">
  <AgentsRail {view} {chats} {active} attention={attention.work.length + attention.review.length} onfocus={next => open(next)} oncreate={kind => { creating = { kind }; }} />

  <main class="agents-main framed">
    {#if view.error || view.loadError}
      <div class="agent-error" role="alert">{view.error || view.loadError}<button type="button" class="ghost small" onclick={() => { view.error = ''; void view.refresh(); }}>{labels.retry}</button></div>
    {/if}
    {#if snapshot && store.connection !== 'ready'}<p class="agent-error" role="status">{labels.stale}</p>{/if}

    {#if !snapshot}
      <p class="agent-empty">{view.error || view.loadError ? labels.offline : strings.app.loading}</p>
    {:else if creating}
      <header class="agents-detail-head">
        {#if narrow.current || creating.from}{@render backButton(creating.from ? labels.backToChat : labels.list)}{/if}
        <h2 class="agents-detail-heading">{labels.newTitle[creating.kind]}</h2>
      </header>
      <div class="agents-body">
        {#key creating}<AgentEditor {view} kind={creating.kind} preset={creating.preset} ondone={next => open(next, creating?.from ?? null)} oncancel={() => { creating = null; }} />{/key}
      </div>
    {:else if focus?.kind === 'attention'}
      {@render simpleHead(labels.attention)}
      <div class="agents-body">
        {#each attention.work as item (item.id)}<AgentWorkCard {view} work={item} />{/each}
        {#each attention.review as task (task.id)}
          <button type="button" class="agent-link-row" onclick={() => open({ kind: 'mission', id: task.missionId })}>{task.title}<span class="agent-state" data-status="review">{labels.review}</span></button>
        {/each}
        {#if !attention.work.length && !attention.review.length}<p class="agent-empty">{labels.noAttention}</p>{/if}
      </div>
    {:else if focus?.kind === 'engine'}
      {@render simpleHead(labels.engineSettings, labels.engineSettingsHint)}
      <div class="agents-body"><AgentEngineSettings {view} /></div>
    {:else if selected && record}
      <header class="agents-detail-head">
        {#if narrow.current || parent}{@render backButton(backLabel)}{/if}
        <button type="button" class="ghost agents-identity" onclick={() => { pane = null; }} aria-label={title}>
          <AgentAvatar kind={selected.kind} id={selected.id} name={title} avatar={profile?.avatar} {members} status={chat?.status ?? 'idle'} size={36} />
          <span class="agents-identity-text">
            <strong>{title}</strong>
            <small data-status={status.tone}>{status.text}</small>
          </span>
        </button>
        {#if narrow.current}
          {#if panes.length > 1}
            <Menu placement="bottom" align="end" variant="ghost" label={labels.more} testid="agent-panes" items={panes.slice(1).map(p => ({ id: p, label: labels[p], glyph: icons[p], active: current === p }))} onpick={id => toggle(id as Pane)}>
              <Ellipsis size={18} strokeWidth={1.75} />
            </Menu>
          {/if}
        {:else}
          <nav class="agents-actions" aria-label={title}>
            {#each panes.slice(1) as item (item)}
              {@const Icon = icons[item]}
              <button type="button" class="ghost icon" class:active={current === item} aria-pressed={current === item} aria-label={labels[item]} title={labels[item]} onclick={() => toggle(item)} data-testid="agent-tab-{item}"><Icon size={16} strokeWidth={1.75} /></button>
            {/each}
          </nav>
        {/if}
      </header>
      {#key `${selected.kind}:${selected.id}:${current}`}
        <div class="agents-body" class:chat={current === 'conversation'}>
          {#if current === 'conversation' && conversation}
            <AgentConversation {view} scope={conversation} />
          {:else if current === 'members' && partner}
            <AgentMembers {view} memberIds={partner.members} {group} {team} onopen={id => open({ kind: 'profile', id })} />
          {:else if current === 'missions'}
            <AgentMissions {view} {missions} onopen={id => open({ kind: 'mission', id }, selected)} oncreate={startMission} />
          {:else if current === 'activity'}
            {#each work as item (item.id)}<AgentWorkCard {view} work={item} />{:else}<p class="agent-empty">{labels.noWork}</p>{/each}
            {#if workHistory && view.hasOlder(workKey, 'work')}<button type="button" class="ghost small agent-older" disabled={view.loadingOlder === workKey} onclick={() => void view.loadOlder(workKey, workHistory, work)} data-testid="agent-work-older">{labels.loadEarlier}</button>{/if}
          {:else if current === 'memory' && memoryScope}
            {#if profile}<AgentBrainEditor {view} agentId={profile.id} />{/if}
            <AgentKnowledge {view} scope={memoryScope} />
            {#if group && team}
              <h3 class="section-label">{team.name}</h3>
              <AgentKnowledge {view} scope={{ kind: 'team', id: team.id }} />
            {/if}
          {:else if current === 'routines' && profile}
            <AgentRoutines {view} agentId={profile.id} />
          {:else if current === 'settings'}
            <AgentEditor {view} kind={selected.kind} {record} embedded ondone={() => {}} oncancel={() => {}} />
            {#if profile}<AgentRuntimeSettings {view} agent={profile} />{/if}
            {#if group && team}{#key team.id}<AgentEditor {view} kind="team" record={team} heading={team.name} embedded ondone={() => {}} oncancel={() => {}} />{/key}{/if}
          {:else if current === 'tasks' && mission}
            <AgentMissionView {view} {mission} />
          {/if}
        </div>
      {/key}
    {:else}
      <div class="agent-welcome" data-testid="agents-empty">
        <Bot size={32} strokeWidth={1.5} />
        <p>{labels.noAgents}</p>
        {#if store.owner}<button type="button" class="primary" onclick={() => { creating = { kind: 'profile' }; }} data-testid="agents-first">{labels.createAgent}</button>{/if}
      </div>
    {/if}
  </main>
</section>
