<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { ArrowLeft, Bot } from '@lucide/svelte';
  import type { AgentScope } from '@boite/contracts';
  import { AgentsView, attentionOf, type AgentEntryKind, type AgentFocus } from '../../lib/agents.svelte';
  import type { Store } from '../../lib/store.svelte';
  import { fill, strings } from '../../lib/strings';
  import AgentsRail from './AgentsRail.svelte';
  import AgentEditor from './AgentEditor.svelte';
  import AgentConversation from './AgentConversation.svelte';
  import AgentMissionView from './AgentMissionView.svelte';
  import AgentWorkCard from './AgentWorkCard.svelte';
  import AgentKnowledge from './AgentKnowledge.svelte';
  import AgentRuntimeSettings from './AgentRuntimeSettings.svelte';
  import AgentBrainEditor from './AgentBrainEditor.svelte';
  import AgentRoutines from './AgentRoutines.svelte';
  import AgentEngineSettings from './AgentEngineSettings.svelte';
  import './agents.css';

  type Tab = 'conversation' | 'overview' | 'tasks' | 'activity' | 'memory' | 'routines' | 'settings';

  let { store }: { store: Store } = $props();
  const view = new AgentsView(untrack(() => store));
  const narrow = new MediaQuery('(max-width: 720px)');
  let chosen = $state<AgentFocus | null>(null);
  let creating = $state<AgentEntryKind | null>(null);
  let tab = $state<Tab>('conversation');

  const labels = $derived(strings.agents);
  const snapshot = $derived(view.snapshot);
  /** A desktop opens on the first agent rather than on an empty pane; a phone opens on the list. */
  const focus = $derived<AgentFocus | null>(chosen ?? (!narrow.current && snapshot?.profiles[0] ? { kind: 'profile', id: snapshot.profiles[0].id } : null));
  const selected = $derived(focus && 'id' in focus ? focus : null);
  const profile = $derived(selected?.kind === 'profile' ? snapshot?.profiles.find(a => a.id === selected.id) ?? null : null);
  const group = $derived(selected?.kind === 'group' ? snapshot?.groups.find(g => g.id === selected.id) ?? null : null);
  const team = $derived(selected?.kind === 'team' ? snapshot?.teams.find(t => t.id === selected.id) ?? null : null);
  const mission = $derived(selected?.kind === 'mission' ? snapshot?.missions.find(m => m.id === selected.id) ?? null : null);
  const record = $derived(profile ?? group ?? team ?? mission);
  const title = $derived(profile?.name ?? group?.name ?? team?.name ?? mission?.title ?? '');
  const scope = $derived<AgentScope | null>(selected ? { kind: selected.kind === 'profile' ? 'agent' : selected.kind, id: selected.id } : null);
  const attention = $derived(snapshot ? attentionOf(snapshot, store.threads) : { work: [], review: [] });
  const tabs = $derived.by<Tab[]>(() => {
    const all: Tab[] = selected?.kind === 'profile' ? ['conversation', 'activity', 'memory', 'routines', 'settings']
      : selected?.kind === 'group' ? ['conversation', 'activity', 'memory', 'settings']
      : selected?.kind === 'team' ? ['overview', 'activity', 'memory', 'settings']
      : ['tasks', 'activity', 'memory', 'settings'];
    return all.filter(t => t !== 'settings' || store.owner);
  });
  const current = $derived(tabs.includes(tab) ? tab : tabs[0]!);
  const meta = $derived(
    profile ? [profile.domain, store.providerOf(profile.selection.providerId)?.name, profile.selection.model].filter(Boolean).join(' · ')
    : group ? `${labels[group.mode]} · ${fill(labels.memberCount, { count: String(group.memberIds.length) })}`
    : team ? team.description
    : mission ? labels[mission.status] : ''
  );
  const running = $derived(profile ? snapshot?.work.some(w => w.agentId === profile.id && w.status === 'running') : false);
  const work = $derived(snapshot?.work.filter(w =>
    profile ? w.agentId === profile.id
    : group ? w.scope.kind === 'group' && w.scope.id === group.id
    : mission ? w.scope.kind === 'mission' && w.scope.id === mission.id
    : team ? snapshot.missions.some(m => m.teamId === team.id && w.scope.kind === 'mission' && w.scope.id === m.id)
    : false).toReversed() ?? []);
  const missions = $derived(snapshot?.missions.filter(m => profile ? m.agentIds.includes(profile.id) : team ? m.teamId === team.id : false) ?? []);

  onMount(() => { view.start(); return () => view.close(); });
  $effect(() => { if (store.connection === 'ready') void view.refresh(); });

  function open(next: AgentFocus) {
    chosen = next;
    creating = null;
    tab = next.kind === 'team' ? 'overview' : next.kind === 'mission' ? 'tasks' : 'conversation';
  }
  function back() { chosen = null; creating = null; }
</script>

