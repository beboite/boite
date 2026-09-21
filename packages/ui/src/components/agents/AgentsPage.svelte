<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { ArrowLeft, Bot, Boxes, List, Plus, Search, Users } from '@lucide/svelte';
  import type { AgentScope } from '@boite/contracts';
  import { AgentsView, type AgentSelection, type AgentEntryKind } from '../../lib/agents.svelte';
  import type { Store } from '../../lib/store.svelte';
  import { strings } from '../../lib/strings';
  import { workspace } from '../../lib/workspace.svelte';
  import AgentEditor from './AgentEditor.svelte';
  import AgentConversation from './AgentConversation.svelte';
  import AgentMissionView from './AgentMissionView.svelte';
  import AgentWorkCard from './AgentWorkCard.svelte';
  import AgentKnowledge from './AgentKnowledge.svelte';
  import AgentsScene from './AgentsScene.svelte';
  import Menu from '../Menu.svelte';
  import { confirm } from '../../lib/confirm.svelte';
  import './agents.css';
  let { store }: { store: Store } = $props();
  const view = new AgentsView(untrack(() => store));
  let section = $state<AgentEntryKind | 'attention'>('profile');
  let selected = $state<AgentSelection | null>(null);
  let creating = $state<AgentEntryKind | null>(null);
  let editing = $state(false);
  let tab = $state<'conversation' | 'activity' | 'memory' | 'missions'>('conversation');
  let scene = $state(false);
  let search = $state('');
  const snapshot = $derived(view.snapshot);
  const profile = $derived(selected?.kind === 'profile' ? snapshot?.profiles.find(a => a.id === selected?.id) : null);
  const group = $derived(selected?.kind === 'group' ? snapshot?.groups.find(g => g.id === selected?.id) : null);
  const team = $derived(selected?.kind === 'team' ? snapshot?.teams.find(t => t.id === selected?.id) : null);
  const mission = $derived(selected?.kind === 'mission' ? snapshot?.missions.find(m => m.id === selected?.id) : null);
  const record = $derived(profile ?? group ?? team ?? mission ?? null);
  const title = $derived(profile?.name ?? group?.name ?? team?.name ?? mission?.title ?? '');
  const scope = $derived<AgentScope | null>(selected ? { kind: selected.kind === 'profile' ? 'agent' : selected.kind, id: selected.id } : null);
  const labels = $derived(strings.agents);
  const sections = $derived([{ id: 'profile', label: labels.profiles }, { id: 'group', label: labels.groups }, { id: 'team', label: labels.teams }, { id: 'mission', label: labels.missions }, { id: 'attention', label: labels.attention }] as const);
  const entries = $derived((section === 'profile' ? snapshot?.profiles.map(a => ({ id: a.id, name: a.name, hint: a.domain || labels[a.status] })) : section === 'group' ? snapshot?.groups.map(g => ({ id: g.id, name: g.name, hint: labels[g.mode] })) : section === 'team' ? snapshot?.teams.map(t => ({ id: t.id, name: t.name, hint: t.description })) : section === 'mission' ? snapshot?.missions.map(m => ({ id: m.id, name: m.title, hint: labels[m.status] })) : [])?.filter(e => `${e.name} ${e.hint}`.toLowerCase().includes(search.toLowerCase())) ?? []);
  const attention = $derived(snapshot?.work.filter(w => ['waiting', 'interrupted', 'error', 'paused'].includes(w.status) || w.status === 'running' && store.threads.some(t => t.agentSessionId && t.status === 'waiting' && snapshot.runs.some(r => r.id === w.runId && r.threadId === t.id))) ?? []);
  const review = $derived(snapshot?.tasks.filter(t => t.status === 'review') ?? []);
  const work = $derived(snapshot?.work.filter(w => profile ? w.agentId === profile.id : group ? w.scope.kind === 'group' && w.scope.id === group.id : mission ? w.scope.kind === 'mission' && w.scope.id === mission.id : team ? snapshot.missions.some(m => m.teamId === team.id && w.scope.kind === 'mission' && w.scope.id === m.id) : false).toReversed() ?? []);
  const missions = $derived(snapshot?.missions.filter(m => profile ? m.agentIds.includes(profile.id) : team ? m.teamId === team.id : false) ?? []);
  onMount(() => { view.start(); return () => view.close(); });
  $effect(() => { if (store.connection === 'ready') void view.refresh(); });
  function choose(selection: AgentSelection) { selected = selection; section = selection.kind; creating = null; editing = false; scene = false; tab = selection.kind === 'team' || selection.kind === 'mission' ? 'missions' : 'conversation'; }
  function category(next: typeof section) { section = next; selected = null; creating = null; editing = false; scene = false; }
  function create(kind: AgentEntryKind) { creating = kind; editing = false; scene = false; }
  async function stopEngine() {
    if (!await confirm.ask({ title: labels.stopEngine, body: labels.stopEngineBody, confirmLabel: labels.stopEngine, cancelLabel: labels.cancel, danger: true })) return;
    try { await store.client?.call('core.shutdown', {}); store.client?.close(); }
    catch (error) { view.error = error instanceof Error ? error.message : String(error); }
  }
