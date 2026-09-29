<script lang="ts">
  import { Search } from '@lucide/svelte';
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
  const labels = $derived(strings.agents);
  let scoped = $derived(view.seen.memories.filter(m => m.scope.kind === scope.kind && m.scope.id === scope.id));
  let memories = $derived(scoped.filter(m => `${m.title} ${m.text}`.toLowerCase().includes(query.toLowerCase())));
  const key = $derived(`memory:${scope.kind}:${scope.id}`);
  const history = $derived({ kind: 'memory' as const, scopes: [scope] });
  $effect(() => { view.fill(key, history, scoped); });
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

{#snippet editor(target: 'memory' | 'resource')}
  {#if mode === target}
    <form class="agents-form agent-inline-form" onsubmit={e => { e.preventDefault(); void save(); }}>
      <label class="agent-field">{labels.name}<input required bind:value={title} /></label>
      {#if mode === 'resource'}
        <div class="agent-inline">
          <Menu placement="bottom" label={labels.resources} items={(['instructions', 'url', 'directory'] as const).map(id => ({ id, label: labels[id], active: kind === id }))} onpick={id => { kind = id as AgentResource['kind']; }}>{labels[kind]}</Menu>
          <Menu placement="bottom" label={labels.permissions} items={(['read', 'write'] as const).map(id => ({ id, label: labels[id], active: access === id }))} onpick={id => { access = id as AgentResource['access']; }}>{labels[access]}</Menu>
        </div>
        <p class="hint">{labels.resourceHint}</p>
      {/if}
      <label class="agent-field">{labels.text}<textarea required bind:value={text} rows="3"></textarea></label>
      {#if mode === 'memory'}<label class="agent-field">{labels.expiresAt}<input type="datetime-local" bind:value={expiry} /></label>{/if}
      <div class="agent-form-actions"><button class="primary" disabled={view.pending}>{labels.save}</button><button type="button" class="ghost" onclick={() => { mode = null; }}>{labels.cancel}</button></div>
    </form>
  {/if}
{/snippet}

<div class="agent-knowledge">
  {#if memories.length + resources.length > 4 || query}
    <label class="agents-search boxed"><Search size={14} strokeWidth={1.75} /><input type="search" bind:value={query} aria-label={labels.searchKnowledge} placeholder={labels.searchKnowledge} /></label>
  {/if}
  <section class="card">
    <div class="agent-card-head"><h2>{labels.memories}</h2>{#if view.store.owner && mode !== 'memory'}<button type="button" class="small" data-testid="agent-memory-add" onclick={() => edit(null, 'memory')}>{labels.addMemory}</button>{/if}</div>
    <!-- Oldest first: earlier memories load above the list. -->
    {#if view.hasOlder(key, 'memory')}<button type="button" class="ghost small agent-older" disabled={view.loadingOlder === key} onclick={() => void view.loadOlder(key, history, scoped)} data-testid="agent-memories-older">{labels.loadEarlier}</button>{/if}
    {#each memories as memory (memory.id)}
      <details class="agent-record">
        <summary>{memory.title}{#if memory.expiresAt && memory.expiresAt <= Date.now()}<span class="muted"> · {labels.expired}</span>{/if}</summary>
        <p class="agent-prewrap">{memory.text}</p>
        <p class="hint">{labels.sources}: {memory.sourceScopes.length ? memory.sourceScopes.map(s => `${s.kind}/${s.id}`).join(', ') : labels.ownerMemory}</p>
        {#if view.store.owner}<div class="agent-form-actions"><button type="button" class="small" onclick={() => edit(memory, 'memory')}>{labels.edit}</button><button type="button" class="ghost small" disabled={view.pending} onclick={() => void expire(memory)}>{labels.expireMemory}</button></div>{/if}
      </details>
    {:else}{#if mode !== 'memory'}<p class="hint">{labels.empty}</p>{/if}{/each}
    {@render editor('memory')}
  </section>
  <section class="card">
    <div class="agent-card-head"><h2>{labels.resources}</h2>{#if view.store.owner && mode !== 'resource'}<button type="button" class="small" onclick={() => edit(null, 'resource')}>{labels.addResource}</button>{/if}</div>
    {#each resources as resource (resource.id)}
      <details class="agent-record">
        <summary>{resource.name}<span class="muted"> · {labels[resource.access]}</span></summary>
        <p class="agent-prewrap">{resource.value}</p>
        {#if view.store.owner}<button type="button" class="small" onclick={() => edit(resource, 'resource')}>{labels.edit}</button>{/if}
      </details>
    {:else}{#if mode !== 'resource'}<p class="hint">{labels.empty}</p>{/if}{/each}
    {@render editor('resource')}
  </section>
</div>
