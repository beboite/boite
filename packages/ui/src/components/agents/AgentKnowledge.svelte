<script lang="ts">
  import type { AgentScope, AgentResource, AgentMemory } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  import Menu from '../Menu.svelte';
  let { view, scope }: { view: AgentsView; scope: AgentScope } = $props();
  let mode = $state<'memory' | 'resource' | null>(null);
  let title = $state(''); let text = $state('');
  let query = $state(''); let expiry = $state('');
  let original = $state.raw<AgentMemory | AgentResource | null>(null);
  let kind = $state<AgentResource['kind']>('instructions');
  let access = $state<AgentResource['access']>('read');
  let memories = $derived(view.snapshot?.memories.filter(m => m.scope.kind === scope.kind && m.scope.id === scope.id && `${m.title} ${m.text}`.toLowerCase().includes(query.toLowerCase())) ?? []);
  let resources = $derived(view.snapshot?.resources.filter(r => r.scope.kind === scope.kind && r.scope.id === scope.id && `${r.name} ${r.value}`.toLowerCase().includes(query.toLowerCase())) ?? []);
  function edit(record: AgentMemory | AgentResource | null, target: 'memory' | 'resource') {
    original = record; mode = target; expiry = ''; title = ''; text = ''; kind = 'instructions'; access = 'read';
    if (record && 'text' in record) {
      title = record.title; text = record.text;
      if (record.expiresAt) { const date = new Date(record.expiresAt); expiry = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
    } else if (record) { title = record.name; text = record.value; kind = record.kind; access = record.access; }
  }
  async function expire(memory: AgentMemory) {
    await view.call('agents.memory.save', { id: memory.id, expectedRevision: memory.revision, value: { ...memory, expiresAt: Date.now() } });
  }
  async function save() {
    const version = original ? { id: original.id, expectedRevision: original.revision } : {};
    const memory = original && 'text' in original ? original : null;
    const result = mode === 'memory'
      ? await view.call('agents.memory.save', { ...version, value: { scope, title, text, sourceScopes: memory?.sourceScopes ?? [], sourceRunId: memory?.sourceRunId ?? null, expiresAt: expiry ? new Date(expiry).getTime() : null } })
      : await view.call('agents.resource.save', { ...version, value: { scope, name: title, kind, value: text, access } });
    if (result) { mode = null; title = ''; text = ''; }
  }
</script>

<section class="agent-knowledge">
  <label class="agent-field">{strings.agents.searchKnowledge}<input type="search" bind:value={query} /></label>
  <div class="agent-section-heading"><h3>{strings.agents.memory}</h3>{#if view.store.owner}<button class="ghost small" data-testid="agent-memory-add" onclick={() => edit(null, 'memory')}>{strings.agents.addMemory}</button>{/if}</div>
  {#each memories as memory (memory.id)}<details class="agent-record"><summary>{memory.title}{#if memory.expiresAt && memory.expiresAt <= Date.now()} · {strings.agents.expired}{/if}</summary><p class="agent-prewrap">{memory.text}</p><p class="muted">{strings.agents.sources}: {memory.sourceScopes.length ? memory.sourceScopes.map(s => `${s.kind}/${s.id}`).join(', ') : strings.agents.ownerMemory}</p>{#if view.store.owner}<div class="agent-actions"><button class="small" onclick={() => edit(memory, 'memory')}>{strings.agents.edit}</button><button class="small" disabled={view.pending} onclick={() => void expire(memory)}>{strings.agents.expireMemory}</button></div>{/if}</details>{/each}
  <div class="agent-section-heading"><h3>{strings.agents.resources}</h3>{#if view.store.owner}<button class="ghost small" onclick={() => edit(null, 'resource')}>{strings.agents.addResource}</button>{/if}</div>
  {#each resources as resource (resource.id)}<details class="agent-record"><summary>{resource.name} · {strings.agents[resource.access]}</summary><p class="agent-prewrap">{resource.value}</p>{#if view.store.owner}<button class="small" onclick={() => edit(resource, 'resource')}>{strings.agents.edit}</button>{/if}</details>{/each}
  {#if mode}
    <form class="agents-form" onsubmit={e => { e.preventDefault(); void save(); }}>
      <label>{strings.agents.name}<input required bind:value={title} /></label>
      {#if mode === 'resource'}<div class="agent-actions"><Menu placement="bottom" label={strings.agents.resources} items={(['instructions', 'url', 'directory'] as const).map(id => ({ id, label: strings.agents[id] }))} onpick={id => { kind = id as AgentResource['kind']; }}>{strings.agents[kind]}</Menu><Menu placement="bottom" label={strings.agents.permissions} items={(['read', 'write'] as const).map(id => ({ id, label: strings.agents[id] }))} onpick={id => { access = id as AgentResource['access']; }}>{strings.agents[access]}</Menu></div><p class="muted">{strings.agents.resourceHint}</p>{/if}
      <label>{strings.agents.text}<textarea required bind:value={text} rows="3"></textarea></label>
      {#if mode === 'memory'}<label>{strings.agents.expiresAt}<input type="datetime-local" bind:value={expiry} /></label>{/if}
      <div class="agent-actions"><button class="primary" disabled={view.pending}>{strings.agents.save}</button><button type="button" class="ghost" onclick={() => { mode = null; }}>{strings.agents.cancel}</button></div>
    </form>
  {/if}
</section>