</script>

<section class="agents-page" data-testid="agents-page">
  <header class="agents-heading">
    <button class="ghost icon" aria-label={labels.back} onclick={() => store.showChat()}><ArrowLeft size={19} /></button>
    <div><h1>{labels.heading}</h1><p class="muted">{labels.intro}</p></div>
    <div class="agent-actions">
      <Menu placement="bottom" label={strings.machines.heading} items={workspace.machines.map(m => ({ id: m.id, label: m.label, active: m.store === store }))} onpick={id => { const target = workspace.machines.find(m => m.id === id); if (target) void workspace.select(target.store).then(() => target.store.showAgents()); }}>{workspace.machines.find(m => m.store === store)?.label ?? store.core?.hostname ?? strings.machines.local}</Menu>
      <button class="ghost" class:active={scene} aria-pressed={scene} onclick={() => { scene = !scene; creating = null; editing = false; }} data-testid="agents-scene-toggle">{#if scene}<List size={16} />{labels.list}{:else}<Boxes size={16} />{labels.scene}{/if}</button>
      {#if store.owner}<Menu placement="bottom" label={labels.create} items={sections.filter(s => s.id !== 'attention').map(s => ({ id: s.id, label: s.label }))} onpick={id => create(id as AgentEntryKind)} testid="agents-create"><Plus size={16} />{labels.create}</Menu>{/if}
    </div>
  </header>
  {#if view.error || view.loadError}<div class="agent-error" role="alert">{view.error || view.loadError}<button class="ghost small" onclick={() => { view.error = ''; void view.refresh(); }}>{labels.retry}</button></div>{/if}
  {#if snapshot && store.connection !== 'ready'}<p class="agent-error" role="status">{labels.stale}</p>{/if}
  {#if !snapshot}<p class="agent-empty">{view.error || view.loadError ? labels.offline : strings.app.loading}</p>{:else}
    <div class="agents-overview"><span><i data-status="running"></i>{snapshot.work.filter(w => w.status === 'running').length} {labels.running.toLowerCase()}</span><span>{snapshot.work.filter(w => w.status === 'pending').length} {labels.pending.toLowerCase()}</span><button class="ghost small" onclick={() => category('attention')}>{attention.length + review.length} {labels.attention.toLowerCase()}</button><span class="muted">{snapshot.limits.paused ? labels.paused : labels.engineHint}</span></div>
    <div class="agents-layout" class:detail-open={!!selected || !!creating}>
      <aside class="agents-directory">
        <nav aria-label={labels.heading}>{#each sections as entry (entry.id)}<button class="ghost" class:active={section === entry.id} aria-current={section === entry.id ? 'page' : undefined} onclick={() => category(entry.id)} data-testid="agents-category-{entry.id}">{#if entry.id === 'profile'}<Bot size={16} />{:else}<Users size={16} />{/if}{entry.label}{#if entry.id === 'attention' && attention.length + review.length}<span class="agent-count">{attention.length + review.length}</span>{/if}</button>{/each}</nav>
        <div class="agents-search"><Search size={15} /><input type="search" bind:value={search} aria-label={labels.search} placeholder={labels.search} /></div>
        <div class="agents-entries">{#each entries as entry (entry.id)}<button class="ghost agent-entry" class:active={selected?.id === entry.id} onclick={() => { if (section !== 'attention') choose({ kind: section, id: entry.id }); }} data-testid="agent-entry-{entry.id}"><span class="agent-avatar">{entry.name.slice(0, 2)}</span><span><strong>{entry.name}</strong><small>{entry.hint}</small></span></button>{:else}{#if section !== 'attention'}<p class="agent-empty">{labels.empty}</p>{/if}{/each}</div>
        {#if store.owner}<details class="agent-background"><summary>{labels.backgroundSettings}</summary><form class="agents-form" onsubmit={event => { event.preventDefault(); }}>
          <label>{labels.concurrency}<input type="number" min="1" max="8" value={snapshot.limits.backgroundConcurrency} onchange={event => { void view.call('agents.limits.set', { ...snapshot.limits, backgroundConcurrency: Number(event.currentTarget.value) }); }} /></label>
          <label class="agent-check"><input type="checkbox" checked={snapshot.limits.paused} onchange={event => { void view.call('agents.limits.set', { ...snapshot.limits, paused: event.currentTarget.checked }); }} />{labels.paused}</label>
          <label class="agent-check"><input type="checkbox" checked={snapshot.limits.kebaccExperiment} onchange={event => { void view.call('agents.limits.set', { ...snapshot.limits, kebaccExperiment: event.currentTarget.checked }); }} />{labels.kebacc}</label><p class="muted">{labels.kebaccHint}</p>
          <button type="button" class="ghost" onclick={() => void stopEngine()}>{labels.stopEngine}</button>
        </form></details>{/if}
      </aside>
      <main class="agents-content">
        {#if creating || editing && selected}
          {@const kind = creating ?? selected!.kind}
          {#key `${kind}:${creating ? 'new' : selected?.id}`}<AgentEditor {view} {kind} record={creating ? null : record} ondone={choose} oncancel={() => { creating = null; editing = false; }} />{/key}
        {:else if scene}
          <AgentsScene {snapshot} onpick={choose} />
        {:else if section === 'attention'}
          <h2>{labels.attention}</h2>{#each attention as item (item.id)}<AgentWorkCard {view} work={item} />{/each}{#each review as task (task.id)}<button class="agent-review-link" onclick={() => choose({ kind: 'mission', id: task.missionId })}>{task.title} · {labels.review}</button>{/each}{#if !attention.length && !review.length}<p class="agent-empty">{labels.noAttention}</p>{/if}
        {:else if selected && record && scope}
          <div class="agent-detail-heading"><button class="ghost small agent-mobile-back" onclick={() => { selected = null; }}>{labels.list}</button><div><h2>{title}</h2>{#if profile}<p class="muted">{profile.domain} · {store.providerOf(profile.selection.providerId)?.name} · {profile.selection.model ?? labels.model}</p>{/if}</div>{#if store.owner}<button class="ghost small" onclick={() => { editing = true; }}>{labels.edit}</button>{/if}</div>
          <nav class="agent-detail-tabs" aria-label={title}>
            {#each (profile || group ? ['conversation', 'activity', 'memory', ...(profile ? ['missions'] : [])] : ['missions', 'activity', 'memory']) as item (item)}<button class="ghost" class:active={tab === item} aria-pressed={tab === item} onclick={() => { tab = item as typeof tab; }}>{labels[item as 'conversation']}</button>{/each}
          </nav>
          {#key `${selected.kind}:${selected.id}`}
            {#if tab === 'conversation'}<AgentConversation {view} {scope} />
            {:else if tab === 'activity'}{#each work as item (item.id)}<AgentWorkCard {view} work={item} />{:else}<p class="agent-empty">{labels.noWork}</p>{/each}
            {:else if tab === 'memory'}<AgentKnowledge {view} {scope} />
            {:else if mission}<AgentMissionView {view} {mission} />
            {:else}
              {#if team}<p>{team.description}</p>{#if team.groupId}<button class="small" onclick={() => choose({ kind: 'group', id: team!.groupId! })}>{labels.group}</button>{/if}<div class="agent-team-members">{#each team.members as member (member.agentId)}<button class="ghost agent-record" onclick={() => choose({ kind: 'profile', id: member.agentId })}>{snapshot.profiles.find(a => a.id === member.agentId)?.name}<span class="muted">{member.responsibility}</span></button>{/each}</div>{/if}
              {#each missions as item (item.id)}<button class="agent-review-link" onclick={() => choose({ kind: 'mission', id: item.id })}>{item.title}<span class="agent-state" data-status={item.status}>{labels[item.status]}</span></button>{:else}<p class="agent-empty">{labels.empty}</p>{/each}
            {/if}
          {/key}
        {:else}<div class="agent-welcome"><Bot size={40} /><h2>{labels.heading}</h2><p class="muted">{labels.select}</p>{#if store.owner}<button class="primary" onclick={() => create(section === 'attention' ? 'profile' : section)}>{labels.create}</button>{:else}<p class="muted">{labels.readOnly}</p>{/if}</div>{/if}
      </main>
    </div>
  {/if}
</section>