<section class="agents-page" class:detail-open={!!chosen || !!creating} data-testid="agents-page">
  <AgentsRail {view} focus={creating ? null : focus} attention={attention.work.length + attention.review.length} onfocus={open} oncreate={kind => { creating = kind; }} />

  <main class="agents-main">
    {#if view.error || view.loadError}
      <div class="agent-error" role="alert">{view.error || view.loadError}<button type="button" class="ghost small" onclick={() => { view.error = ''; void view.refresh(); }}>{labels.retry}</button></div>
    {/if}
    {#if snapshot && store.connection !== 'ready'}<p class="agent-error" role="status">{labels.stale}</p>{/if}

    {#if !snapshot}
      <p class="agent-empty">{view.error || view.loadError ? labels.offline : strings.app.loading}</p>
    {:else if creating}
      <div class="agents-body">
        <button type="button" class="ghost small agent-mobile-back" onclick={back}><ArrowLeft size={14} />{labels.list}</button>
        {#key creating}<AgentEditor {view} kind={creating} ondone={open} oncancel={() => { creating = null; }} />{/key}
      </div>
    {:else if focus?.kind === 'attention'}
      <div class="agents-body">
        <button type="button" class="ghost small agent-mobile-back" onclick={back}><ArrowLeft size={14} />{labels.list}</button>
        <header class="agents-page-head"><h2>{labels.attention}</h2></header>
        {#each attention.work as item (item.id)}<AgentWorkCard {view} work={item} />{/each}
        {#each attention.review as task (task.id)}
          <button type="button" class="agent-link-row" onclick={() => open({ kind: 'mission', id: task.missionId })}>{task.title}<span class="agent-state" data-status="review">{labels.review}</span></button>
        {/each}
        {#if !attention.work.length && !attention.review.length}<p class="agent-empty">{labels.noAttention}</p>{/if}
      </div>
    {:else if focus?.kind === 'engine'}
      <div class="agents-body">
        <button type="button" class="ghost small agent-mobile-back" onclick={back}><ArrowLeft size={14} />{labels.list}</button>
        <AgentEngineSettings {view} />
      </div>
    {:else if selected && record && scope}
      <header class="agents-detail-head">
        <button type="button" class="ghost small agent-mobile-back" onclick={back}><ArrowLeft size={14} />{labels.list}</button>
        <div class="agents-detail-title">
          <span class="agent-avatar large" data-kind={selected.kind}>{title.slice(0, 1)}{#if profile}<i data-status={running ? 'running' : profile.status}></i>{/if}</span>
          <div>
            <h2>{title}</h2>
            {#if meta}<p>{meta}</p>{/if}
          </div>
        </div>
        <nav class="agents-tabs" aria-label={title}>
          {#each tabs as item (item)}
            <button type="button" class="ghost" class:active={current === item} aria-pressed={current === item} onclick={() => { tab = item; }} data-testid="agent-tab-{item}">{labels[item]}</button>
          {/each}
        </nav>
      </header>
      {#key `${selected.kind}:${selected.id}:${current}`}
        <div class="agents-body" class:chat={current === 'conversation'}>
          {#if current === 'conversation'}
            <AgentConversation {view} {scope} />
          {:else if current === 'activity'}
            {#if missions.length}
              <h3 class="section-label">{labels.missions}</h3>
              {#each missions as item (item.id)}
                <button type="button" class="agent-link-row" onclick={() => open({ kind: 'mission', id: item.id })}>{item.title}<span class="agent-state" data-status={item.status}>{labels[item.status]}</span></button>
              {/each}
              <h3 class="section-label">{labels.history}</h3>
            {/if}
            {#each work as item (item.id)}<AgentWorkCard {view} work={item} />{:else}<p class="agent-empty">{labels.noWork}</p>{/each}
          {:else if current === 'memory'}
            {#if profile}<AgentBrainEditor {view} agentId={profile.id} />{/if}
            <AgentKnowledge {view} {scope} />
          {:else if current === 'routines' && profile}
            <AgentRoutines {view} agentId={profile.id} />
          {:else if current === 'settings'}
            <AgentEditor {view} kind={selected.kind} {record} embedded ondone={() => {}} oncancel={() => {}} />
            {#if profile}<AgentRuntimeSettings {view} agent={profile} />{/if}
          {:else if current === 'tasks' && mission}
            <AgentMissionView {view} {mission} />
          {:else if team}
            <section class="card">
              <h2>{labels.members}</h2>
              {#each team.members as member (member.agentId)}
                <button type="button" class="agent-link-row" onclick={() => open({ kind: 'profile', id: member.agentId })}>{snapshot.profiles.find(a => a.id === member.agentId)?.name}<span class="muted">{member.responsibility}</span></button>
              {/each}
              {#if team.groupId}
                <button type="button" class="agent-link-row" onclick={() => open({ kind: 'group', id: team.groupId! })}>{snapshot.groups.find(g => g.id === team.groupId)?.name}<span class="muted">{labels.group}</span></button>
              {/if}
            </section>
            <section class="card">
              <h2>{labels.missions}</h2>
              {#each missions as item (item.id)}
                <button type="button" class="agent-link-row" onclick={() => open({ kind: 'mission', id: item.id })}>{item.title}<span class="agent-state" data-status={item.status}>{labels[item.status]}</span></button>
              {:else}<p class="hint">{labels.kindHints.mission}</p>{/each}
            </section>
          {/if}
        </div>
      {/key}
    {:else}
      <div class="agent-welcome">
        <Bot size={32} strokeWidth={1.5} />
        <h2>{labels.welcomeTitle}</h2>
        <p>{labels.welcomeBody}</p>
        <dl>
          {#each (['profile', 'group', 'team', 'mission'] as const) as kind (kind)}<div><dt>{labels.kinds[kind]}</dt><dd>{labels.kindHints[kind]}</dd></div>{/each}
        </dl>
        {#if store.owner}
          <button type="button" class="primary" onclick={() => { creating = 'profile'; }} data-testid="agents-first">{labels.newTitle.profile}</button>
        {:else}<p class="muted">{labels.readOnly}</p>{/if}
      </div>
    {/if}
  </main>
</section>
