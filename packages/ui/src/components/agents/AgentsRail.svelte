<script lang="ts">
  import { ArrowLeft, Bell, Plus, Search, Settings2 } from '@lucide/svelte';
  import type { AgentEntryKind, AgentFocus, AgentsView } from '../../lib/agents.svelte';
  import { fill, strings } from '../../lib/strings';
  import { workspace } from '../../lib/workspace.svelte';
  import Menu from '../Menu.svelte';

  let { view, focus, attention, onfocus, oncreate }: {
    view: AgentsView;
    focus: AgentFocus | null;
    attention: number;
    onfocus: (focus: AgentFocus) => void;
    oncreate: (kind: AgentEntryKind) => void;
  } = $props();

  const labels = $derived(strings.agents);
  const kinds = ['profile', 'group', 'team', 'mission'] as const;
  const plural = { profile: 'profiles', group: 'groups', team: 'teams', mission: 'missions' } as const;
  let query = $state('');

  type Entry = { id: string; name: string; hint: string; status: string };
  /** One list, one section per kind. Empty kinds stay out of the way until they have entries. */
  const sections = $derived.by(() => {
    const snapshot = view.snapshot;
    if (!snapshot) return [];
    const running = new Set(snapshot.work.filter(w => w.status === 'running').map(w => w.agentId));
    const all: Record<AgentEntryKind, Entry[]> = {
      profile: snapshot.profiles.filter(a => a.status !== 'archived').map(a => ({ id: a.id, name: a.name, hint: a.domain, status: running.has(a.id) ? 'running' : a.status })),
      group: snapshot.groups.map(g => ({ id: g.id, name: g.name, hint: fill(labels.memberCount, { count: String(g.memberIds.length) }), status: g.paused ? 'paused' : 'active' })),
      team: snapshot.teams.map(t => ({ id: t.id, name: t.name, hint: t.description, status: t.paused ? 'paused' : 'active' })),
      mission: snapshot.missions.map(m => ({ id: m.id, name: m.title, hint: labels[m.status], status: m.status }))
    };
    const needle = query.trim().toLowerCase();
    return kinds
      .map(kind => ({ kind, entries: all[kind].filter(e => !needle || `${e.name} ${e.hint}`.toLowerCase().includes(needle)) }))
      .filter(section => section.entries.length);
  });
  const counts = $derived({
    running: view.snapshot?.work.filter(w => w.status === 'running').length ?? 0,
    pending: view.snapshot?.work.filter(w => w.status === 'pending').length ?? 0
  });
  const machine = $derived(workspace.machines.find(m => m.store === view.store));

  function chosen(kind: string, id?: string): boolean {
    return focus?.kind === kind && (id === undefined || ('id' in focus && focus.id === id));
  }
  function pickMachine(id: string) {
    const target = workspace.machines.find(m => m.id === id);
    if (target) void workspace.select(target.store).then(() => target.store.showAgents());
  }
</script>

<aside class="agents-rail" aria-label={labels.heading}>
  <header>
    <button type="button" class="ghost icon" aria-label={labels.back} title={labels.back} onclick={() => view.store.showChat()}><ArrowLeft size={16} strokeWidth={1.75} /></button>
    <h1>{labels.heading}</h1>
    {#if view.store.owner}
      <Menu placement="bottom" align="end" variant="ghost" label={labels.create} testid="agents-create" items={kinds.map(kind => ({ id: kind, label: labels.kinds[kind], hint: labels.kindHints[kind] }))} onpick={id => oncreate(id as AgentEntryKind)}>
        <Plus size={15} strokeWidth={1.75} />{labels.create}
      </Menu>
    {/if}
  </header>

  {#if view.snapshot && (view.snapshot.profiles.length || view.snapshot.groups.length)}
    <label class="agents-search"><Search size={14} strokeWidth={1.75} /><input type="search" bind:value={query} aria-label={labels.search} placeholder={labels.search} /></label>
  {/if}

  <div class="agents-rail-list">
    {#if attention}
      <button type="button" class="ghost agents-row attention" class:active={chosen('attention')} aria-current={chosen('attention') ? 'page' : undefined} onclick={() => onfocus({ kind: 'attention' })} data-testid="agents-attention">
        <span class="agent-avatar"><Bell size={14} strokeWidth={1.75} /></span>
        <span class="agents-row-text"><strong>{labels.attention}</strong></span>
        <span class="agent-count">{attention}</span>
      </button>
    {/if}
    {#each sections as section (section.kind)}
      <div class="agents-rail-section">
        <h2 class="section-label">{labels[plural[section.kind]]}</h2>
        {#each section.entries as entry (entry.id)}
          <button type="button" class="ghost agents-row" class:active={chosen(section.kind, entry.id)} aria-current={chosen(section.kind, entry.id) ? 'page' : undefined} onclick={() => onfocus({ kind: section.kind, id: entry.id })} data-testid="agent-entry-{entry.id}">
            <span class="agent-avatar" data-kind={section.kind}>{entry.name.slice(0, 1)}<i data-status={entry.status}></i></span>
            <span class="agents-row-text"><strong>{entry.name}</strong>{#if entry.hint}<small>{entry.hint}</small>{/if}</span>
          </button>
        {/each}
      </div>
    {:else}
      {#if query}<p class="agent-empty">{labels.empty}</p>{/if}
    {/each}
  </div>

  <footer>
    <span class="agents-summary"><i data-status={counts.running ? 'running' : view.snapshot?.limits.paused ? 'paused' : 'idle'}></i>{view.snapshot?.limits.paused ? labels.paused : counts.running || counts.pending ? fill(labels.summary, { running: String(counts.running), pending: String(counts.pending) }) : labels.idleSummary}</span>
    <div class="agents-footer-actions">
      {#if workspace.machines.length > 1}
        <Menu placement="top" variant="ghost" label={strings.machines.heading} items={workspace.machines.map(m => ({ id: m.id, label: m.label, active: m.store === view.store }))} onpick={pickMachine}>{machine?.label ?? view.store.core?.hostname ?? strings.machines.local}</Menu>
      {/if}
      {#if view.store.owner}
        <button type="button" class="ghost icon" class:active={chosen('engine')} aria-label={labels.engineSettings} title={labels.engineSettings} onclick={() => onfocus({ kind: 'engine' })} data-testid="agents-engine"><Settings2 size={15} strokeWidth={1.75} /></button>
      {/if}
    </div>
  </footer>
</aside>
